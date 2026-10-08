const test = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const path = require('path')
const { readUdpPackets } = require('./helpers/pcap')
const protocol = require('../lib/protocol')
const RadioClient = require('../lib/radioClient')
const { frameRtpPackets, unframeRtpPackets, rtpPcmuPacketsToWav, extractMuLawPayload, muLawToPcm16 } = require('../lib/rtpAudio')

// Replays tools/capture-spike/capture.sanitized.pcap — a real WiFi capture
// of an M510E session — through the protocol/radioClient layer directly
// (bypassing sockets), so Phase 1 parsing logic can be checked against real
// bytes without a live radio. See CHANGELOG.md "Phase 0 findings".

const PCAP_PATH = path.join(__dirname, '..', 'tools', 'capture-spike', 'capture.sanitized.pcap')
const RADIO_IP = '192.168.1.146'

function loadCapture () {
  const buf = fs.readFileSync(PCAP_PATH)
  return readUdpPackets(buf)
}

test('RTP voice stream: no dropped or reordered packets across the capture', () => {
  const pkts = loadCapture()
  const voice = pkts.filter((p) => p.srcIp === RADIO_IP && p.srcPort === 50001)
  assert.ok(voice.length > 0, 'capture should contain RTP voice packets')

  let prevSeq = null
  let prevTs = null
  for (const p of voice) {
    const rtp = p.payload
    assert.strictEqual(rtp[0] >> 6, 2, 'RTP version should be 2')
    assert.strictEqual(rtp[1] & 0x7f, 0, 'payload type should be 0 (PCMU/G.711 mu-law)')
    const seq = rtp.readUInt16BE(2)
    const ts = rtp.readUInt32BE(4)
    if (prevSeq !== null) {
      assert.strictEqual((seq - prevSeq) & 0xffff, 1, 'sequence should increment by 1')
      assert.strictEqual(ts - prevTs, 320, 'RTP timestamp should advance by 320 samples (40ms @ 8kHz)')
    }
    prevSeq = seq
    prevTs = ts
  }
})

test('storage round-trip: frame -> write -> unframe -> decode reproduces the real captured voice as a valid, non-silent WAV', () => {
  const pkts = loadCapture()
  const voice = pkts
    .filter((p) => p.srcIp === RADIO_IP && p.srcPort === 50001)
    .map((p) => p.payload)

  // Exercises the same path production code takes: frame for on-disk
  // ("forensic") storage, then unframe and decode on demand when the
  // /audio route is hit, rather than decoding the packet list directly.
  const framed = frameRtpPackets(voice)
  const recovered = unframeRtpPackets(framed)
  assert.strictEqual(recovered.length, voice.length)
  const wav = rtpPcmuPacketsToWav(recovered)

  assert.strictEqual(wav.subarray(0, 4).toString('ascii'), 'RIFF')
  assert.strictEqual(wav.subarray(8, 12).toString('ascii'), 'WAVE')
  assert.strictEqual(wav.readUInt32LE(24), 8000) // sample rate
  const expectedMuLawBytes = voice.reduce((sum, p) => sum + (p.length - 12), 0)
  assert.strictEqual(wav.readUInt32LE(40), expectedMuLawBytes * 2) // 16-bit PCM = 2 bytes/sample

  // Confirms this is decoded real speech, not silence/comfort noise: PCM
  // samples should have real variance, matching the manual decode from
  // when this capture was first analyzed (see conversation history).
  const pcm = wav.subarray(44)
  let sumSquares = 0
  const sampleCount = pcm.length / 2
  for (let i = 0; i < pcm.length; i += 2) {
    const sample = pcm.readInt16LE(i)
    sumSquares += sample * sample
  }
  const rms = Math.sqrt(sumSquares / sampleCount)
  assert.ok(rms > 100, `expected non-trivial RMS for real speech, got ${rms}`)
})

