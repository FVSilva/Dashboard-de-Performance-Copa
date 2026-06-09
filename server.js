const express = require('express');
const axios   = require('axios');
const cors    = require('cors');
const path    = require('path');
const fs      = require('fs');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const API_KEY  = '0vS9fN5LXMQhOrl8weUgvbLqAcFeF8YS';
const BASE_URL = 'https://api.meetime.com.br/v2';
const CACHE_FILE = path.join(__dirname, '.cache.json');
const CACHE_TTL  = 15 * 60 * 1000; // 15 min

const meetime = axios.create({ baseURL: BASE_URL, headers: { Authorization: API_KEY } });
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ─── IN-MEMORY CACHE ─────────────────────────────────────────────────────────
let cache = {}, cacheTime = {};

function saveCacheToDisk() {
  try { fs.writeFileSync(CACHE_FILE, JSON.stringify({ cache, cacheTime, savedAt: Date.now() })); }
  catch (e) { console.error('Cache save error:', e.message); }
}

function loadCacheFromDisk() {
  try {
    if (!fs.existsSync(CACHE_FILE)) return;
    const { cache: c, cacheTime: ct, savedAt } = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
    cache = c; cacheTime = ct;
    const age = Math.round((Date.now() - savedAt) / 60000);
    console.log(`Cache do disco: ${Object.keys(c).length} entradas, ${age}min atrás`);
  } catch (e) { console.error('Cache load error:', e.message); }
}

// ─── API HELPERS ─────────────────────────────────────────────────────────────

// Fetch with retry on 429 + ECONNRESET
async function apiGet(endpoint, params) {
  let retries = 5;
  while (retries > 0) {
    try { return await meetime.get(endpoint, { params }); }
    catch (e) {
      const retry = (e.response?.status === 429) || e.code === 'ECONNRESET' || e.code === 'ETIMEDOUT';
      if (retry) { await sleep((6 - retries) * 2000); retries--; }
      else throw e;
    }
  }
  throw new Error('Max retries exceeded: ' + endpoint);
}

// Fetch last N records (API is oldest-first, so we jump to the end)
async function fetchRecent(endpoint, params, maxRecords) {
  const peek = await apiGet(endpoint, { limit: 1, start: 0, ...params });
  const total = peek.data.totalItems || 0;
  if (!total) return [];

  const results = [];
  let start = Math.max(0, total - maxRecords);
  const limit = 100;

  while (results.length < maxRecords) {
    const resp = await apiGet(endpoint, { limit, start, ...params });
    const page = resp.data.data || [];
    if (!page.length) break;
    results.push(...page);
    if (!resp.data.next || results.length >= maxRecords) break;
    start += limit;
    await sleep(250);
  }
  return results.slice(0, maxRecords);
}

function getDate(r) { return r.date || r.created_date || r.execution_date || r.available_from || r.updated; }

// ─── SDR DATA REFRESH — CARREGAMENTO PROGRESSIVO ─────────────────────────────
// Fase 1 (~1-2 min): 30 dias → dashboard disponível imediatamente
// Fase 2 (~3-4 min): 3 meses → histórico enriquecido em background
// Fase 3 (~6-8 min): 6 meses → histórico completo em background
const PHASES = [
  { label: '30d', calls: 3000,  prosp: 2000, acts: 2000,  months: [1] },
  { label: '3m',  calls: 9000,  prosp: 5000, acts: 6000,  months: [3] },
  { label: '6m',  calls: 18000, prosp: 9000, acts: 12000, months: [6] },
];

let refreshing = false;

