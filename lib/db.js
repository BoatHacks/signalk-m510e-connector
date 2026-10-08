'use strict'

const { DatabaseSync } = require('node:sqlite')

const SCHEMA = `
CREATE TABLE IF NOT EXISTS transmissions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  direction TEXT NOT NULL DEFAULT 'rx',
  channel_nr INTEGER,
  start_ts INTEGER NOT NULL,
  end_ts INTEGER,
  duration_ms INTEGER,
  audio_path TEXT,
  file_bytes INTEGER,
  mode INTEGER,
  squelch INTEGER,
  lat REAL,
  lon REAL,
  notes TEXT,
  transcript TEXT
);
CREATE INDEX IF NOT EXISTS idx_transmissions_start_ts ON transmissions(start_ts);
CREATE INDEX IF NOT EXISTS idx_transmissions_channel_nr ON transmissions(channel_nr);
`

// Brings a database created by an older version up to the current schema.
// Fresh databases already have the current columns.
function migrate (db) {
  const columns = db.prepare('PRAGMA table_info(transmissions)').all().map((c) => c.name)
  // byte_count held the raw + WAV size on disk, not the audio size.
  if (columns.includes('byte_count') && !columns.includes('file_bytes')) {
    db.exec('ALTER TABLE transmissions RENAME COLUMN byte_count TO file_bytes')
  }
  if (!columns.includes('mode')) {
    db.exec('ALTER TABLE transmissions ADD COLUMN mode INTEGER')
  }
}

function openDb (path) {
  const db = new DatabaseSync(path)
  // The table must exist before migrating; the indexes come after, so an
  // old table without a new column never trips over them.
  db.exec(SCHEMA)
  migrate(db)
  return db
}

function insertTransmission (db, tx) {
  const stmt = db.prepare(`
    INSERT INTO transmissions
      (direction, channel_nr, mode, start_ts, end_ts, duration_ms, audio_path, file_bytes, squelch, lat, lon, notes)
    VALUES
      (@direction, @channel_nr, @mode, @start_ts, @end_ts, @duration_ms, @audio_path, @file_bytes, @squelch, @lat, @lon, @notes)
  `)
  const result = stmt.run({
    direction: tx.direction || 'rx',
    channel_nr: tx.channelNr ?? null,
    mode: tx.mode ?? null,
    start_ts: tx.startTs,
    end_ts: tx.endTs ?? null,
    duration_ms: tx.durationMs ?? null,
    audio_path: tx.audioPath ?? null,
    file_bytes: tx.fileBytes ?? null,
    squelch: tx.squelch ?? null,
    lat: tx.lat ?? null,
    lon: tx.lon ?? null,
    notes: tx.notes ?? null
  })
  return Number(result.lastInsertRowid)
}

function getTransmission (db, id) {
  const stmt = db.prepare('SELECT * FROM transmissions WHERE id = ?')
  return stmt.get(id) || null
}

function listTransmissions (db, { channelNr, from, to, direction, limit = 200, offset = 0 } = {}) {
  const clauses = []
  const params = {}
  if (channelNr !== undefined) {
    clauses.push('channel_nr = @channelNr')
    params.channelNr = channelNr
  }
  if (from !== undefined) {
    clauses.push('start_ts >= @from')
    params.from = from
  }
  if (to !== undefined) {
    clauses.push('start_ts <= @to')
    params.to = to
  }
  if (direction !== undefined) {
    clauses.push('direction = @direction')
    params.direction = direction
  }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''
  params.limit = limit
  params.offset = offset
  const stmt = db.prepare(`
    SELECT * FROM transmissions
    ${where}
    ORDER BY start_ts DESC
    LIMIT @limit OFFSET @offset
  `)
  return stmt.all(params)
}

function deleteTransmission (db, id) {
  const stmt = db.prepare('DELETE FROM transmissions WHERE id = ?')
  stmt.run(id)
}

// Set once transcription (via the optional signalk-wyoming ASR service)
// completes. Null until then, and permanently null if transcription is
// never run — this plugin never blocks on it.
function setTranscript (db, id, transcript) {
  const stmt = db.prepare('UPDATE transmissions SET transcript = @transcript WHERE id = @id')
  stmt.run({ id, transcript })
}

// Oldest-first transmissions, for retention pruning.
function listOldestTransmissions (db, limit) {
  const stmt = db.prepare('SELECT * FROM transmissions ORDER BY start_ts ASC LIMIT @limit')
  return stmt.all({ limit })
}

module.exports = {
  openDb,
  insertTransmission,
  getTransmission,
  listTransmissions,
  deleteTransmission,
  listOldestTransmissions,
  setTranscript
}
