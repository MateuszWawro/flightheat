const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const DB_PATH = process.env.DB_PATH || './data/flightheat.db';

fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

const db = new Database(DB_PATH);

db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS flight_snapshots (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    captured_at TEXT NOT NULL DEFAULT (datetime('now')),
    icao        TEXT NOT NULL,
    callsign    TEXT,
    lat         REAL NOT NULL,
    lon         REAL NOT NULL,
    alt         REAL,
    speed       REAL,
    heading     REAL,
    country     TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_captured_at ON flight_snapshots(captured_at);
  CREATE INDEX IF NOT EXISTS idx_icao        ON flight_snapshots(icao);
  CREATE INDEX IF NOT EXISTS idx_time_pos    ON flight_snapshots(captured_at, lat, lon);
  CREATE INDEX IF NOT EXISTS idx_alert_events_dedup
    ON alert_events(rule_id, icao, triggered_at);

  CREATE TABLE IF NOT EXISTS collection_log (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    collected_at TEXT DEFAULT (datetime('now')),
    bbox         TEXT,
    count        INTEGER,
    error        TEXT
  );

  CREATE TABLE IF NOT EXISTS alert_rules (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    name             TEXT NOT NULL,
    enabled          INTEGER DEFAULT 1,
    created_at       TEXT DEFAULT (datetime('now')),
    lamin            REAL,
    lamax            REAL,
    lomin            REAL,
    lomax            REAL,
    max_alt          REAL,
    min_speed        REAL,
    max_speed        REAL,
    country          TEXT,
    icao_list        TEXT,
    callsign_contains TEXT
  );

  CREATE TABLE IF NOT EXISTS alert_events (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    rule_id      INTEGER REFERENCES alert_rules(id) ON DELETE CASCADE,
    triggered_at TEXT DEFAULT (datetime('now')),
    icao         TEXT,
    callsign     TEXT,
    lat          REAL,
    lon          REAL,
    alt          REAL,
    speed        REAL,
    heading      REAL,
    country      TEXT,
    notified     INTEGER DEFAULT 0
  );

  CREATE INDEX IF NOT EXISTS idx_alert_events_notified
    ON alert_events(notified, triggered_at);
`);

// Seed default rules on first run
const ruleCount = db.prepare('SELECT COUNT(*) as c FROM alert_rules').get().c;
if (ruleCount === 0) {
  const seedRule = db.prepare(`
    INSERT INTO alert_rules (name, max_alt, lamin, lamax, lomin, lomax, country)
    VALUES (@name, @max_alt, @lamin, @lamax, @lomin, @lomax, @country)
  `);
  db.transaction(() => {
    seedRule.run({ name: 'Nisko nad Elblągiem', max_alt: 1000, lamin: 54.05, lamax: 54.25, lomin: 19.3, lomax: 19.7, country: null });
    db.prepare(`INSERT INTO alert_rules (name, country) VALUES (?, ?)`).run('Rosyjska/Białoruska rejestracja', 'Russia,Belarus');
    db.prepare(`INSERT INTO alert_rules (name, max_alt) VALUES (?, ?)`).run('Bardzo niska wysokość (cały obszar)', 500);
  })();
  console.log('[db] Seeded 3 default alert rules');
}

module.exports = db;