async function refreshAllSDRs(label = 'refresh') {
  if (refreshing) { console.log(`${label}: já em andamento`); return; }
  refreshing = true;
  const t0 = Date.now();
  try {
    console.log(`[${label}] iniciando...`);
    const { data: ud } = await meetime.get('/users');
    const allUsers = ud.data.filter(u => u.email && u.email.includes('v4company'));
    const sdrs = allUsers.filter(u => u.role === 'SALESMAN' && u.active).slice(0, 20);
    cache['users'] = allUsers; cacheTime['users'] = Date.now();
    const inboundSDRs = sdrs.filter(s => s.team_name?.toUpperCase().includes('INBOUND'));

    for (const phase of PHASES) {
      const phaseT = Date.now();
      console.log(`[${label}] fase ${phase.label}...`);

      // Processa 2 SDRs em paralelo, cada um busca calls+prosp+acts simultaneamente
      for (let i = 0; i < sdrs.length; i += 2) {
        const batch = sdrs.slice(i, i + 2);
        await Promise.all(batch.map(async sdr => {
          const name = sdr.name || sdr.email;
          await Promise.all([
            // Calls, prosp e atividades em paralelo por SDR
            (cache[`calls_${sdr.id}`]?.length||0) < phase.calls
              ? fetchRecent('/calls', { user_id: sdr.id }, phase.calls)
                  .then(d => { cache[`calls_${sdr.id}`] = d; cacheTime[`calls_${sdr.id}`] = Date.now(); })
                  .catch(e => console.error(`[${phase.label}] calls ${name}:`, e.message))
              : Promise.resolve(),
            (cache[`prosp_${sdr.id}`]?.length||0) < phase.prosp
              ? fetchRecent('/prospections', { user_id: sdr.id }, phase.prosp)
                  .then(d => { cache[`prosp_${sdr.id}`] = d; cacheTime[`prosp_${sdr.id}`] = Date.now(); })
                  .catch(e => console.error(`[${phase.label}] prosp ${name}:`, e.message))
              : Promise.resolve(),
            (cache[`acts_${sdr.id}`]?.length||0) < phase.acts
              ? fetchRecent('/prospections/activities', { assigned_to_id: sdr.id }, phase.acts)
                  .then(d => { cache[`acts_${sdr.id}`] = d; cacheTime[`acts_${sdr.id}`] = Date.now(); })
                  .catch(e => console.error(`[${phase.label}] acts ${name}:`, e.message))
              : Promise.resolve(),
          ]);
        }));
        await sleep(500); // pausa entre lotes para não sobrecarregar a API
      }

      // Pré-computa e publica resultados desta fase imediatamente
      const now = new Date();
      for (const months of phase.months) {
        const cutoff = new Date(now); cutoff.setMonth(cutoff.getMonth() - months);
        cache[`dashboard_result_${months}`] = buildDashboardResult(sdrs, cutoff, months);
        cacheTime[`dashboard_result_${months}`] = Date.now();
        cache[`inbound_result_${months}`] = buildInboundResult(inboundSDRs, cutoff, months);
        cacheTime[`inbound_result_${months}`] = Date.now();
      }
      saveCacheToDisk();
      console.log(`[${label}] fase ${phase.label} em ${((Date.now()-phaseT)/60000).toFixed(1)}min — publicado`);
    }

    console.log(`[${label}] completo em ${((Date.now()-t0)/60000).toFixed(1)}min`);
  } catch (e) { console.error(`[${label}] erro:`, e.message); }
  finally { refreshing = false; }
}

// ─── METRICS BUILDERS ────────────────────────────────────────────────────────
function buildSDRMetricsFromData(sdr, calls, prosp, acts) {
  const id = sdr.id, name = sdr.name || sdr.email;
  const conn  = calls.filter(c => c.status === 'CONNECTED');
  const mean  = calls.filter(c => c.output === 'MEANINGFUL');
  const short = conn.filter(c => (c.connected_duration_seconds||0) <= 10);
  const dur   = conn.reduce((s,c) => s+(c.connected_duration_seconds||0), 0);
  const won   = prosp.filter(p => p.status === 'WON');
  const lost  = prosp.filter(p => p.status === 'LOST');
  const active= prosp.filter(p => p.status === 'EXECUTING' || p.status === 'WAITING');
  const emails= acts.filter(a => a.type === 'E_MAIL');
  const done  = acts.filter(a => a.status === 'FINISHED');
  return {
    id, name, team: sdr.team_name,
    calls: {
      total: calls.length, connected: conn.length, meaningful: mean.length, shortAbandons: short.length,
      connectionRate:   calls.length ? +((conn.length/calls.length)*100).toFixed(1) : 0,
      meaningfulRate:   conn.length  ? +((mean.length/conn.length)*100).toFixed(1)  : 0,
      shortAbandonRate: conn.length  ? +((short.length/conn.length)*100).toFixed(1) : 0,
      avgDuration: conn.length ? Math.round(dur/conn.length) : 0, totalDuration: dur
    },
    prospections: {
      total: prosp.length, converted: won.length, lost: lost.length, active: active.length,
      won: won.length, wonRate: prosp.length ? +((won.length/prosp.length)*100).toFixed(1) : 0,
      lostRate: prosp.length ? +((lost.length/prosp.length)*100).toFixed(1) : 0,
      conversionRate: prosp.length ? +((won.length/prosp.length)*100).toFixed(1) : 0
    },
    activities: {
      total: acts.length, done: done.length, emails: emails.length,
      emailsDone: emails.filter(a=>a.status==='FINISHED').length,
      emailsPending: emails.filter(a=>a.status!=='FINISHED').length,
      callsDone: acts.filter(a=>a.type==='CALL'&&a.status==='FINISHED').length,
      callsPending: acts.filter(a=>a.type==='CALL'&&a.status!=='FINISHED').length,
      whatsappDone: acts.filter(a=>a.type==='SOCIAL_POINT'&&a.status==='FINISHED').length,
      whatsappPending: acts.filter(a=>a.type==='SOCIAL_POINT'&&a.status!=='FINISHED').length,
      social: acts.filter(a=>a.type==='SOCIAL_POINT').length,
      searches: acts.filter(a=>a.type==='SEARCH').length,
      completionRate: acts.length ? +((done.length/acts.length)*100).toFixed(1) : 0
    }
  };
}

