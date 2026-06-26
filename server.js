const express = require('express');
const fetch = require('node-fetch');
const path = require('path');
const db = require('./db');
const { startCollector, getStatus } = require('./collector');
const { lookupAircraft } = require('./aircraft');

const app = express();
const PORT = process.env.PORT || 3000;
const OPENSKY_USER = process.env.OPENSKY_USER || '';
const OPENSKY_PASS = process.env.OPENSKY_PASS || '';

// Live-flight bbox cache (15s TTL)
const flightCache = new Map();
const CACHE_TTL_MS = 15000;

// Photo URL cache (1h TTL)
const photoCache = new Map();
const PHOTO_TTL_MS = 60 * 60 * 1000;

app.use(express.static(path.join(__dirname, 'public')));
app.use((req, res, next) => { res.setHeader('Access-Control-Allow-Origin', '*'); next(); });

// ── Helpers ───────────────────────────────────────────────────────────────────
function openSkyHeaders() {
  const headers = {};
  if (OPENSKY_USER && OPENSKY_PASS) {
    headers['Authorization'] = 'Basic ' + Buffer.from(`${OPENSKY_USER}:${OPENSKY_PASS}`).toString('base64');
  }
  return headers;
}

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

function enrichWithDb(flights) {
  // Check if aircraft_db table exists before trying to look up
  let hasTable = false;
  try {
    db.prepare("SELECT 1 FROM aircraft_db LIMIT 1").get();
    hasTable = true;
  } catch { /* table not yet imported */ }

  if (!hasTable) return flights;

  return flights.map(f => {
    const info = lookupAircraft(db, f.icao);
    return {
      ...f,
      registration: info?.registration || null,
      manufacturer: info?.manufacturer || null,
      model:        info?.model || null,
      typecode:     info?.typecode || null,
      operator:     info?.operator || null
    };
  });
}

// ── Live flights ──────────────────────────────────────────────────────────────
app.get('/api/flights', async (req, res) => {
  const { lamin, lamax, lomin, lomax } = req.query;
  if (!lamin || !lamax || !lomin || !lomax) {
    return res.status(400).json({ error: 'Missing bbox parameters', flights: [] });
  }

  const cacheKey = `${lamin},${lamax},${lomin},${lomax}`;
  const cached = flightCache.get(cacheKey);
  if (cached && Date.now() - cached.timestamp < CACHE_TTL_MS) {
    return res.json({ ...cached.data, cached: true });
  }

  const url = `https://opensky-network.org/api/states/all?lamin=${lamin}&lomin=${lomin}&lamax=${lamax}&lomax=${lomax}`;
  try {
    const response = await fetch(url, { headers: openSkyHeaders(), timeout: 15000 });
    if (!response.ok) {
      const errText = await response.text();
      console.error(`OpenSky error ${response.status}: ${errText}`);
      return res.json({ flights: [], error: `OpenSky returned ${response.status}`, count: 0 });
    }
    const json = await response.json();
    const flights = enrichWithDb(parseStates(json.states));
    const result = { flights, count: flights.length, error: null };
    flightCache.set(cacheKey, { data: result, timestamp: Date.now() });
    res.json(result);
  } catch (err) {
    console.error('Fetch error:', err.message);
    res.json({ flights: [], error: `Błąd połączenia: ${err.message}`, count: 0 });
  }
});

// ── Aircraft detail + photo ───────────────────────────────────────────────────
app.get('/api/aircraft/:icao', async (req, res) => {
  const icao = req.params.icao.toLowerCase();
  const info = lookupAircraft(db, icao);

  // Photo: check cache first
  let photoUrl = null;
  const photoCached = photoCache.get(icao);
  if (photoCached && Date.now() < photoCached.expires) {
    photoUrl = photoCached.url;
  } else {
    try {
      const pr = await fetch(`https://api.planespotters.net/pub/photos/hex/${icao}`, { timeout: 8000 });
      if (pr.ok) {
        const pj = await pr.json();
        photoUrl = pj?.photos?.[0]?.thumbnail_large?.src || null;
      }
    } catch { /* no photo */ }
    photoCache.set(icao, { url: photoUrl, expires: Date.now() + PHOTO_TTL_MS });
  }

  res.json({ ...(info || {}), icao24: icao, photoUrl });
});

// ── Historical heatmap ────────────────────────────────────────────────────────
app.get('/api/history/heatmap', (req, res) => {
  const hours = Math.min(parseInt(req.query.hours) || 24, 24 * 7);
  const { lamin, lamax, lomin, lomax } = req.query;

  let sql = `
    SELECT ROUND(lat,2) as lat, ROUND(lon,2) as lon,
           COUNT(*) as count,
           AVG(alt) as avgAlt, AVG(speed) as avgSpeed
    FROM flight_snapshots
    WHERE captured_at >= datetime('now', '-${hours} hours')
  `;
  const params = [];
  if (lamin && lamax && lomin && lomax) {
    sql += ` AND lat BETWEEN ? AND ? AND lon BETWEEN ? AND ?`;
    params.push(Number(lamin), Number(lamax), Number(lomin), Number(lomax));
  }
  sql += ` GROUP BY ROUND(lat,2), ROUND(lon,2)`;

  try {
    res.json(db.prepare(sql).all(...params));
  } catch (err) {
    console.error('history/heatmap error:', err.message);
    res.json([]);
  }
});

