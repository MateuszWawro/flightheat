'use strict';

const MAX_CACHE = 10000;
const cache = new Map();

function lookupAircraft(db, icao24) {
  if (!icao24) return null;
  const key = icao24.toLowerCase();

  if (cache.has(key)) return cache.get(key);

  let row;
  try {
    row = db.prepare('SELECT * FROM aircraft_db WHERE icao24 = ?').get(key);
  } catch {
    return null;
  }

  // Simple LRU: evict oldest insertion when full
  if (cache.size >= MAX_CACHE) {
    cache.delete(cache.keys().next().value);
  }
  cache.set(key, row || null);
  return row || null;
}

module.exports = { lookupAircraft };
