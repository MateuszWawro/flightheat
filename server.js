const express = require('express');
const fetch = require('node-fetch');
const path = require('path');
const db = require('./db');
const { startCollector, getStatus } = require('./collector');

const app = express();
const PORT = process.env.PORT || 3000;
const OPENSKY_USER = process.env.OPENSKY_USER || '';
const OPENSKY_PASS = process.env.OPENSKY_PASS || '';
const ALERTS_USER  = process.env.ALERTS_USER  || 'admin';
const ALERTS_PASS  = process.env.ALERTS_PASS  || 'admin';

// ── Security headers ──────────────────────────────────────────────────────────
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('Referrer-Policy', 'no-referrer');
  next();
});

// ── Caches ────────────────────────────────────────────────────────────────────
const flightCache = new Map();
const CACHE_TTL_MS = 15_000;
const photoCache = new Map();
const PHOTO_TTL_MS = 60 * 60 * 1000;

// Evict stale cache entries every minute to prevent unbounded growth
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of flightCache) if (now - v.timestamp > CACHE_TTL_MS) flightCache.delete(k);
  for (const [k, v] of photoCache) if (now > v.expires) photoCache.delete(k);
}, 60_000);

// ── aircraft_db availability — checked once at startup ────────────────────────
let aircraftDbAvailable = false;
try { db.prepare('SELECT 1 FROM aircraft_db LIMIT 1').get(); aircraftDbAvailable = true; } catch {}

// ── Alerts Basic Auth middleware ───────────────────────────────────────────────
function alertsAuth(req, res, next) {
  const auth = req.headers.authorization || '';
  if (auth.startsWith('Basic ')) {
    const decoded = Buffer.from(auth.slice(6), 'base64').toString();
    const colon = decoded.indexOf(':');
    if (colon !== -1) {
      const u = decoded.slice(0, colon);
      const p = decoded.slice(colon + 1);
      if (u === ALERTS_USER && p === ALERTS_PASS) return next();
    }
  }
  res.setHeader('WWW-Authenticate', 'Basic realm="FlightHeat Alerts"');
  res.status(401).send('Authentication required');
}

// CORS — public read-only API only; alerts routes are excluded
app.use((req, res, next) => {
  if (!req.path.startsWith('/api/alerts')) {
    res.setHeader('Access-Control-Allow-Origin', '*');
  }
  next();
});

// Static files — alerts.html gets its own auth gate
app.use('/alerts.html', alertsAuth);
app.use(express.static(path.join(__dirname, 'public')));
app.use('/api/alerts', alertsAuth);

// ── Input helpers ─────────────────────────────────────────────────────────────
function safeInt(val, def, max) {
  const n = parseInt(val, 10);
  if (!Number.isFinite(n)) return def;
  return Math.min(Math.max(n, 1), max);
}

function safeFloat(val) {
  const n = parseFloat(val);
  return Number.isFinite(n) ? n : null;
}

const ICAO_RE = /^[0-9a-f]{6}$/;

function openSkyHeaders() {
  const h = {};
  if (OPENSKY_USER && OPENSKY_PASS)
    h['Authorization'] = 'Basic ' + Buffer.from(`${OPENSKY_USER}:${OPENSKY_PASS}`).toString('base64');
  return h;
}

// ── Parsing + enrichment ──────────────────────────────────────────────────────
function parseStates(states) {
  return (states || [])
    .map(s => ({
      icao:     s[0] || '',
      callsign: (s[1] || '').trim(),
      country:  s[2] || '',
      lon:      s[5],
      lat:      s[6],
      alt:      s[7] || 0,
      speed:    s[9] || 0,
      heading:  s[10] || 0,
      onGround: s[8] || false
    }))
    .filter(f => f.lat !== null && f.lon !== null && !f.onGround);
}

