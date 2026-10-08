'use strict'

const fs = require('fs')
const path = require('path')
const db = require('./db')
const { rawPathToWavPath } = require('./rtpAudio')

function dirSizeBytes (dir) {
  let total = 0
  let entries
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch (e) {
    return 0
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      total += dirSizeBytes(full)
    } else {
      try {
        total += fs.statSync(full).size
      } catch (e) {
        // file may have been removed concurrently; skip
      }
    }
  }
  return total
}

function deleteTransmissionAndFile (database, tx) {
  if (tx.audio_path) {
    // Both the raw (forensic) and decoded WAV files, written together at
    // capture time, must be removed together too.
    for (const filePath of [tx.audio_path, rawPathToWavPath(tx.audio_path)]) {
      try {
        fs.unlinkSync(filePath)
      } catch (e) {
        // already gone; nothing to clean up
      }
    }
  }
  db.deleteTransmission(database, tx.id)
}

// Enforces both limits independently, oldest-first. Either limit can be
// disabled by passing 0/undefined. Runs age-based pruning first, then
// re-checks size (an aged-out transmission also frees space).
function enforce (database, recordingsDir, { retentionDays, retentionMaxSizeMB } = {}) {
  let deleted = 0

  if (retentionDays && retentionDays > 0) {
    const cutoff = Date.now() - retentionDays * 24 * 60 * 60 * 1000
    const batch = db.listOldestTransmissions(database, 1000)
    for (const tx of batch) {
      if (tx.start_ts >= cutoff) break
      deleteTransmissionAndFile(database, tx)
      deleted++
    }
  }

  if (retentionMaxSizeMB && retentionMaxSizeMB > 0) {
    const maxBytes = retentionMaxSizeMB * 1024 * 1024
    let currentSize = dirSizeBytes(recordingsDir)
    while (currentSize > maxBytes) {
      const oldest = db.listOldestTransmissions(database, 1)
      if (oldest.length === 0) break
      const tx = oldest[0]
      const freed = tx.file_bytes || 0
      deleteTransmissionAndFile(database, tx)
      deleted++
      currentSize -= freed
      // If file_bytes wasn't tracked for this row, re-measure to avoid an infinite loop.
      if (!freed) currentSize = dirSizeBytes(recordingsDir)
    }
  }

  return { deleted }
}

module.exports = { enforce, dirSizeBytes }
