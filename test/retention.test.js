const test = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const os = require('os')
const path = require('path')
const db = require('../lib/db')
const retention = require('../lib/retention')

function setup () {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'radio-log-retention-'))
  const recordingsDir = path.join(dir, 'recordings')
  fs.mkdirSync(recordingsDir)
  const database = db.openDb(path.join(dir, 'test.sqlite'))
  return { dir, recordingsDir, database }
}

function addFixture (database, recordingsDir, { startTs, sizeBytes }) {
  const audioPath = path.join(recordingsDir, `${startTs}.raw`)
  fs.writeFileSync(audioPath, Buffer.alloc(sizeBytes))
  return db.insertTransmission(database, {
    channelNr: 16,
    startTs,
    endTs: startTs + 1000,
    durationMs: 1000,
    audioPath,
    fileBytes: sizeBytes,
  })
}

test('enforce with no limits deletes nothing', () => {
  const { recordingsDir, database } = setup()
  addFixture(database, recordingsDir, { startTs: 1000, sizeBytes: 100 })
  const result = retention.enforce(database, recordingsDir, {})
  assert.strictEqual(result.deleted, 0)
  assert.strictEqual(db.listTransmissions(database, {}).length, 1)
})

test('enforce prunes by age, oldest first', () => {
  const { recordingsDir, database } = setup()
  const now = Date.now()
  const oldId = addFixture(database, recordingsDir, { startTs: now - 40 * 24 * 60 * 60 * 1000, sizeBytes: 10 })
  const recentId = addFixture(database, recordingsDir, { startTs: now - 1 * 24 * 60 * 60 * 1000, sizeBytes: 10 })

  const result = retention.enforce(database, recordingsDir, { retentionDays: 30 })
  assert.strictEqual(result.deleted, 1)
  assert.strictEqual(db.getTransmission(database, oldId), null)
  assert.ok(db.getTransmission(database, recentId))
})

test('enforce prunes by age also removes the audio file', () => {
  const { recordingsDir, database } = setup()
  const now = Date.now()
  const oldId = addFixture(database, recordingsDir, { startTs: now - 40 * 24 * 60 * 60 * 1000, sizeBytes: 10 })
  const tx = db.getTransmission(database, oldId)
  assert.ok(fs.existsSync(tx.audio_path))

  retention.enforce(database, recordingsDir, { retentionDays: 30 })
  assert.strictEqual(fs.existsSync(tx.audio_path), false)
})

test('enforce prunes by age also removes the paired WAV file', () => {
  const { recordingsDir, database } = setup()
  const now = Date.now()
  const oldId = addFixture(database, recordingsDir, { startTs: now - 40 * 24 * 60 * 60 * 1000, sizeBytes: 10 })
  const tx = db.getTransmission(database, oldId)
  const wavPath = tx.audio_path.replace(/\.raw$/, '.wav')
  fs.writeFileSync(wavPath, Buffer.alloc(10))
  assert.ok(fs.existsSync(wavPath))

  retention.enforce(database, recordingsDir, { retentionDays: 30 })
  assert.strictEqual(fs.existsSync(wavPath), false)
})

test('enforce prunes by total size, oldest first, until under budget', () => {
  const { recordingsDir, database } = setup()
  addFixture(database, recordingsDir, { startTs: 1000, sizeBytes: 1024 * 1024 }) // 1MB, oldest
  addFixture(database, recordingsDir, { startTs: 2000, sizeBytes: 1024 * 1024 }) // 1MB
  addFixture(database, recordingsDir, { startTs: 3000, sizeBytes: 1024 * 1024 }) // 1MB, newest

  // Budget of 2MB should force deleting exactly the oldest 1MB entry.
  const result = retention.enforce(database, recordingsDir, { retentionMaxSizeMB: 2 })
  assert.strictEqual(result.deleted, 1)
  const remaining = db.listTransmissions(database, {})
  assert.strictEqual(remaining.length, 2)
  assert.ok(remaining.every((tx) => tx.start_ts !== 1000))
})

test('enforce applies both limits independently', () => {
  const { recordingsDir, database } = setup()
  const now = Date.now()
  addFixture(database, recordingsDir, { startTs: now - 40 * 24 * 60 * 60 * 1000, sizeBytes: 1024 * 1024 })
  addFixture(database, recordingsDir, { startTs: now - 1 * 24 * 60 * 60 * 1000, sizeBytes: 1024 * 1024 })

  const result = retention.enforce(database, recordingsDir, { retentionDays: 30, retentionMaxSizeMB: 0.5 })
  // The age rule removes the 40-day-old entry; the size rule then also
  // has to remove the remaining one to get under 0.5MB.
  assert.strictEqual(result.deleted, 2)
  assert.strictEqual(db.listTransmissions(database, {}).length, 0)
})

test('dirSizeBytes sums files recursively', () => {
  const { recordingsDir } = setup()
  fs.writeFileSync(path.join(recordingsDir, 'a.raw'), Buffer.alloc(100))
  const sub = path.join(recordingsDir, 'sub')
  fs.mkdirSync(sub)
  fs.writeFileSync(path.join(sub, 'b.raw'), Buffer.alloc(50))
  assert.strictEqual(retention.dirSizeBytes(recordingsDir), 150)
})