// Batch lookup — one query for all ICAOs instead of N individual queries
function enrichWithDb(flights) {
  if (!aircraftDbAvailable || !flights.length) return flights;

  const icaos = [...new Set(flights.map(f => f.icao.toLowerCase()).filter(Boolean))];
  if (!icaos.length) return flights;

  const placeholders = icaos.map(() => '?').join(',');
  let rows;
  try {
    rows = db.prepare(`SELECT * FROM aircraft_db WHERE icao24 IN (${placeholders})`).all(icaos);
  } catch { return flights; }

  const byIcao = Object.fromEntries(rows.map(r => [r.icao24, r]));

  return flights.map(f => {
    const info = byIcao[f.icao.toLowerCase()];
    return {
      ...f,
      registration: info?.registration || null,
      manufacturer: info?.manufacturer || null,
      model:        info?.model        || null,
      typecode:     info?.typecode     || null,
      operator:     info?.operator     || null
    };
  });
}

// ── Live flights ──────────────────────────────────────────────────────────────
app.get('/api/flights', async (req, res) => {
  const lamin = safeFloat(req.query.lamin);
  const lamax = safeFloat(req.query.lamax);
  const lomin = safeFloat(req.query.lomin);
  const lomax = safeFloat(req.query.lomax);

  if (lamin === null || lamax === null || lomin === null || lomax === null)
    return res.status(400).json({ error: 'Missing or invalid bbox parameters', flights: [] });

  const cacheKey = `${lamin},${lamax},${lomin},${lomax}`;
  const cached = flightCache.get(cacheKey);
  if (cached && Date.now() - cached.timestamp < CACHE_TTL_MS)
    return res.json({ ...cached.data, cached: true });

  const url = `https://opensky-network.org/api/states/all?lamin=${lamin}&lomin=${lomin}&lamax=${lamax}&lomax=${lomax}`;
  try {
    const response = await fetch(url, { headers: openSkyHeaders(), timeout: 15000 });
    if (!response.ok) {
      console.error(`OpenSky error ${response.status}`);
      return res.json({ flights: [], error: `OpenSky returned ${response.status}`, count: 0 });
    }
    const json = await response.json();
    const flights = enrichWithDb(parseStates(json.states));
    const result = { flights, count: flights.length, error: null };
    flightCache.set(cacheKey, { data: result, timestamp: Date.now() });
    res.json(result);
  } catch (err) {
    console.error('Fetch error:', err.message);
    res.json({ flights: [], error: 'Błąd połączenia z OpenSky', count: 0 });
  }
});

// ── Aircraft detail + photo ───────────────────────────────────────────────────
const PS_UA = 'FlightHeat/1.0 (+https://github.com/flightheat/flightheat)';

app.get('/api/aircraft/:icao', async (req, res) => {
  const icao = req.params.icao.toLowerCase();
  if (!ICAO_RE.test(icao)) return res.status(400).json({ error: 'Invalid ICAO' });

  let info = null;
  if (aircraftDbAvailable) {
    try { info = db.prepare('SELECT * FROM aircraft_db WHERE icao24 = ?').get(icao); } catch {}
  }

  let photoUrl = null;
  const photoCached = photoCache.get(icao);
  if (photoCached && Date.now() < photoCached.expires) {
    photoUrl = photoCached.url;
  } else {
    try {
      const pr = await fetch(`https://api.planespotters.net/pub/photos/hex/${icao}`, {
        timeout: 8000,
        headers: { 'User-Agent': PS_UA }
      });
      if (pr.ok) {
        const pj = await pr.json();
        const photo = pj?.photos?.[0];
        photoUrl = photo?.thumbnail_large?.src || photo?.thumbnail?.src || null;
      }
    } catch (err) {
      console.error(`[photo] ${icao}: ${err.message}`);
    }
    photoCache.set(icao, { url: photoUrl, expires: Date.now() + PHOTO_TTL_MS });
  }

  res.json({ ...(info || {}), icao24: icao, photoUrl });
});

// ── Flight track ──────────────────────────────────────────────────────────────
app.get('/api/flights/:icao/track', (req, res) => {
  const icao  = req.params.icao.toLowerCase();
  if (!ICAO_RE.test(icao)) return res.status(400).json({ error: 'Invalid ICAO' });

  const hours = safeInt(req.query.hours, 6, 48);

  try {
    const rows = db.prepare(`
      SELECT lat, lon, alt, speed, heading, captured_at
      FROM flight_snapshots
      WHERE icao = ?
        AND captured_at >= datetime('now', '-' || ? || ' hours')
      ORDER BY captured_at ASC
      LIMIT 300
    `).all(icao, hours);
    res.json(rows);
  } catch (err) {
    console.error('track error:', err.message);
    res.json([]);
  }
});