// ── Timeline ──────────────────────────────────────────────────────────────────
app.get('/api/history/timeline', (req, res) => {
  const hours    = Math.min(parseInt(req.query.hours) || 24, 24 * 7);
  const interval = Math.max(parseInt(req.query.interval) || 60, 5);
  const sql = `
    SELECT
      strftime('%Y-%m-%dT%H:', captured_at) ||
      printf('%02d', (CAST(strftime('%M', captured_at) AS INT) / ${interval}) * ${interval})
      AS time,
      COUNT(*) as count
    FROM flight_snapshots
    WHERE captured_at >= datetime('now', '-${hours} hours')
    GROUP BY time ORDER BY time ASC
  `;
  try {
    res.json(db.prepare(sql).all());
  } catch (err) {
    console.error('history/timeline error:', err.message);
    res.json([]);
  }
});

// ── Stats ─────────────────────────────────────────────────────────────────────
app.get('/api/history/stats', (req, res) => {
  const hours = Math.min(parseInt(req.query.hours) || 24, 24 * 7);
  try {
    const base = `FROM flight_snapshots WHERE captured_at >= datetime('now', '-${hours} hours')`;
    const agg  = db.prepare(`SELECT COUNT(*) as totalFlights, COUNT(DISTINCT icao) as uniqueAircraft, AVG(alt) as avgAlt, AVG(speed) as avgSpeed ${base}`).get();
    const peakRow = db.prepare(`SELECT strftime('%Y-%m-%dT%H:00', captured_at) as time, COUNT(*) as count ${base} GROUP BY strftime('%Y-%m-%dT%H', captured_at) ORDER BY count DESC LIMIT 1`).get();
    const topCountries = db.prepare(`SELECT country, COUNT(*) as count ${base} AND country != '' GROUP BY country ORDER BY count DESC LIMIT 5`).all();
    res.json({ totalFlights: agg.totalFlights, uniqueAircraft: agg.uniqueAircraft, avgAlt: Math.round(agg.avgAlt || 0), avgSpeed: Math.round(agg.avgSpeed || 0), peakHour: peakRow || null, topCountries });
  } catch (err) {
    console.error('history/stats error:', err.message);
    res.json({ totalFlights: 0, uniqueAircraft: 0, avgAlt: 0, avgSpeed: 0, peakHour: null, topCountries: [] });
  }
});

// ── Collector status ──────────────────────────────────────────────────────────
app.get('/api/collector/status', (req, res) => res.json(getStatus(db)));

// ── Alert rules ───────────────────────────────────────────────────────────────
const RULE_FIELDS = ['name','enabled','lamin','lamax','lomin','lomax','max_alt','min_speed','max_speed','country','icao_list','callsign_contains'];

app.get('/api/alerts/rules', (req, res) => {
  res.json(db.prepare('SELECT * FROM alert_rules ORDER BY id').all());
});

app.post('/api/alerts/rules', express.json(), (req, res) => {
  const b = req.body || {};
  if (!b.name) return res.status(400).json({ error: 'name is required' });
  const cols = RULE_FIELDS.filter(f => f !== 'enabled' && b[f] !== undefined);
  const stmt = db.prepare(
    `INSERT INTO alert_rules (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`
  );
  const info = stmt.run(cols.map(c => b[c] ?? null));
  res.status(201).json(db.prepare('SELECT * FROM alert_rules WHERE id = ?').get(info.lastInsertRowid));
});

app.patch('/api/alerts/rules/:id', express.json(), (req, res) => {
  const id = parseInt(req.params.id);
  const b = req.body || {};
  const cols = RULE_FIELDS.filter(f => b[f] !== undefined);
  if (!cols.length) return res.status(400).json({ error: 'No fields to update' });
  db.prepare(`UPDATE alert_rules SET ${cols.map(c => `${c}=?`).join(',')} WHERE id=?`).run([...cols.map(c => b[c]), id]);
  const rule = db.prepare('SELECT * FROM alert_rules WHERE id = ?').get(id);
  if (!rule) return res.status(404).json({ error: 'Not found' });
  res.json(rule);
});

app.delete('/api/alerts/rules/:id', (req, res) => {
  const id = parseInt(req.params.id);
  db.prepare('DELETE FROM alert_events WHERE rule_id = ?').run(id);
  db.prepare('DELETE FROM alert_rules WHERE id = ?').run(id);
  res.json({ ok: true });
});

// ── Alert events ──────────────────────────────────────────────────────────────
app.get('/api/alerts/pending', (req, res) => {
  const rows = db.prepare(`
    SELECT e.*, r.name as rule_name
    FROM alert_events e
    LEFT JOIN alert_rules r ON r.id = e.rule_id
    WHERE e.notified = 0
    ORDER BY e.triggered_at DESC
    LIMIT 50
  `).all();

  if (rows.length > 0) {
    const ids = rows.map(r => r.id);
    db.prepare(`UPDATE alert_events SET notified=1 WHERE id IN (${ids.map(() => '?').join(',')})`).run(ids);
  }
  res.json(rows);
});

app.get('/api/alerts/events', (req, res) => {
  const hours = Math.min(parseInt(req.query.hours) || 24, 24 * 7);
  const limit = Math.min(parseInt(req.query.limit) || 100, 500);
  const rows = db.prepare(`
    SELECT e.*, r.name as rule_name
    FROM alert_events e
    LEFT JOIN alert_rules r ON r.id = e.rule_id
    WHERE e.triggered_at >= datetime('now', '-${hours} hours')
    ORDER BY e.triggered_at DESC
    LIMIT ${limit}
  `).all();
  res.json(rows);
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