function buildSDRMetrics(sdr, cutoff) {
  const id = sdr.id, name = sdr.name || sdr.email;
  const calls = (cache[`calls_${id}`] || []).filter(c => new Date(getDate(c)) >= cutoff);
  const prosp  = (cache[`prosp_${id}`] || []).filter(p => new Date(getDate(p)) >= cutoff);
  const acts   = (cache[`acts_${id}`]  || []).filter(a => new Date(getDate(a)) >= cutoff);

  const conn  = calls.filter(c => c.status === 'CONNECTED');
  const mean  = calls.filter(c => c.output === 'MEANINGFUL');
  const short = conn.filter(c => (c.connected_duration_seconds||0) <= 10);
  const dur   = conn.reduce((s,c) => s+(c.connected_duration_seconds||0), 0);
  const won   = prosp.filter(p => p.status === 'WON');
  const lost  = prosp.filter(p => p.status === 'LOST');
  const active= prosp.filter(p => p.status === 'EXECUTING' || p.status === 'WAITING');
  const emails= acts.filter(a => a.type === 'E_MAIL');
  const done  = acts.filter(a => a.status === 'FINISHED');

  return {
    id, name, team: sdr.team_name,
    calls: {
      total: calls.length, connected: conn.length, meaningful: mean.length,
      shortAbandons: short.length,
      connectionRate:   calls.length ? +((conn.length/calls.length)*100).toFixed(1) : 0,
      meaningfulRate:   conn.length  ? +((mean.length/conn.length)*100).toFixed(1)  : 0,
      shortAbandonRate: conn.length  ? +((short.length/conn.length)*100).toFixed(1) : 0,
      avgDuration: conn.length ? Math.round(dur/conn.length) : 0, totalDuration: dur
    },
    prospections: {
      total: prosp.length, converted: won.length, lost: lost.length, active: active.length,
      won: won.length, wonRate: prosp.length ? +((won.length/prosp.length)*100).toFixed(1) : 0,
      lostRate: prosp.length ? +((lost.length/prosp.length)*100).toFixed(1) : 0,
      conversionRate: prosp.length ? +((won.length/prosp.length)*100).toFixed(1) : 0
    },
    activities: {
      total: acts.length, done: done.length,
      emails: emails.length,
      emailsDone: emails.filter(a=>a.status==='FINISHED').length,
      emailsPending: emails.filter(a=>a.status!=='FINISHED').length,
      callsDone: acts.filter(a=>a.type==='CALL'&&a.status==='FINISHED').length,
      callsPending: acts.filter(a=>a.type==='CALL'&&a.status!=='FINISHED').length,
      whatsappDone: acts.filter(a=>a.type==='SOCIAL_POINT'&&a.status==='FINISHED').length,
      whatsappPending: acts.filter(a=>a.type==='SOCIAL_POINT'&&a.status!=='FINISHED').length,
      social: acts.filter(a=>a.type==='SOCIAL_POINT').length,
      searches: acts.filter(a=>a.type==='SEARCH').length,
      completionRate: acts.length ? +((done.length/acts.length)*100).toFixed(1) : 0
    }
  };
}

function buildMonthlyTrends(calls, prosp, acts, numMonths) {
  const months = {};
  const now = new Date();
  for (let i = numMonths-1; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth()-i, 1);
    const key = `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}`;
    months[key] = { month:key, calls:0, connected:0, meaningful:0, conversions:0, prospections:0, emails:0, social:0 };
  }
  for (const c of calls) {
    const d = new Date(c.date); const key = `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}`;
    if (months[key]) { months[key].calls++; if(c.status==='CONNECTED') months[key].connected++; if(c.output==='MEANINGFUL') months[key].meaningful++; }
  }
  for (const p of prosp) {
    const d = new Date(p.created_date); const key = `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}`;
    if (months[key]) { months[key].prospections++; if(p.status==='WON') months[key].conversions++; }
  }
  for (const a of acts) {
    const dt = a.execution_date||a.available_from||a.updated; if(!dt) continue;
    const d = new Date(dt); const key = `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}`;
    if (months[key] && a.status==='FINISHED') { if(a.type==='E_MAIL') months[key].emails++; if(a.type==='SOCIAL_POINT') months[key].social++; }
  }
  return Object.values(months);
}

