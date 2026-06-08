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

// Fetch the MOST RECENT records — API returns oldest-first so we jump to the end
async function fetchRecent(endpoint, extraParams = {}, maxRecords = 500) {
  // Peek to get totalItems
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
    const page = data.data || [];
    if (!page.length) break;
    results.push(...page);
    if (!data.next || results.length >= maxRecords) break;
    start += limit;
    await sleep(150);
  }
  return results.slice(0, maxRecords);
}

// Cache in memory (refresh every 15min)
let cache = {};
let cacheTime = {};
const CACHE_TTL = 15 * 60 * 1000;

async function cached(key, fn) {
  const now = Date.now();
  if (cache[key] && now - cacheTime[key] < CACHE_TTL) return cache[key];
  cache[key] = await fn();
  cacheTime[key] = now;
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

    // Fetch sequentially to avoid rate limiting
    for (const sdr of sdrs.slice(0, 20)) {
      try {
        const calls = await cached(`calls_${sdr.id}`, () => fetchRecent('/calls', { user_id: sdr.id }, 2000));
        allCalls.push(...calls.map(c => ({ ...c, sdr_id: sdr.id, sdr_name: sdr.name || sdr.email })));
      } catch (e) { console.error(`calls fetch failed for ${sdr.id}:`, e.message); }
      try {
        const prosp = await cached(`prosp_${sdr.id}`, () => fetchRecent('/prospections', { user_id: sdr.id }, 2000));
        allProspections.push(...prosp.map(p => ({ ...p, sdr_id: sdr.id, sdr_name: sdr.name || sdr.email })));
      } catch (e) { console.error(`prosp fetch FAILED for ${sdr.id}:`, e.message); }
      try {
        const acts = await cached(`acts_${sdr.id}`, () => fetchRecent('/prospections/activities', { assigned_to_id: sdr.id }, 1000));
        allActivities.push(...acts.map(a => ({ ...a, sdr_id: sdr.id, sdr_name: sdr.name || sdr.email })));
      } catch (e) { console.error(`acts fetch failed for ${sdr.id}:`, e.message); }
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

    // Monthly trends (last 6 months)
    const trends = buildMonthlyTrends(filteredCalls, filteredProsp, filteredActs, parseInt(months));

    res.json({ sdrs: Object.values(sdrMetrics), trends, totalSDRs: sdrs.length });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

// GET /api/inbound — métricas para SDRs com team_name contendo "INBOUND"
app.get('/api/inbound', async (req, res) => {
  try {
    const { months = 3 } = req.query;
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

    for (const sdr of inboundSDRs) {
      try {
        const calls = await cached(`calls_${sdr.id}`, () => fetchRecent('/calls', { user_id: sdr.id }, 2000));
        allCalls.push(...calls.map(c => ({ ...c, _sdr_id: sdr.id, _sdr_name: sdr.name || sdr.email, _team: sdr.team_name })));
      } catch (e) { console.error(`inbound calls ${sdr.id}:`, e.message); }
      try {
        const prosp = await cached(`prosp_${sdr.id}`, () => fetchRecent('/prospections', { user_id: sdr.id }, 2000));
        allProsp.push(...prosp.map(p => ({ ...p, _sdr_id: sdr.id, _sdr_name: sdr.name || sdr.email, _team: sdr.team_name })));
      } catch (e) { console.error(`inbound prosp ${sdr.id}:`, e.message); }
      try {
        const acts = await cached(`acts_${sdr.id}`, () => fetchRecent('/prospections/activities', { assigned_to_id: sdr.id }, 1000));
        allActs.push(...acts.map(a => ({ ...a, _sdr_id: sdr.id, _sdr_name: sdr.name || sdr.email, _team: sdr.team_name })));
      } catch (e) { console.error(`inbound acts ${sdr.id}:`, e.message); }
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
    res.json({ sdrs: Object.values(sdrMetrics), trends, teams: [...new Set(inboundSDRs.map(s => s.team_name).filter(Boolean))] });
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

const PORT = 4000;
app.listen(PORT, () => {
  console.log(`Dashboard running at http://localhost:${PORT}`);
  // Pre-warm cache in background so first browser load is instant
  setTimeout(async () => {
    try {
      console.log('Pre-loading data...');
      const { data: ud } = await meetime.get('/users');
      const sdrs = ud.data.filter(u => u.email && u.email.includes('v4company') && u.role === 'SALESMAN' && u.active);
      cache['users'] = ud.data.filter(u => u.email && u.email.includes('v4company'));
      cacheTime['users'] = Date.now();
      for (const sdr of sdrs.slice(0, 20)) {
        try {
          const calls = await fetchRecent('/calls', { user_id: sdr.id }, 2000);
          cache[`calls_${sdr.id}`] = calls; cacheTime[`calls_${sdr.id}`] = Date.now();
        } catch (_) {}
        try {
          const prosp = await fetchRecent('/prospections', { user_id: sdr.id }, 2000);
          cache[`prosp_${sdr.id}`] = prosp; cacheTime[`prosp_${sdr.id}`] = Date.now();
        } catch (_) {}
        try {
          const acts = await fetchRecent('/prospections/activities', { assigned_to_id: sdr.id }, 1000);
          cache[`acts_${sdr.id}`] = acts; cacheTime[`acts_${sdr.id}`] = Date.now();
        } catch (_) {}
      }
      console.log('Data pre-loaded! Dashboard ready.');
    } catch (e) { console.error('Pre-load error:', e.message); }
  }, 1000);
});
