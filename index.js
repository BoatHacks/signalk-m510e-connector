// signalk-m510e-connector
//
// Records incoming VHF transmissions from an Icom IC-M510E/CT-M500 over
// WiFi as a searchable SignalK log. RX-only for v1 — outgoing (TX/PTT
// and hailer/PA) audio is a v2 feature, see README.md.
//
// STATUS: the connection layer (discovery/sign-in/keepalive, busy-flag
// transmission boundaries) and RX voice capture are wired up. RX codec
// confirmed as plain RTP/PCMU (G.711 µ-law). Each recording is stored as
// two files at capture time (lib/rtpAudio.js): raw framed RTP (forensic
// — exact captured bytes) and a decoded WAV, both pruned by retention
// together. /audio serves the stored WAV directly — an earlier version
// decoded on every request instead of storing one, which turned out not
// to play reliably in the browser.
// Busy-flag tracking keys off channelNr with a debounce on brief squelch
// drops — see README.md and CHANGELOG.md. Optional speech-to-text: POST
// /transmissions/:id/transcribe sends the decoded PCM straight to a
// Wyoming ASR service (e.g. signalk-whisper via signalk-wyoming) over
// raw TCP (lib/wyomingClient.js) — signalk-wyoming's own REST API only
// records *live* from a satellite mic, not already-recorded audio.
// Disabled unless `asrUri` is configured. Still open, requiring a real
// M510E to resolve:
//
//   - the 200ms busy-flag debounce default is a guess from one sample
//     capture, not tuned against real hardware
//   - whether a 4th silent client disrupts real RS-M500 app sessions
//
// Protocol details (packet shapes, port roles) are reverse-engineered
// from https://github.com/htool/signalk-icom-m510e-plugin and
// https://github.com/htool/signalk-icom-ct-m500-plugin — not an Icom
// spec. See lib/protocol.js for specifics.

const fs = require('fs')
const path = require('path')
const ip = require('ip')
const RadioClient = require('./lib/radioClient')
const db = require('./lib/db')
const retention = require('./lib/retention')
const { frameRtpPackets, unframeRtpPackets, rtpPcmuPacketsToWav, rawPathToWavPath, extractMuLawPayload, muLawToPcm16, SAMPLE_RATE } = require('./lib/rtpAudio')
const { transcribeAudio } = require('./lib/wyomingClient')