// ── Historical heatmap ────────────────────────────────────────────────────────
app.get('/api/history/heatmap', (req, res) => {
  const hours = safeInt(req.query.hours, 24, 24 * 7);
  const lamin = safeFloat(req.query.lamin);
  const lamax = safeFloat(req.query.lamax);
  const lomin = safeFloat(req.query.lomin);
  const lomax = safeFloat(req.query.lomax);

  const params = [hours];
  let bboxClause = '';
  if (lamin !== null && lamax !== null && lomin !== null && lomax !== null) {
    bboxClause = 'AND lat BETWEEN ? AND ? AND lon BETWEEN ? AND ?';
    params.push(lamin, lamax, lomin, lomax);
  }

  try {
    res.json(db.prepare(`
      SELECT ROUND(lat,2) as lat, ROUND(lon,2) as lon,
             COUNT(*) as count, AVG(alt) as avgAlt, AVG(speed) as avgSpeed
      FROM flight_snapshots
      WHERE captured_at >= datetime('now', '-' || ? || ' hours')
      ${bboxClause}
      GROUP BY ROUND(lat,2), ROUND(lon,2)
    `).all(...params));
  } catch (err) { console.error('heatmap error:', err.message); res.json([]); }
});

// ── Timeline ──────────────────────────────────────────────────────────────────
app.get('/api/history/timeline', (req, res) => {
  const hours    = safeInt(req.query.hours, 24, 24 * 7);
  const interval = safeInt(req.query.interval, 60, 24 * 60);

  try {
    res.json(db.prepare(`
      SELECT
        strftime('%Y-%m-%dT%H:', captured_at) ||
        printf('%02d', (CAST(strftime('%M', captured_at) AS INT) / ?) * ?) AS time,
        COUNT(*) as count
      FROM flight_snapshots
      WHERE captured_at >= datetime('now', '-' || ? || ' hours')
      GROUP BY time ORDER BY time ASC
    `).all(interval, interval, hours));
  } catch (err) { console.error('timeline error:', err.message); res.json([]); }
});

// ── Stats ─────────────────────────────────────────────────────────────────────
app.get('/api/history/stats', (req, res) => {
  const hours = safeInt(req.query.hours, 24, 24 * 7);
  const lamin = safeFloat(req.query.lamin);
  const lamax = safeFloat(req.query.lamax);
  const lomin = safeFloat(req.query.lomin);
  const lomax = safeFloat(req.query.lomax);

  const params = [hours];
  let bboxClause = '';
  if (lamin !== null && lamax !== null && lomin !== null && lomax !== null) {
    bboxClause = 'AND lat BETWEEN ? AND ? AND lon BETWEEN ? AND ?';
    params.push(lamin, lamax, lomin, lomax);
  }

  try {
    const base = `FROM flight_snapshots WHERE captured_at >= datetime('now', '-' || ? || ' hours') ${bboxClause}`;
    const agg = db.prepare(`SELECT COUNT(*) as totalFlights, COUNT(DISTINCT icao) as uniqueAircraft, AVG(alt) as avgAlt, AVG(speed) as avgSpeed ${base}`).get(...params);
    const peakRow = db.prepare(`SELECT strftime('%Y-%m-%dT%H:00', captured_at) as time, COUNT(*) as count ${base} GROUP BY strftime('%Y-%m-%dT%H', captured_at) ORDER BY count DESC LIMIT 1`).get(...params);
    const topCountries = db.prepare(`SELECT country, COUNT(*) as count ${base} AND country != '' GROUP BY country ORDER BY count DESC LIMIT 5`).all(...params);
    res.json({ totalFlights: agg.totalFlights, uniqueAircraft: agg.uniqueAircraft, avgAlt: Math.round(agg.avgAlt || 0), avgSpeed: Math.round(agg.avgSpeed || 0), peakHour: peakRow || null, topCountries });
  } catch (err) {
    console.error('stats error:', err.message);
    res.json({ totalFlights: 0, uniqueAircraft: 0, avgAlt: 0, avgSpeed: 0, peakHour: null, topCountries: [] });
  }
});

