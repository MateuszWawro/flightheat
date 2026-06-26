'use strict';

function matchesRule(rule, flight) {
  // bbox
  if (rule.lamin != null && flight.lat < rule.lamin) return false;
  if (rule.lamax != null && flight.lat > rule.lamax) return false;
  if (rule.lomin != null && flight.lon < rule.lomin) return false;
  if (rule.lomax != null && flight.lon > rule.lomax) return false;

  // altitude (OpenSky returns metres)
  if (rule.max_alt != null && (flight.alt == null || flight.alt >= rule.max_alt)) return false;

  // speed stored as m/s in snapshots; rule values are km/h
  const speedKmh = (flight.speed || 0) * 3.6;
  if (rule.min_speed != null && speedKmh <= rule.min_speed) return false;
  if (rule.max_speed != null && speedKmh >= rule.max_speed) return false;

  // country — comma-separated, case-insensitive
  if (rule.country) {
    const allowed = rule.country.split(',').map(s => s.trim().toLowerCase());
    if (!allowed.includes((flight.country || '').toLowerCase())) return false;
  }

  // ICAO list
  if (rule.icao_list) {
    const list = rule.icao_list.split(',').map(s => s.trim().toLowerCase());
    if (!list.includes((flight.icao || '').toLowerCase())) return false;
  }

  // callsign substring
  if (rule.callsign_contains) {
    if (!(flight.callsign || '').toLowerCase().includes(rule.callsign_contains.toLowerCase())) return false;
  }

  return true;
}

function runAlertCheck(db, flights) {
  if (!flights || flights.length === 0) return 0;

  let rules;
  try {
    rules = db.prepare('SELECT * FROM alert_rules WHERE enabled = 1').all();
  } catch {
    return 0; // table may not exist yet
  }

  if (!rules.length) return 0;

  const insertEvent = db.prepare(`
    INSERT INTO alert_events (rule_id, icao, callsign, lat, lon, alt, speed, heading, country)
    VALUES (@rule_id, @icao, @callsign, @lat, @lon, @alt, @speed, @heading, @country)
  `);

  const checkDup = db.prepare(`
    SELECT 1 FROM alert_events
    WHERE rule_id = ? AND icao = ?
      AND triggered_at >= datetime('now', '-30 minutes')
    LIMIT 1
  `);

  let newEvents = 0;

  const run = db.transaction(() => {
    for (const rule of rules) {
      for (const flight of flights) {
        if (!matchesRule(rule, flight)) continue;

        // Deduplication: skip if same ICAO+rule triggered in last 30 min
        if (checkDup.get(rule.id, flight.icao)) continue;

        insertEvent.run({
          rule_id:  rule.id,
          icao:     flight.icao,
          callsign: flight.callsign || null,
          lat:      flight.lat,
          lon:      flight.lon,
          alt:      flight.alt,
          speed:    flight.speed,
          heading:  flight.heading,
          country:  flight.country
        });
        newEvents++;
      }
    }
  });

  run();

  if (newEvents > 0) {
    console.log(`[alerts] ${newEvents} nowych zdarzeń`);
  }

  return newEvents;
}

module.exports = { runAlertCheck };
