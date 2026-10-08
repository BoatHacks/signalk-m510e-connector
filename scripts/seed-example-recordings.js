#!/usr/bin/env node
'use strict'

// Feeds the example test phrases (scripts/examples/*-whisper-input.wav)
// into a running plugin's recording log, as if RadioClient had captured
// them from a real radio — writes a framed-RTP .raw file into the
// recordings dir and inserts a matching row into radio-log.sqlite, using
// the exact same on-disk format lib/rtpAudio.js/lib/db.js produce for a
// real transmission.
//
// Dev/demo tool only, not part of the plugin runtime. Requires Node
// >=22.5.0 (node:sqlite), same as the plugin itself.
//
// IMPORTANT: every inserted row's `notes` field is marked
// "SYNTHETIC TEST DATA" — these are fake Mayday/Pan-pan/Securite calls
// (Piper text-to-speech, not a real radio), and must never be mistaken
// for a real distress call in the log.
//
// Usage: node scripts/seed-example-recordings.js --data-dir <path>
// <path> is the plugin's data directory (what app.getDataDirPath()
// returns) — e.g. ~/.signalk/plugin-config-data/signalk-m510e-connector
// on a real Signal K install.

const fs = require('fs')
const path = require('path')
const db = require('../lib/db')
const { frameRtpPackets } = require('../lib/rtpAudio')
const { pcm16ToMuLaw, muLawToFakeRtpPackets } = require('./testAudioHelpers')

const EXAMPLES_DIR = path.join(__dirname, 'examples')
const CHANNEL_NR = 16 // international calling/distress channel — realistic for these phrases

const CASES = [
  { name: 'mayday-single', text: 'Mayday.' },
  { name: 'mayday-triple', text: 'Mayday mayday mayday.' },
  { name: 'panpan-triple', text: 'Pan-pan pan-pan pan-pan.' },
  { name: 'securite-triple', text: 'Securite securite securite.' },
]

function readWavPcm (filePath) {
  const buf = fs.readFileSync(filePath)
  if (buf.subarray(0, 4).toString('ascii') !== 'RIFF') throw new Error(`${filePath}: not a RIFF/WAVE file`)
  const sampleRate = buf.readUInt32LE(24)
  const pcm = buf.subarray(44)
  return { pcm, sampleRate }
}

function parseArgs (argv) {
  const args = {}
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--data-dir') args.dataDir = argv[++i]
  }
  if (!args.dataDir) {
    console.error('Usage: node scripts/seed-example-recordings.js --data-dir <plugin-data-dir>')
    process.exit(1)
  }
  return args
}

function main () {
  const { dataDir } = parseArgs(process.argv.slice(2))
  const recordingsDir = path.join(dataDir, 'recordings')
  fs.mkdirSync(recordingsDir, { recursive: true })
  const database = db.openDb(path.join(dataDir, 'radio-log.sqlite'))

  const now = Date.now()
  CASES.forEach(({ name, text }, i) => {
    const wavPath = path.join(EXAMPLES_DIR, `${name}-whisper-input.wav`)
    const { pcm, sampleRate } = readWavPcm(wavPath)
    if (sampleRate !== 8000) throw new Error(`${wavPath}: expected 8000Hz (already radio-path-simulated), got ${sampleRate}`)

    const muLaw = pcm16ToMuLaw(pcm)
    const rtpPackets = muLawToFakeRtpPackets(muLaw)
    const framed = frameRtpPackets(rtpPackets)

    const durationMs = Math.round((pcm.length / 2 / sampleRate) * 1000)
    const startTs = now - (CASES.length - i) * 5 * 60 * 1000 // 5 minutes apart, oldest first
    const endTs = startTs + durationMs
    const fileName = `${startTs}-ch${CHANNEL_NR}.raw`
    const audioPath = path.join(recordingsDir, fileName)
    fs.writeFileSync(audioPath, framed)

    const id = db.insertTransmission(database, {
      direction: 'rx',
      channelNr: CHANNEL_NR,
      startTs,
      endTs,
      durationMs,
      audioPath,
      fileBytes: framed.length,
      squelch: null,
      lat: null,
      lon: null,
      notes: `SYNTHETIC TEST DATA — Piper TTS, not a real radio. Said: "${text}"`,
    })
    console.log(`inserted #${id}: ${name} (${durationMs}ms) -> ${audioPath}`)
  })

  database.close()
}

main()