// ── Collector status ──────────────────────────────────────────────────────────
app.get('/api/collector/status', (req, res) => res.json(getStatus(db)));

// ── Alert rules ───────────────────────────────────────────────────────────────
const RULE_FIELDS = ['name','enabled','lamin','lamax','lomin','lomax','max_alt','min_speed','max_speed','country','icao_list','callsign_contains'];

app.get('/api/alerts/rules', (req, res) =>
  res.json(db.prepare('SELECT * FROM alert_rules ORDER BY id').all()));

app.post('/api/alerts/rules', express.json(), (req, res) => {
  const b = req.body || {};
  if (!b.name || typeof b.name !== 'string') return res.status(400).json({ error: 'name is required' });
  const cols = RULE_FIELDS.filter(f => f !== 'enabled' && b[f] !== undefined);
  const info = db.prepare(`INSERT INTO alert_rules (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`).run(cols.map(c => b[c] ?? null));
  res.status(201).json(db.prepare('SELECT * FROM alert_rules WHERE id = ?').get(info.lastInsertRowid));
});

app.patch('/api/alerts/rules/:id', express.json(), (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id)) return res.status(400).json({ error: 'Invalid id' });
  const b = req.body || {};
  const cols = RULE_FIELDS.filter(f => b[f] !== undefined);
  if (!cols.length) return res.status(400).json({ error: 'No fields to update' });
  db.prepare(`UPDATE alert_rules SET ${cols.map(c => `${c}=?`).join(',')} WHERE id=?`).run([...cols.map(c => b[c]), id]);
  const rule = db.prepare('SELECT * FROM alert_rules WHERE id = ?').get(id);
  if (!rule) return res.status(404).json({ error: 'Not found' });
  res.json(rule);
});

app.delete('/api/alerts/rules/:id', (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id)) return res.status(400).json({ error: 'Invalid id' });
  db.prepare('DELETE FROM alert_events WHERE rule_id = ?').run(id);
  db.prepare('DELETE FROM alert_rules WHERE id = ?').run(id);
  res.json({ ok: true });
});

app.get('/api/alerts/pending', (req, res) => {
  const rows = db.prepare(`
    SELECT e.*, r.name as rule_name FROM alert_events e
    LEFT JOIN alert_rules r ON r.id = e.rule_id
    WHERE e.notified = 0 ORDER BY e.triggered_at DESC LIMIT 50
  `).all();
  if (rows.length) {
    const ids = rows.map(r => r.id);
    db.prepare(`UPDATE alert_events SET notified=1 WHERE id IN (${ids.map(() => '?').join(',')})`).run(ids);
  }
  res.json(rows);
});

app.get('/api/alerts/events', (req, res) => {
  const hours = safeInt(req.query.hours, 24, 24 * 7);
  const limit = safeInt(req.query.limit, 100, 500);
  try {
    res.json(db.prepare(`
      SELECT e.*, r.name as rule_name FROM alert_events e
      LEFT JOIN alert_rules r ON r.id = e.rule_id
      WHERE e.triggered_at >= datetime('now', '-' || ? || ' hours')
      ORDER BY e.triggered_at DESC LIMIT ?
    `).all(hours, limit));
  } catch (err) { console.error('events error:', err.message); res.json([]); }
});

app.get('/api/alerts/stats', (req, res) => {
  const total    = db.prepare('SELECT COUNT(*) as c FROM alert_rules').get().c;
  const enabled  = db.prepare('SELECT COUNT(*) as c FROM alert_rules WHERE enabled=1').get().c;
  const events24 = db.prepare(`SELECT COUNT(*) as c FROM alert_events WHERE triggered_at >= datetime('now','-24 hours')`).get().c;
  const last     = db.prepare('SELECT MAX(triggered_at) as t FROM alert_events').get().t;
  res.json({ totalRules: total, enabledRules: enabled, totalEvents24h: events24, lastEvent: last });
});

// ── Start ─────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`FlightHeat running on http://localhost:${PORT}`);
  startCollector(db);
});
