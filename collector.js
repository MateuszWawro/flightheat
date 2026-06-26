const cron = require('node-cron');
const fetch = require('node-fetch');
const { runAlertCheck } = require('./alerts');

const OPENSKY_USER = process.env.OPENSKY_USER || '';
const OPENSKY_PASS = process.env.OPENSKY_PASS || '';
const COLLECT_BBOX = process.env.COLLECT_BBOX || '34,72,-12,42';

let lastRun = null;
let lastCount = 0;
let running = false;

function parseBbox(bbox) {
  const [lamin, lamax, lomin, lomax] = bbox.split(',').map(Number);
  return { lamin, lamax, lomin, lomax };
}

async function fetchFlights(bbox) {
  const { lamin, lamax, lomin, lomax } = parseBbox(bbox);
  const url = `https://opensky-network.org/api/states/all?lamin=${lamin}&lomin=${lomin}&lamax=${lamax}&lomax=${lomax}`;

  const headers = {};
  if (OPENSKY_USER && OPENSKY_PASS) {
    const b64 = Buffer.from(`${OPENSKY_USER}:${OPENSKY_PASS}`).toString('base64');
    headers['Authorization'] = `Basic ${b64}`;
  }

  const response = await fetch(url, { headers, timeout: 20000 });
  if (!response.ok) throw new Error(`OpenSky HTTP ${response.status}`);

  const json = await response.json();
  return (json.states || [])
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

function runCollection(db) {
  const insertMany = db.transaction((flights, bbox) => {
    const stmt = db.prepare(`
      INSERT INTO flight_snapshots (icao, callsign, lat, lon, alt, speed, heading, country)
      VALUES (@icao, @callsign, @lat, @lon, @alt, @speed, @heading, @country)
    `);
    for (const f of flights) stmt.run(f);

    db.prepare(`INSERT INTO collection_log (bbox, count) VALUES (?, ?)`).run(bbox, flights.length);

    // Cleanup rows older than 30 days
    db.prepare(`DELETE FROM flight_snapshots WHERE captured_at < datetime('now', '-30 days')`).run();
  });

  running = true;
  fetchFlights(COLLECT_BBOX)
    .then(flights => {
      insertMany(flights, COLLECT_BBOX);
      lastRun = new Date().toISOString();
      lastCount = flights.length;
      const total = db.prepare('SELECT COUNT(*) as c FROM flight_snapshots').get().c;
      console.log(`[collector] ${lastRun.slice(0, 16).replace('T', ' ')} — saved ${flights.length} flights (total: ${total.toLocaleString()})`);
      runAlertCheck(db, flights);
    })
    .catch(err => {
      console.error('[collector] error:', err.message);
      db.prepare(`INSERT INTO collection_log (bbox, count, error) VALUES (?, 0, ?)`).run(COLLECT_BBOX, err.message);
      lastRun = new Date().toISOString();
    })
    .finally(() => { running = false; });
}

function startCollector(db) {
  console.log(`[collector] starting — bbox: ${COLLECT_BBOX}, schedule: every 5 min`);
  runCollection(db);
  cron.schedule('*/5 * * * *', () => runCollection(db));
}

function getStatus(db) {
  const total  = db.prepare('SELECT COUNT(*) as c FROM flight_snapshots').get().c;
  const oldest = db.prepare('SELECT MIN(captured_at) as t FROM flight_snapshots').get().t;
  return { running, lastRun, lastCount, totalRecords: total, oldestRecord: oldest, bbox: COLLECT_BBOX };
}

module.exports = { startCollector, getStatus };