function buildDashboardResult(sdrs, cutoff, months, dateTo = null) {
  const inRange = (r) => {
    const d = new Date(getDate(r));
    return d >= cutoff && (!dateTo || d <= dateTo);
  };
  const allCalls=[],allProsp=[],allActs=[];
  const sdrMetrics = {};
  for (const sdr of sdrs) {
    const id = sdr.id;
    const calls = (cache[`calls_${id}`]||[]).filter(inRange);
    const prosp  = (cache[`prosp_${id}`]||[]).filter(inRange);
    const acts   = (cache[`acts_${id}`]||[]).filter(inRange);
    // Passa os dados já filtrados para buildSDRMetrics via cache temporário
    const tmpKey = `_tmp_${id}`;
    cache[tmpKey+'_c'] = calls; cache[tmpKey+'_p'] = prosp; cache[tmpKey+'_a'] = acts;
    sdrMetrics[id] = buildSDRMetricsFromData(sdr, calls, prosp, acts);
    delete cache[tmpKey+'_c']; delete cache[tmpKey+'_p']; delete cache[tmpKey+'_a'];
    allCalls.push(...calls.map(c=>({...c,sdr_id:id})));
    allProsp.push(...prosp.map(p=>({...p,sdr_id:id})));
    allActs.push(...acts.map(a=>({...a,sdr_id:id})));
  }
  return { sdrs: Object.values(sdrMetrics), trends: buildMonthlyTrends(allCalls,allProsp,allActs,months), totalSDRs: sdrs.length };
}

function buildInboundResult(inboundSDRs, cutoff, months, dateTo = null) {
  const inRange = (r) => { const d = new Date(getDate(r)); return d >= cutoff && (!dateTo || d <= dateTo); };
  const allCalls=[],allProsp=[],allActs=[];
  const sdrMetrics = {};
  for (const sdr of inboundSDRs) {
    const calls = (cache[`calls_${sdr.id}`]||[]).filter(inRange);
    const prosp  = (cache[`prosp_${sdr.id}`]||[]).filter(inRange);
    const acts   = (cache[`acts_${sdr.id}`]||[]).filter(inRange);
    sdrMetrics[sdr.id] = buildSDRMetricsFromData(sdr, calls, prosp, acts);
    allCalls.push(...calls); allProsp.push(...prosp); allActs.push(...acts);
  }
  return { sdrs: Object.values(sdrMetrics), trends: buildMonthlyTrends(allCalls,allProsp,allActs,months), teams:[...new Set(inboundSDRs.map(s=>s.team_name).filter(Boolean))] };
}

// ─── ROUTES ──────────────────────────────────────────────────────────────────

app.get('/api/users', async (req, res) => {
  try {
    if (!cache['users']) { const {data} = await meetime.get('/users'); cache['users'] = data.data.filter(u=>u.email&&u.email.includes('v4company')); cacheTime['users']=Date.now(); }
    res.json(cache['users']);
  } catch(e) { res.status(500).json({error:e.message}); }
});

app.get('/api/calls', async (req, res) => {
  try {
    const { user_id, months=3 } = req.query;
    const cutoff = new Date(); cutoff.setMonth(cutoff.getMonth()-parseInt(months));
    let calls = [];
    if (user_id) {
      calls = cache[`calls_${user_id}`] || [];
    } else {
      // Agrega calls de todos os SDRs
      const usersData = cache['users'] || [];
      const sdrs = usersData.filter(u => u.role==='SALESMAN' && u.active);
      for (const s of sdrs) calls.push(...(cache[`calls_${s.id}`]||[]).map(c=>({...c,user_id:s.id})));
    }
    res.json(calls.filter(c => new Date(c.date||0) >= cutoff));
  } catch(e) { res.status(500).json({error:e.message}); }
});