module.exports = function (app) {
  const plugin = {
    id: 'signalk-m510e-connector',
    name: 'M510E Connector',
    description:
      'Records incoming VHF transmissions from an Icom IC-M510E/CT-M500 over WiFi as a searchable SignalK log',
  }

  let options = {}
  let radioClient = null
  let database = null
  let recordingsDir = null
  let currentTx = null // { channelNr, mode, startTs, chunks: Buffer[] }
  let radioStatus = { connected: false, ip: null, port: null }

  // communication.vhf.recording.status: a custom (non-spec) SignalK path
  // so other plugins/webapps can see recording state without polling the
  // REST /status endpoint. 'recording' while a transmission is captured,
  // 'idle' otherwise.
  function emitRecordingStatus (value) {
    if (typeof app.handleMessage !== 'function') return
    app.handleMessage(plugin.id, {
      updates: [{ values: [{ path: 'communication.vhf.recording.status', value }] }],
    })
  }

  plugin.schema = {
    type: 'object',
    properties: {
      ipOverride: {
        type: 'string',
        title: 'Radio IP override',
        description:
          'Only needed if this host has more than one network interface and auto-detection picks the wrong one.',
        default: '',
      },
      retentionDays: {
        type: 'number',
        title: 'Retention (days)',
        description: 'Delete recordings older than this many days. 0 = unlimited.',
        default: 30,
      },
      retentionMaxSizeMB: {
        type: 'number',
        title: 'Retention (max total size, MB)',
        description:
          'Delete oldest recordings once the log directory exceeds this size. 0 = unlimited. Applied independently of the age-based limit above — whichever limit is hit first prunes.',
        default: 0,
      },
      asrUri: {
        type: 'string',
        title: 'Speech-to-text service (Wyoming ASR URI)',
        description:
          'Optional. tcp://host:port of a Wyoming ASR service, typically signalk-whisper reached through an optional signalk-wyoming installation on this server. Leave empty to disable transcription — nothing else in this plugin depends on it.',
        default: '',
      },
      asrLanguage: {
        type: 'string',
        title: 'Speech-to-text language hint',
        description: 'Optional language code (e.g. "en") passed to the ASR service. Leave empty to use its default.',
        default: '',
      },
    },
  }

  function finishTransmission (reason, endTs) {
    if (!currentTx) return
    const tx = currentTx
    currentTx = null

    // Two files per transmission: the raw framed RTP (forensic — exact
    // captured bytes, undecoded, length-prefixed so packet boundaries
    // survive on disk) and a decoded WAV, written once here rather than
    // decoded per-request. Both share a basename (rawPathToWavPath) so
    // retention can find/delete the pair from either.
    const rawBuffer = frameRtpPackets(tx.chunks)
    const wavBuffer = rtpPcmuPacketsToWav(tx.chunks)
    const fileName = `${tx.startTs}-ch${tx.channelNr ?? 'unknown'}.raw`
    const audioPath = path.join(recordingsDir, fileName)
    const wavPath = rawPathToWavPath(audioPath)
    try {
      fs.writeFileSync(audioPath, rawBuffer)
      fs.writeFileSync(wavPath, wavBuffer)
    } catch (err) {
      app.error(`Failed writing recording ${audioPath}: ${err.message}`)
      return
    }

    let position = null
    try {
      const pos = app.getSelfPath && app.getSelfPath('navigation.position')
      if (pos && pos.value) position = pos.value
    } catch (err) {
      // position not available; leave null
    }

    const id = db.insertTransmission(database, {
      direction: 'rx',
      channelNr: tx.channelNr,
      mode: tx.mode,
      startTs: tx.startTs,
      endTs,
      durationMs: endTs - tx.startTs,
      audioPath,
      fileBytes: rawBuffer.length + wavBuffer.length,
      lat: position ? position.latitude : null,
      lon: position ? position.longitude : null,
    })
    app.debug(`Recorded transmission #${id} (${reason}), ${rawBuffer.length} raw + ${wavBuffer.length} wav bytes, channel ${tx.channelNr}`)

    try {
      retention.enforce(database, recordingsDir, {
        retentionDays: options.retentionDays,
        retentionMaxSizeMB: options.retentionMaxSizeMB,
      })
    } catch (err) {
      app.error(`Retention enforcement failed: ${err.message}`)
    }
  }

  // Shown in the Signal K admin UI's plugin list; older servers lack it.
  function setStatus (message) {
    if (typeof app.setPluginStatus === 'function') app.setPluginStatus(message)
  }

  plugin.start = function (pluginOptions) {
    options = pluginOptions || {}

    const dataDir = app.getDataDirPath()
    recordingsDir = path.join(dataDir, 'recordings')
    fs.mkdirSync(recordingsDir, { recursive: true })
    database = db.openDb(path.join(dataDir, 'radio-log.sqlite'))

    const bindAddress = options.ipOverride || ip.address()
    app.debug(`Starting radio client, binding to ${bindAddress}`)
    radioClient = new RadioClient({ bindAddress })

    radioClient.on('connected', ({ ip: radioIp, port }) => {
      radioStatus = { connected: true, ip: radioIp, port }
      app.debug(`Radio found at ${radioIp}:${port}`)
      setStatus(`Radio found at ${radioIp}, signing in`)
    })

    radioClient.on('signed-in', ({ ip: radioIp }) => {
      app.debug(`Signed in to radio at ${radioIp}`)
      setStatus(`Signed in to radio at ${radioIp}, listening`)
    })

    radioClient.on('tx-start', ({ channelNr, mode, startTs }) => {
      currentTx = { channelNr, mode, startTs, chunks: [] }
      emitRecordingStatus('recording')
    })

    radioClient.on('voice-data', ({ data }) => {
      if (currentTx) currentTx.chunks.push(data)
    })

    radioClient.on('tx-end', ({ reason, endTs }) => {
      finishTransmission(reason, endTs)
      emitRecordingStatus('idle')
    })

    radioClient.on('sign-in-retry', ({ attempt }) => {
      app.error(`Radio sign-in not confirmed, resending (attempt ${attempt})`)
      setStatus(`Radio sign-in not confirmed, resending (attempt ${attempt})`)
    })

    radioClient.on('sign-in-failed', ({ retries }) => {
      radioStatus = { ...radioStatus, connected: false }
      app.error(`Radio sign-in failed after ${retries} resends, restarting discovery`)
      setStatus('Radio sign-in failed, searching for the radio again')
    })

    radioClient.on('error', (err) => {
      app.error(`Radio client error (${err.server || '?'}): ${err.message}`)
    })

    emitRecordingStatus('idle')
    setStatus('Searching for the radio')

    radioClient.start().catch((err) => {
      app.error(`Failed to start radio client: ${err.message}`)
    })
  }

  plugin.stop = function () {
    app.debug('Plugin stopped')
    if (radioClient) {
      radioClient.stop()
      radioClient = null
    }
    if (database) {
      database.close()
      database = null
    }
    radioStatus = { connected: false, ip: null, port: null }
    if (currentTx) {
      currentTx = null
      emitRecordingStatus('idle')
    }
  }

  plugin.registerWithRouter = function (router) {
    router.get('/status', (req, res) => {
      res.json({
        ...radioStatus,
        recording: !!currentTx,
      })
    })

    router.get('/transmissions', (req, res) => {
      if (!database) return res.json([])
      const query = {}
      if (req.query.channelNr !== undefined) query.channelNr = Number(req.query.channelNr)
      if (req.query.from !== undefined) query.from = Number(req.query.from)
      if (req.query.to !== undefined) query.to = Number(req.query.to)
      if (req.query.direction !== undefined) query.direction = req.query.direction
      if (req.query.limit !== undefined) query.limit = Number(req.query.limit)
      if (req.query.offset !== undefined) query.offset = Number(req.query.offset)
      res.json(db.listTransmissions(database, query))
    })

    router.get('/transmissions/:id', (req, res) => {
      if (!database) return res.status(404).json({ error: 'not found' })
      const tx = db.getTransmission(database, Number(req.params.id))
      if (!tx) return res.status(404).json({ error: 'not found' })
      res.json(tx)
    })

    router.get('/transmissions/:id/audio', (req, res) => {
      if (!database) return res.status(404).json({ error: 'not found' })
      const tx = db.getTransmission(database, Number(req.params.id))
      if (!tx || !tx.audio_path) return res.status(404).json({ error: 'not found' })
      const wavPath = rawPathToWavPath(tx.audio_path)
      if (!fs.existsSync(wavPath)) return res.status(404).json({ error: 'not found' })
      // Serves the WAV written at capture time (finishTransmission), not a
      // per-request decode — sendFile supports Range requests, which some
      // browsers require for an <audio> element to play at all.
      res.sendFile(wavPath)
    })

    // Speech-to-text, via an optional Wyoming ASR service (typically
    // signalk-whisper reached through a signalk-wyoming installation).
    // Not wired to any automatic trigger — the caller decides which
    // transmissions are worth transcribing. 501 (not the usual 503/500)
    // when asrUri is unset, since that's a configuration choice, not a
    // runtime failure.
    router.post('/transmissions/:id/transcribe', async (req, res) => {
      if (!database) return res.status(404).json({ error: 'not found' })
      if (!options.asrUri) {
        return res.status(501).json({ error: 'speech-to-text is not configured (set asrUri in plugin settings)' })
      }
      const tx = db.getTransmission(database, Number(req.params.id))
      if (!tx || !tx.audio_path || !fs.existsSync(tx.audio_path)) {
        return res.status(404).json({ error: 'not found' })
      }

      let pcm
      try {
        const framed = fs.readFileSync(tx.audio_path)
        pcm = muLawToPcm16(extractMuLawPayload(unframeRtpPackets(framed)))
      } catch (err) {
        app.error(`Failed decoding ${tx.audio_path} for transcription: ${err.message}`)
        return res.status(500).json({ error: 'failed to decode audio' })
      }

      try {
        const result = await transcribeAudio({
          uri: options.asrUri,
          pcm,
          sampleRate: SAMPLE_RATE,
          language: options.asrLanguage || undefined,
        })
        db.setTranscript(database, tx.id, result.text)
        res.json({ transcript: result.text, language: result.language })
      } catch (err) {
        app.error(`Transcription failed for transmission #${tx.id}: ${err.message}`)
        res.status(503).json({ error: err.message })
      }
    })
  }

  return plugin
}
