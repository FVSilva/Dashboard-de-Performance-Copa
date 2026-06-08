const express = require('express');
const axios = require('axios');
const cors = require('cors');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const API_KEY = '0vS9fN5LXMQhOrl8weUgvbLqAcFeF8YS';
const BASE_URL = 'https://api.meetime.com.br/v2';

const meetime = axios.create({
  baseURL: BASE_URL,
  headers: { Authorization: API_KEY }
});

const sleep = ms => new Promise(r => setTimeout(r, ms));

// Fetch pages from a paginated endpoint with rate-limit handling
async function fetchAll(endpoint, extraParams = {}, maxRecords = 1000) {
  const results = [];
  let start = 0;
  const limit = 100;
  while (true) {
    let retries = 3;
    let resp;
    while (retries > 0) {
      try {
        resp = await meetime.get(endpoint, { params: { limit, start, ...extraParams } });
        break;
      } catch (e) {
        if (e.response && e.response.status === 429) {
          await sleep(2000);
          retries--;
        } else throw e;
      }
    }
    if (!resp) break;
    const data = resp.data;
    results.push(...(data.data || []));
    if (!data.next || results.length >= data.totalItems || results.length >= maxRecords) break;
    start += limit;
    await sleep(150);
  }
  return results;
}

// Retorna o campo de data do registro dependendo do endpoint
function getRecordDate(record) {
  return record.date || record.created_date || record.execution_date || record.available_from || record.updated;
}

// fetchSince: busca TODOS os registros desde cutoffDate
// API retorna oldest-first — varremos do fim para o início até atingir a data de corte
async function fetchSince(endpoint, extraParams = {}, cutoffDate) {
  let peek;
  try {
    peek = await meetime.get(endpoint, { params: { limit: 1, start: 0, ...extraParams } });
  } catch (e) { return []; }

  const total = peek.data.totalItems || 0;
  if (!total) return [];

  const limit = 100;
  const results = [];
  let start = Math.max(0, total - limit);

  while (true) {
    let retries = 5, resp;
    while (retries > 0) {
      try {
        resp = await meetime.get(endpoint, { params: { limit, start, ...extraParams } });
        break;
      } catch (e) {
        if (e.response && e.response.status === 429) {
          const waitMs = (6 - retries) * 3000;
          console.log(`429 em ${endpoint} — aguardando ${waitMs}ms`);
          await sleep(waitMs);
          retries--;
        } else throw e;
      }
    }
    if (!resp) break;

    const page = resp.data.data || [];
    if (!page.length) break;

    // Filtra só registros dentro do período
    const inPeriod = page.filter(r => new Date(getRecordDate(r)) >= cutoffDate);
    results.unshift(...inPeriod); // mantém ordem cronológica

    // Se toda a página é mais antiga que o cutoff, podemos parar
    const allOld = page.every(r => new Date(getRecordDate(r)) < cutoffDate);
    if (allOld || start === 0) break;

    start = Math.max(0, start - limit);
    await sleep(300);
  }

  return results;
}

// fetchRecent: mantido para compatibilidade (pre-warm usa limite menor para atividades)
async function fetchRecent(endpoint, extraParams = {}, maxRecords = 500) {
  let peek;
  try {
    peek = await meetime.get(endpoint, { params: { limit: 1, start: 0, ...extraParams } });
  } catch (e) { return []; }
  const total = peek.data.totalItems || 0;
  if (!total) return [];
  const startOffset = Math.max(0, total - maxRecords);
  return fetchAllFrom(endpoint, extraParams, startOffset, maxRecords);
}

async function fetchAllFrom(endpoint, extraParams = {}, startOffset = 0, maxRecords = 500) {
  const results = [];
  let start = startOffset;
  const limit = 100;
  while (results.length < maxRecords) {
    let retries = 5, resp;
    while (retries > 0) {
      try {
        resp = await meetime.get(endpoint, { params: { limit, start, ...extraParams } });
        break;
      } catch (e) {
        if (e.response && e.response.status === 429) {
          const waitMs = (6 - retries) * 3000;
          await sleep(waitMs);
          retries--;
        } else throw e;
      }
    }
    if (!resp) break;
    const data = resp.data;
    const page = data.data || [];
    if (!page.length) break;
    results.push(...page);
    if (!data.next || results.length >= maxRecords) break;
    start += limit;
    await sleep(300);
  }
  return results.slice(0, maxRecords);
}