app.get('/api/dashboard', async (req, res) => {
  try {
    const { months=3, date_from, date_to } = req.query;
    const usersData = cache['users'] || [];
    const sdrs = usersData.filter(u => u.role==='SALESMAN' && u.active);
    if (!sdrs.length) { res.json({sdrs:[],trends:[],totalSDRs:0}); return; }

    // Período customizado (ex: "hoje", "últimos 7 dias") — calcula do dado bruto em cache
    if (date_from && date_to) {
      const from = new Date(date_from + 'T00:00:00');
      const to   = new Date(date_to   + 'T23:59:59');
      const diffDays = Math.ceil((to - from) / 86400000) + 1;
      const result = buildDashboardResult(sdrs, from, Math.max(1, diffDays), to);
      return res.json(result);
    }

    // Períodos padrão (1m, 3m, 6m) — usa cache pré-computado
    const resultKey = `dashboard_result_${months}`;
    if (cache[resultKey]) {
      res.json(cache[resultKey]);
      if (Date.now() - (cacheTime[resultKey]||0) > CACHE_TTL && !refreshing)
        refreshAllSDRs('background').catch(console.error);
      return;
    }
    const cutoff = new Date(); cutoff.setMonth(cutoff.getMonth()-parseInt(months));
    const result = buildDashboardResult(sdrs, cutoff, parseInt(months));
    cache[resultKey] = result; cacheTime[resultKey] = Date.now();
    res.json(result);
  } catch(e) { console.error(e); res.status(500).json({error:e.message}); }
});

app.get('/api/inbound', async (req, res) => {
  try {
    const { months=3, date_from, date_to } = req.query;
    const usersData = cache['users'] || [];
    const inboundSDRs = usersData.filter(u => u.role==='SALESMAN' && u.active && u.team_name?.toUpperCase().includes('INBOUND'));
    if (!inboundSDRs.length) { res.json({sdrs:[],trends:[],teams:[]}); return; }

    if (date_from && date_to) {
      const from = new Date(date_from + 'T00:00:00');
      const to   = new Date(date_to   + 'T23:59:59');
      const diffDays = Math.ceil((to - from) / 86400000) + 1;
      return res.json(buildInboundResult(inboundSDRs, from, Math.max(1, diffDays), to));
    }

    const resultKey = `inbound_result_${months}`;
    if (cache[resultKey]) {
      res.json(cache[resultKey]);
      if (Date.now() - (cacheTime[resultKey]||0) > CACHE_TTL && !refreshing)
        refreshAllSDRs('background').catch(console.error);
      return;
    }
    const cutoff = new Date(); cutoff.setMonth(cutoff.getMonth()-parseInt(months));
    const result = buildInboundResult(inboundSDRs, cutoff, parseInt(months));
    cache[resultKey] = result; cacheTime[resultKey] = Date.now();
    res.json(result);
  } catch(e) { res.status(500).json({error:e.message}); }
});

app.get('/api/cadences', async (req, res) => {
  try {
    if (!cache['cadences']) { const {data} = await meetime.get('/cadences'); cache['cadences']=data.data; cacheTime['cadences']=Date.now(); }
    res.json(cache['cadences']);
  } catch(e) { res.status(500).json({error:e.message}); }
});

app.get('/api/cache-status', (req, res) => {
  const usersData = cache['users'] || [];
  const sdrs = usersData.filter(u => u.role==='SALESMAN' && u.active);
  const status = sdrs.map(s => ({
    id: s.id, name: s.name||s.email,
    calls: !!(cache[`calls_${s.id}`]?.length),
    prosp: cache[`prosp_${s.id}`] !== undefined,
    acts:  !!(cache[`acts_${s.id}`]?.length)
  }));
  res.json({ ready: status.filter(s=>s.calls&&s.prosp&&s.acts).length, total: status.length, sdrs: status, refreshing });
});

// Endpoint de ping — mantém o Render acordado
app.get('/ping', (req, res) => res.send('ok'));

// ─── STARTUP ─────────────────────────────────────────────────────────────────
loadCacheFromDisk();

const PORT = process.env.PORT || 4000;
app.listen(PORT, () => {
  console.log(`Dashboard rodando em http://localhost:${PORT}`);
  setTimeout(() => refreshAllSDRs('startup'), 1000);
  setInterval(() => refreshAllSDRs('auto-refresh'), CACHE_TTL);

  // Auto-ping a cada 9 minutos para o Render não dormir (dorme após 15 min sem requests)
  const selfUrl = process.env.RENDER_EXTERNAL_URL;
  if (selfUrl) {
    console.log(`Keep-alive ativado: pingando ${selfUrl}/ping a cada 9min`);
    setInterval(() => {
      require('https').get(`${selfUrl}/ping`, r => {
        console.log(`Keep-alive ping: ${r.statusCode}`);
      }).on('error', e => console.error('Keep-alive erro:', e.message));
    }, 9 * 60 * 1000);
  }
});
