#!/usr/bin/env node
'use strict';

const zlib    = require('zlib');
const path    = require('path');
const fs      = require('fs');
const fetch   = require('node-fetch');
const { parse } = require('csv-parse/sync');

// Allow override: node scripts/import-aircraft-db.js /path/to/file.csv.gz
const localPath = process.argv[2];
const CSV_URL   = 'https://opensky-network.org/datasets/metadata/aircraftDatabase.csv.gz';

// Import db from project root
const db = require('../db');

// Ensure table exists
db.exec(`
  CREATE TABLE IF NOT EXISTS aircraft_db (
    icao24       TEXT PRIMARY KEY,
    registration TEXT,
    manufacturer TEXT,
    model        TEXT,
    typecode     TEXT,
    operator     TEXT,
    built        TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_aircraft_icao ON aircraft_db(icao24);
`);

async function getBuffer() {
  if (localPath) {
    console.log(`Reading from local file: ${localPath}`);
    const raw = fs.readFileSync(localPath);
    if (localPath.endsWith('.gz')) {
      return zlib.gunzipSync(raw);
    }
    return raw;
  }

  console.log(`Downloading from: ${CSV_URL}`);
  const res = await fetch(CSV_URL, {
    headers: { 'Accept-Encoding': 'gzip' },
    timeout: 120000
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);

  return new Promise((resolve, reject) => {
    const chunks = [];
    const gunzip = zlib.createGunzip();
    res.body.pipe(gunzip);
    gunzip.on('data', c => chunks.push(c));
    gunzip.on('end',  () => resolve(Buffer.concat(chunks)));
    gunzip.on('error', reject);
    res.body.on('error', reject);
  });
}

async function main() {
  console.time('total');

  const buf = await getBuffer();
  console.log(`Decompressed: ${(buf.length / 1024 / 1024).toFixed(1)} MB — parsing CSV…`);

  const records = parse(buf, {
    columns: true,
    skip_empty_lines: true,
    relax_column_count: true,
    trim: true
  });

  console.log(`Parsed ${records.length.toLocaleString()} rows — inserting…`);

  // Wipe + reinsert for a clean import
  db.exec('DELETE FROM aircraft_db');

  const insert = db.prepare(`
    INSERT OR REPLACE INTO aircraft_db (icao24, registration, manufacturer, model, typecode, operator, built)
    VALUES (@icao24, @registration, @manufacturer, @model, @typecode, @operator, @built)
  `);

  const insertMany = db.transaction((rows) => {
    for (const r of rows) insert.run(r);
  });

  const BATCH = 5000;
  let inserted = 0;

  for (let i = 0; i < records.length; i += BATCH) {
    const batch = records.slice(i, i + BATCH).map(r => ({
      icao24:       (r.icao24 || '').toLowerCase().trim(),
      registration: r.registration || null,
      manufacturer: r.manufacturername || null,
      model:        r.model || null,
      typecode:     r.typecode || r.icaotypedesignator || null,
      operator:     r.operatorcallsign || r.operator || r.owner || null,
      built:        r.built || null
    })).filter(r => r.icao24);

    insertMany(batch);
    inserted += batch.length;

    if (inserted % 10000 < BATCH) {
      console.log(`  ${inserted.toLocaleString()} / ${records.length.toLocaleString()} rows`);
    }
  }

  console.log(`\nDone — inserted ${inserted.toLocaleString()} aircraft records.`);
  console.timeEnd('total');
  db.close();
}

main().catch(err => {
  console.error('Import failed:', err.message);
  process.exit(1);
});