// Cache in memory (refresh every 15min)
let cache = {};
let cacheTime = {};
const CACHE_TTL = 15 * 60 * 1000;

const CACHE_FILE = path.join(__dirname, '.cache.json');

function saveCacheToDisk() {
  try {
    const snapshot = { cache, cacheTime, savedAt: Date.now() };
    require('fs').writeFileSync(CACHE_FILE, JSON.stringify(snapshot));
  } catch (e) { console.error('Cache save error:', e.message); }
}

function loadCacheFromDisk() {
  try {
    if (!require('fs').existsSync(CACHE_FILE)) return;
    const { cache: c, cacheTime: ct, savedAt } = JSON.parse(require('fs').readFileSync(CACHE_FILE, 'utf8'));
    // Sempre carrega do disco (mesmo expirado) para servir dados imediatamente
    // O auto-refresh em background vai atualizar com dados frescos
    cache = c;
    cacheTime = ct;
    const ageMin = ((Date.now() - savedAt) / 60000).toFixed(0);
    const fresh = Date.now() - savedAt < CACHE_TTL;
    console.log(`Cache do disco: ${Object.keys(c).length} entradas, ${ageMin}min atrás ${fresh ? '✓ fresco' : '(desatualizado — refresh em andamento)'}`);
  } catch (e) { console.error('Cache load error:', e.message); }
}

async function cached(key, fn) {
  const now = Date.now();
  if (cache[key] && now - cacheTime[key] < CACHE_TTL) return cache[key];
  cache[key] = await fn();
  cacheTime[key] = now;
  saveCacheToDisk();   // persist cache to disk after every update
  return cache[key];
}