test('transcription decode path (extractMuLawPayload + muLawToPcm16) matches the WAV decode of the same capture', () => {
  // POST /transmissions/:id/transcribe decodes straight to raw PCM for the
  // Wyoming ASR service, skipping pcm16ToWav's RIFF header — confirms that
  // path produces byte-identical PCM to the already-verified WAV decode
  // above, not just "doesn't crash".
  const pkts = loadCapture()
  const voice = pkts
    .filter((p) => p.srcIp === RADIO_IP && p.srcPort === 50001)
    .map((p) => p.payload)

  const framed = frameRtpPackets(voice)
  const recovered = unframeRtpPackets(framed)
  const pcmForTranscription = muLawToPcm16(extractMuLawPayload(recovered))

  const wav = rtpPcmuPacketsToWav(recovered)
  const pcmFromWav = wav.subarray(44)

  assert.ok(pcmForTranscription.equals(pcmFromWav))
})

test('parseChannelStatus: real 28-byte ack packets are correctly rejected, 40-byte status packets parse', () => {
  const pkts = loadCapture()
  const status = pkts.filter((p) => p.srcIp === RADIO_IP && p.srcPort === 50003)
  const byLength = {}
  for (const p of status) {
    byLength[p.payload.length] = (byLength[p.payload.length] || 0) + 1
  }
  // CHANNEL_CMD_PORT (50003) carries two distinct real packet shapes: a
  // 28-byte ack/heartbeat (response-type byte [17] === 0x01, no channel
  // data) and a 40-byte channel-status response (type 0x02, parsed by
  // parseChannelStatus). See lib/protocol.js.
  assert.ok(byLength[28] > 0, 'capture should contain 28-byte ack packets')
  assert.ok(byLength[40] > 0, 'capture should contain 40-byte status packets')

  for (const p of status) {
    const parsed = protocol.parseChannelStatus(p.payload)
    if (p.payload.length === 28) {
      assert.strictEqual(parsed, null)
    } else if (p.payload.length === 40) {
      assert.notStrictEqual(parsed, null)
    }
  }
})

test('busy-flag replay: one continuous RX transmission stays a single tx-start/tx-end cycle', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })

  const pkts = loadCapture()
  const statusPkts = pkts
    .filter((p) => p.srcIp === RADIO_IP && p.srcPort === 50003)
    .map((p) => ({ ...p, kind: 'status' }))
  const voicePkts = pkts
    .filter((p) => p.srcIp === RADIO_IP && p.srcPort === 50001)
    .map((p) => ({ ...p, kind: 'voice' }))
  const merged = [...statusPkts, ...voicePkts].sort((a, b) => a.ts - b.ts)

  const rc = new RadioClient()
  const events = []
  rc.on('tx-start', (e) => events.push({ type: 'tx-start', channelNr: e.channelNr }))
  rc.on('tx-end', (e) => events.push({ type: 'tx-end' }))
  let voiceDataCount = 0
  rc.on('voice-data', () => { voiceDataCount++ })

  // Replay at real historical pacing so the debounce timer (real
  // setTimeout, mocked here) sees the same gaps the radio actually
  // produced, instead of a synchronous burst.
  let lastTs = merged[0].ts
  for (const p of merged) {
    t.mock.timers.tick(Math.round((p.ts - lastTs) * 1000))
    lastTs = p.ts
    if (p.kind === 'status') {
      rc._onServerCMessage(p.payload)
    } else {
      rc._onVoiceMessage(p.payload)
    }
  }
  // Let any pending debounce timer fire.
  t.mock.timers.tick(rc._busyDebounceMs + 1)

  // The dual-watch scan (channel 84/93) and the ~50ms squelch blips on
  // the active channel itself no longer fragment the transmission — see
  // the Phase 0 "busy-flag replay" finding in CHANGELOG.md. The capture
  // ends mid-transmission (no closing squelch packet was captured), so
  // there's exactly one tx-start and no tx-end.
  assert.deepStrictEqual(events, [{ type: 'tx-start', channelNr: 28 }]) // status index 84 = channel 28, mode 0
  assert.strictEqual(rc.busy, true)

  // No RTP packets are lost either.
  assert.strictEqual(voiceDataCount, voicePkts.length)
})