// GET /api/users - @v4company.com users only
app.get('/api/users', async (req, res) => {
  try {
    const users = await cached('users', async () => {
      const { data } = await meetime.get('/users');
      return data.data.filter(u =>
        u.email && (u.email.includes('v4company') || u.email.match(/v4company@copaenergia/))
      );
    });
    res.json(users);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/calls?user_id=X&months=6
app.get('/api/calls', async (req, res) => {
  try {
    const { user_id, months = 6 } = req.query;
    const cacheKey = `calls_${user_id || 'all'}_${months}`;
    const calls = await cached(cacheKey, async () => {
      const params = {};
      if (user_id) params.user_id = user_id;
      return await fetchAll('/calls', params);
    });

    // Filter by months
    const cutoff = new Date();
    cutoff.setMonth(cutoff.getMonth() - parseInt(months));
    const filtered = calls.filter(c => new Date(c.date) >= cutoff);
    res.json(filtered);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/prospections?user_id=X&months=6
app.get('/api/prospections', async (req, res) => {
  try {
    const { user_id, months = 6 } = req.query;
    const cacheKey = `prosp_${user_id || 'all'}_${months}`;
    const items = await cached(cacheKey, async () => {
      const params = {};
      if (user_id) params.user_id = user_id;
      return await fetchAll('/prospections', params);
    });

    const cutoff = new Date();
    cutoff.setMonth(cutoff.getMonth() - parseInt(months));
    const filtered = items.filter(p => new Date(p.created_date) >= cutoff);
    res.json(filtered);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/activities?user_id=X&months=6
app.get('/api/activities', async (req, res) => {
  try {
    const { user_id, months = 6 } = req.query;
    const cacheKey = `acts_${user_id || 'all'}_${months}`;
    const items = await cached(cacheKey, async () => {
      const params = {};
      if (user_id) params.assigned_to_id = user_id;
      return await fetchAll('/prospections/activities', params, 500);
    });
    const cutoff = new Date();
    cutoff.setMonth(cutoff.getMonth() - parseInt(months));
    res.json(items.filter(a => new Date(a.execution_date || a.available_from || a.updated) >= cutoff));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/cadences
app.get('/api/cadences', async (req, res) => {
  try {
    const data = await cached('cadences', async () => {
      const { data } = await meetime.get('/cadences');
      return data.data;
    });
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/dashboard - aggregated metrics for all v4company SDRs
app.get('/api/dashboard', async (req, res) => {
  try {
    const { months = 3 } = req.query;
    // Serve computed result from cache if fresh
    const resultKey = `dashboard_result_${months}`;
    if (cache[resultKey] && Date.now() - cacheTime[resultKey] < CACHE_TTL) {
      return res.json(cache[resultKey]);
    }
    const cutoff = new Date();
    cutoff.setMonth(cutoff.getMonth() - parseInt(months));

    // Get v4company users
    const usersRes = await cached('users', async () => {
      const { data } = await meetime.get('/users');
      return data.data.filter(u => u.email && u.email.includes('v4company'));
    });

    const sdrs = usersRes.filter(u => u.role === 'SALESMAN' && u.active);
    const sdrIds = sdrs.map(u => u.id);

    // Fetch calls for all SDRs in parallel (batched)
    const allCalls = [];
    const allProspections = [];

    const allActivities = [];

    // Cutoff de 6 meses para o cache — filtra pelo período pedido depois
    const cutoff6m = new Date(); cutoff6m.setMonth(cutoff6m.getMonth() - 6);

    for (const sdr of sdrs.slice(0, 20)) {
      const name = sdr.name || sdr.email;
      try {
        const calls = await cached(`calls_${sdr.id}`, () => fetchSince('/calls', { user_id: sdr.id }, cutoff6m));
        allCalls.push(...calls.map(c => ({ ...c, sdr_id: sdr.id, sdr_name: name })));
      } catch (e) { console.error(`calls FAILED ${name}:`, e.message); }
      try {
        const prosp = await cached(`prosp_${sdr.id}`, () => fetchSince('/prospections', { user_id: sdr.id }, cutoff6m));
        allProspections.push(...prosp.map(p => ({ ...p, sdr_id: sdr.id, sdr_name: name })));
      } catch (e) { console.error(`prosp FAILED ${name}:`, e.message); }
      try {
        const acts = await cached(`acts_${sdr.id}`, () => fetchSince('/prospections/activities', { assigned_to_id: sdr.id }, cutoff6m));
        allActivities.push(...acts.map(a => ({ ...a, sdr_id: sdr.id, sdr_name: name })));
      } catch (e) { console.error(`acts FAILED ${name}:`, e.message); }
      await sleep(500);
    }

    const filteredCalls = allCalls.filter(c => new Date(c.date) >= cutoff);
    const filteredProsp = allProspections.filter(p => new Date(p.created_date) >= cutoff);
    const actDateField = a => a.execution_date || a.available_from || a.updated;
    const filteredActs = allActivities.filter(a => new Date(actDateField(a)) >= cutoff);

    // Build per-SDR metrics
    const sdrMetrics = {};
    for (const sdr of sdrs.slice(0, 20)) {
      const id = sdr.id;
      const name = sdr.name || sdr.email;
      const calls = filteredCalls.filter(c => c.sdr_id === id);
      const prosp = filteredProsp.filter(p => p.sdr_id === id);
      const acts = filteredActs.filter(a => a.sdr_id === id);

      const connected = calls.filter(c => c.status === 'CONNECTED');
      const meaningful = calls.filter(c => c.output === 'MEANINGFUL');
      const totalDuration = connected.reduce((s, c) => s + (c.connected_duration_seconds || 0), 0);

      const converted = prosp.filter(p => p.status === 'WON');
      const lost = prosp.filter(p => p.status === 'LOST');
      const active = prosp.filter(p => p.status === 'EXECUTING' || p.status === 'WAITING');

      const emails = acts.filter(a => a.type === 'E_MAIL');
      const emailsDone = emails.filter(a => a.status === 'FINISHED');
      const socialActs = acts.filter(a => a.type === 'SOCIAL_POINT');
      const searches = acts.filter(a => a.type === 'SEARCH');
      const totalActs = acts.filter(a => a.status === 'FINISHED');

      sdrMetrics[id] = {
        id, name,
        team: sdr.team_name,
        calls: {
          total: calls.length,
          connected: connected.length,
          meaningful: meaningful.length,
          connectionRate: calls.length ? ((connected.length / calls.length) * 100).toFixed(1) : 0,
          meaningfulRate: connected.length ? ((meaningful.length / connected.length) * 100).toFixed(1) : 0,
          avgDuration: connected.length ? Math.round(totalDuration / connected.length) : 0,
          totalDuration
        },
        prospections: {
          total: prosp.length,
          converted: converted.length,
          lost: lost.length,
          active: active.length,
          conversionRate: prosp.length ? ((converted.length / prosp.length) * 100).toFixed(1) : 0
        },
        activities: {
          total: acts.length,
          done: totalActs.length,
          emails: emails.length,
          emailsDone: emailsDone.length,
          social: socialActs.length,
          searches: searches.length,
          completionRate: acts.length ? ((totalActs.length / acts.length) * 100).toFixed(1) : 0
        }
      };
    }

    const trends = buildMonthlyTrends(filteredCalls, filteredProsp, filteredActs, parseInt(months));
    const result = { sdrs: Object.values(sdrMetrics), trends, totalSDRs: sdrs.length };
    cache[resultKey] = result; cacheTime[resultKey] = Date.now();
    res.json(result);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

// GET /api/inbound — métricas para SDRs com team_name contendo "INBOUND"
app.get('/api/inbound', async (req, res) => {
  try {
    const { months = 3 } = req.query;
    const inboundKey = `inbound_result_${months}`;
    if (cache[inboundKey] && Date.now() - cacheTime[inboundKey] < CACHE_TTL) {
      return res.json(cache[inboundKey]);
    }
    const cutoff = new Date();
    cutoff.setMonth(cutoff.getMonth() - parseInt(months));

    const usersRes = await cached('users', async () => {
      const { data } = await meetime.get('/users');
      return data.data.filter(u => u.email && u.email.includes('v4company'));
    });

    const inboundSDRs = usersRes.filter(u =>
      u.role === 'SALESMAN' && u.active &&
      u.team_name && u.team_name.toUpperCase().includes('INBOUND')
    );

    const allCalls = [], allProsp = [], allActs = [];

    const cutoff6m_i = new Date(); cutoff6m_i.setMonth(cutoff6m_i.getMonth() - 6);

    for (const sdr of inboundSDRs) {
      const name = sdr.name || sdr.email;
      try {
        const calls = await cached(`calls_${sdr.id}`, () => fetchSince('/calls', { user_id: sdr.id }, cutoff6m_i));
        allCalls.push(...calls.map(c => ({ ...c, _sdr_id: sdr.id, _sdr_name: name, _team: sdr.team_name })));
      } catch (e) { console.error(`inbound calls ${name}:`, e.message); }
      try {
        const prosp = await cached(`prosp_${sdr.id}`, () => fetchSince('/prospections', { user_id: sdr.id }, cutoff6m_i));
        allProsp.push(...prosp.map(p => ({ ...p, _sdr_id: sdr.id, _sdr_name: name, _team: sdr.team_name })));
      } catch (e) { console.error(`inbound prosp ${name}:`, e.message); }
      try {
        const acts = await cached(`acts_${sdr.id}`, () => fetchSince('/prospections/activities', { assigned_to_id: sdr.id }, cutoff6m_i));
        allActs.push(...acts.map(a => ({ ...a, _sdr_id: sdr.id, _sdr_name: name, _team: sdr.team_name })));
      } catch (e) { console.error(`inbound acts ${name}:`, e.message); }
      await sleep(500);
    }

    const fCalls = allCalls.filter(c => new Date(c.date) >= cutoff);
    const fProsp  = allProsp.filter(p => new Date(p.created_date) >= cutoff);
    const actDate = a => a.execution_date || a.available_from || a.updated;
    const fActs   = allActs.filter(a => new Date(actDate(a)) >= cutoff);

    const sdrMetrics = {};
    for (const sdr of inboundSDRs) {
      const id   = sdr.id;
      const calls = fCalls.filter(c => c._sdr_id === id);
      const prosp = fProsp.filter(p => p._sdr_id === id);
      const acts  = fActs.filter(a => a._sdr_id === id);

      const connected  = calls.filter(c => c.status === 'CONNECTED');
      const meaningful = calls.filter(c => c.output === 'MEANINGFUL');
      // Encerradas em até 10s = conectadas com duração <= 10s
      const shortCalls = connected.filter(c => (c.connected_duration_seconds || 0) <= 10);
      const totalDur   = connected.reduce((s, c) => s + (c.connected_duration_seconds || 0), 0);

      const won    = prosp.filter(p => p.status === 'WON');
      const lost   = prosp.filter(p => p.status === 'LOST');
      const active = prosp.filter(p => p.status === 'EXECUTING' || p.status === 'WAITING');

      const emailsDone    = acts.filter(a => a.type === 'E_MAIL'       && a.status === 'FINISHED');
      const emailsPending = acts.filter(a => a.type === 'E_MAIL'       && a.status !== 'FINISHED');
      const callsDone     = acts.filter(a => a.type === 'CALL'         && a.status === 'FINISHED');
      const callsPending  = acts.filter(a => a.type === 'CALL'         && a.status !== 'FINISHED');
      const waDone        = acts.filter(a => a.type === 'SOCIAL_POINT' && a.status === 'FINISHED');
      const waPending     = acts.filter(a => a.type === 'SOCIAL_POINT' && a.status !== 'FINISHED');
      const totalDone     = acts.filter(a => a.status === 'FINISHED');

      sdrMetrics[id] = {
        id, name: sdr.name || sdr.email, team: sdr.team_name,
        calls: {
          total: calls.length,
          connected: connected.length,
          meaningful: meaningful.length,
          shortAbandons: shortCalls.length,
          connectionRate:   calls.length      ? +((connected.length  / calls.length)      * 100).toFixed(1) : 0,
          meaningfulRate:   connected.length  ? +((meaningful.length / connected.length)  * 100).toFixed(1) : 0,
          shortAbandonRate: connected.length  ? +((shortCalls.length / connected.length)  * 100).toFixed(1) : 0,
          avgDuration: connected.length ? Math.round(totalDur / connected.length) : 0
        },
        prospections: {
          total: prosp.length, won: won.length, lost: lost.length, active: active.length,
          wonRate:  prosp.length ? +((won.length  / prosp.length) * 100).toFixed(1) : 0,
          lostRate: prosp.length ? +((lost.length / prosp.length) * 100).toFixed(1) : 0
        },
        activities: {
          total: acts.length, done: totalDone.length,
          completionRate: acts.length ? +((totalDone.length / acts.length) * 100).toFixed(1) : 0,
          emailsDone:    emailsDone.length,    emailsPending: emailsPending.length,
          callsDone:     callsDone.length,     callsPending:  callsPending.length,
          whatsappDone:  waDone.length,        whatsappPending: waPending.length
        }
      };
    }

    const trends = buildMonthlyTrends(fCalls, fProsp, fActs, parseInt(months));
    const inboundResult = { sdrs: Object.values(sdrMetrics), trends, teams: [...new Set(inboundSDRs.map(s => s.team_name).filter(Boolean))] };
    cache[inboundKey] = inboundResult; cacheTime[inboundKey] = Date.now();
    res.json(inboundResult);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

function buildMonthlyTrends(calls, prosp, acts, numMonths = 6) {
  const months = {};
  const now = new Date();
  for (let i = numMonths - 1; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
    months[key] = { month: key, calls: 0, connected: 0, meaningful: 0, conversions: 0, prospections: 0, emails: 0, social: 0 };
  }

  for (const c of calls) {
    const d = new Date(c.date);
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
    if (months[key]) {
      months[key].calls++;
      if (c.status === 'CONNECTED') months[key].connected++;
      if (c.output === 'MEANINGFUL') months[key].meaningful++;
    }
  }

  for (const p of prosp) {
    const d = new Date(p.created_date);
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
    if (months[key]) {
      months[key].prospections++;
      if (p.status === 'WON') months[key].conversions++;
    }
  }

  const actDate = a => a.execution_date || a.available_from || a.updated;
  for (const a of (acts || [])) {
    const d = new Date(actDate(a));
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
    if (months[key] && a.status === 'FINISHED') {
      if (a.type === 'E_MAIL') months[key].emails++;
      if (a.type === 'SOCIAL_POINT') months[key].social++;
    }
  }

  return Object.values(months);
}

// GET /api/cache-status — shows which SDRs are cached
app.get('/api/cache-status', async (req, res) => {
  const usersData = cache['users'] || [];
  const sdrs = usersData.filter(u => u.role === 'SALESMAN' && u.active);
  const status = sdrs.map(s => ({
    id: s.id,
    name: s.name || s.email,
    calls: !!cache[`calls_${s.id}`],
    prosp: !!cache[`prosp_${s.id}`],
    acts:  !!cache[`acts_${s.id}`]
  }));
  const ready = status.filter(s => s.calls && s.prosp && s.acts).length;
  res.json({ ready, total: status.length, sdrs: status });
});

// Função central de refresh — usada pelo pre-warm e pelo auto-refresh
let refreshing = false;
async function refreshAllSDRs(label = 'refresh') {
  if (refreshing) { console.log(`${label}: já em andamento, pulando`); return; }
  refreshing = true;
  const started = Date.now();
  try {
    console.log(`[${label}] Iniciando atualização de dados...`);
    const { data: ud } = await meetime.get('/users');
    const allUsers = ud.data.filter(u => u.email && u.email.includes('v4company'));
    const sdrs = allUsers.filter(u => u.role === 'SALESMAN' && u.active).slice(0, 20);
    cache['users'] = allUsers;
    cacheTime['users'] = Date.now();

    // Cutoff: busca dados dos últimos 6 meses (cobre todos os períodos do dashboard)
    const cutoff6m = new Date(); cutoff6m.setMonth(cutoff6m.getMonth() - 6);

    // Processa 2 SDRs por vez para não sobrecarregar a API
    for (let i = 0; i < sdrs.length; i += 2) {
      const batch = sdrs.slice(i, i + 2);
      await Promise.all(batch.map(async sdr => {
        const name = sdr.name || sdr.email;
        try {
          const calls = await fetchSince('/calls', { user_id: sdr.id }, cutoff6m);
          cache[`calls_${sdr.id}`] = calls; cacheTime[`calls_${sdr.id}`] = Date.now();
          console.log(`  [${label}] calls ${name}: ${calls.length}`);
        } catch (e) { console.error(`[${label}] calls FAILED ${name}:`, e.message); }
        try {
          const prosp = await fetchSince('/prospections', { user_id: sdr.id }, cutoff6m);
          cache[`prosp_${sdr.id}`] = prosp; cacheTime[`prosp_${sdr.id}`] = Date.now();
          console.log(`  [${label}] prosp ${name}: ${prosp.length}`);
        } catch (e) { console.error(`[${label}] prosp FAILED ${name}:`, e.message); }
        try {
          const acts = await fetchSince('/prospections/activities', { assigned_to_id: sdr.id }, cutoff6m);
          cache[`acts_${sdr.id}`] = acts; cacheTime[`acts_${sdr.id}`] = Date.now();
          console.log(`  [${label}] acts  ${name}: ${acts.length}`);
        } catch (e) { console.error(`[${label}] acts FAILED ${name}:`, e.message); }
      }));
      if (i + 2 < sdrs.length) await sleep(800);
    }

    // Pré-computa resultados agregados para os períodos mais comuns
    // Isso garante que a 1ª requisição HTTP seja instantânea
    for (const months of [1, 3, 6]) {
      try {
        const cutoff = new Date(); cutoff.setMonth(cutoff.getMonth() - months);
        const fCalls = []; const fProsp = []; const fActs = [];
        const sdrMetrics = {};
        for (const sdr of sdrs) {
          const id = sdr.id; const name = sdr.name || sdr.email;
          const calls  = (cache[`calls_${id}`]  || []).filter(c => new Date(c.date) >= cutoff);
          const prosp   = (cache[`prosp_${id}`]  || []).filter(p => new Date(p.created_date) >= cutoff);
          const actDate = a => a.execution_date || a.available_from || a.updated;
          const acts    = (cache[`acts_${id}`]   || []).filter(a => new Date(actDate(a)) >= cutoff);
          fCalls.push(...calls.map(c=>({...c,sdr_id:id,sdr_name:name})));
          fProsp.push(...prosp.map(p=>({...p,sdr_id:id,sdr_name:name})));
          fActs.push(...acts.map(a=>({...a,sdr_id:id,sdr_name:name})));
          const conn = calls.filter(c=>c.status==='CONNECTED');
          const mean = calls.filter(c=>c.output==='MEANINGFUL');
          const dur  = conn.reduce((s,c)=>s+(c.connected_duration_seconds||0),0);
          const won  = prosp.filter(p=>p.status==='WON');
          const lost = prosp.filter(p=>p.status==='LOST');
          const active = prosp.filter(p=>p.status==='EXECUTING'||p.status==='WAITING');
          const short  = conn.filter(c=>(c.connected_duration_seconds||0)<=10);
          const emails = acts.filter(a=>a.type==='E_MAIL');
          const done   = acts.filter(a=>a.status==='FINISHED');
          sdrMetrics[id] = {
            id, name, team: sdr.team_name,
            calls: { total:calls.length, connected:conn.length, meaningful:mean.length, shortAbandons:short.length,
              connectionRate: calls.length?+((conn.length/calls.length)*100).toFixed(1):0,
              meaningfulRate: conn.length?+((mean.length/conn.length)*100).toFixed(1):0,
              shortAbandonRate: conn.length?+((short.length/conn.length)*100).toFixed(1):0,
              avgDuration: conn.length?Math.round(dur/conn.length):0, totalDuration:dur },
            prospections: { total:prosp.length, converted:won.length, lost:lost.length, active:active.length,
              conversionRate: prosp.length?+((won.length/prosp.length)*100).toFixed(1):0 },
            activities: { total:acts.length, done:done.length,
              emails:emails.length, emailsDone:emails.filter(a=>a.status==='FINISHED').length,
              emailsPending:emails.filter(a=>a.status!=='FINISHED').length,
              callsDone:acts.filter(a=>a.type==='CALL'&&a.status==='FINISHED').length,
              callsPending:acts.filter(a=>a.type==='CALL'&&a.status!=='FINISHED').length,
              whatsappDone:acts.filter(a=>a.type==='SOCIAL_POINT'&&a.status==='FINISHED').length,
              whatsappPending:acts.filter(a=>a.type==='SOCIAL_POINT'&&a.status!=='FINISHED').length,
              social:acts.filter(a=>a.type==='SOCIAL_POINT').length,
              searches:acts.filter(a=>a.type==='SEARCH').length,
              completionRate: acts.length?+((done.length/acts.length)*100).toFixed(1):0 }
          };
        }
        const trends = buildMonthlyTrends(fCalls, fProsp, fActs, months);
        const result = { sdrs: Object.values(sdrMetrics), trends, totalSDRs: sdrs.length };
        cache[`dashboard_result_${months}`] = result; cacheTime[`dashboard_result_${months}`] = Date.now();

        // Inbound
        const inboundSDRs = sdrs.filter(s => s.team_name && s.team_name.toUpperCase().includes('INBOUND'));
        const iSdrMetrics = {};
        for (const sdr of inboundSDRs) {
          const m = sdrMetrics[sdr.id];
          if (m) iSdrMetrics[sdr.id] = { ...m,
            prospections: { ...m.prospections, won:m.prospections.converted, wonRate:m.prospections.conversionRate, lostRate: m.prospections.total?+((m.prospections.lost/m.prospections.total)*100).toFixed(1):0 }
          };
        }
        const iTrends = buildMonthlyTrends(
          fCalls.filter(c=>inboundSDRs.some(s=>s.id===c.sdr_id)),
          fProsp.filter(p=>inboundSDRs.some(s=>s.id===p.sdr_id)),
          fActs.filter(a=>inboundSDRs.some(s=>s.id===a.sdr_id)), months);
        cache[`inbound_result_${months}`] = { sdrs: Object.values(iSdrMetrics), trends: iTrends, teams:[...new Set(inboundSDRs.map(s=>s.team_name).filter(Boolean))] };
        cacheTime[`inbound_result_${months}`] = Date.now();
      } catch(e) { console.error(`[${label}] pré-cômputo ${months}m:`, e.message); }
    }
    saveCacheToDisk();
    const mins = ((Date.now() - started) / 60000).toFixed(1);
    console.log(`[${label}] Dados atualizados em ${mins}min — ${sdrs.length} SDRs`);
  } catch (e) {
    console.error(`[${label}] Erro:`, e.message);
  } finally {
    refreshing = false;
  }
}

// Load cache immediately on startup
loadCacheFromDisk();

const PORT = process.env.PORT || 4000;
app.listen(PORT, () => {
  console.log(`Dashboard running at http://localhost:${PORT}`);

  // 1ª carga: após 1s do início
  setTimeout(() => refreshAllSDRs('pre-warm'), 1000);

  // Auto-refresh a cada 15 minutos — dados sempre atualizados independente de acessos
  setInterval(() => refreshAllSDRs('auto-refresh'), CACHE_TTL);
});
