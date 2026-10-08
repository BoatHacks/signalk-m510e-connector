'use strict'

const dgram = require('dgram')
const { EventEmitter } = require('events')
const protocol = require('./protocol')

// RadioClient joins an Icom IC-M510E's WiFi session as a silent client
// (posing as an RS-M500 app, per the sign-in identity field) and tracks
// transmissions via the busy/squelch flag on the channel-status stream.
//
// This does no file I/O — it's a thin protocol layer. Consumers listen
// for events and decide what to persist:
//
//   'connected'      { ip, port }              — radio answered discovery
//   'channel-status'  { busy, channelNr, squelch, raw }
//   'tx-start'        { channelNr, startTs }    — busy flag went high
//   'voice-data'      { data: Buffer }          — raw voice/RTP payload, only while a tx is active
//   'tx-end'          { reason, endTs }         — busy flag went low (or stop() called mid-tx)
//   'error'           Error
//
// Protocol details (packet shapes, port roles) are reverse-engineered,
// not an Icom spec — see lib/protocol.js for sources.
class RadioClient extends EventEmitter {
  constructor ({ bindAddress, busyDebounceMs = 200, tablePart2Ms = 2000, askStatusMs = 4000, signInRetryMs = 3000, signInMaxRetries = 3 } = {}) {
    super()
    this.bindAddress = bindAddress
    this.radio = { ip: null, port: null }
    this.signedIn = false
    this.busy = false
    this._activeChannel = null // channel index (channel * 3 + mode) of the open transmission, or null
    // Debounce for a squelch-closed reading on the active channel before
    // treating it as a real tx-end. The sample capture shows real,
    // continuous speech producing brief (~50ms) not-busy readings between
    // busy ones on the same channel — 200ms gives comfortable margin
    // without materially delaying a genuine tx-end. See the Phase 0
    // "busy-flag replay" finding in CHANGELOG.md.
    this._busyDebounceMs = busyDebounceMs
    this._pendingEnd = null
    // Read-only post-login requests (see _requestChannelTable). Delays match
    // the reference implementation's defaults.
    this._tablePart2Ms = tablePart2Ms
    this._askStatusMs = askStatusMs
    this._requestTimers = []
    this._tableRequested = false
    this._keepAliveTarget = null // {address, port} the radio's heartbeats come from
    // Sign-in watchdog. The radio's discovery reply can be slow (3s to 55s
    // live), and a reply that arrives very late is not followed by a
    // sign-in response. So: resend sign-in a few times, and if the radio
    // still never confirms, go back to discovery for a fresh reply.
    this._signInRetryMs = signInRetryMs
    this._signInMaxRetries = signInMaxRetries
    this._signInConfirmed = false
    this._signInRetries = 0
    this._signInWatchTimer = null
    this._stopped = true

    this._serverA = dgram.createSocket('udp4') // discovery / sign-in
    this._serverB = dgram.createSocket('udp4') // keepalive / session heartbeat
    this._serverC = dgram.createSocket('udp4') // channel status + commands
    this._serverD = dgram.createSocket('udp4') // channel table
    this._serverE = dgram.createSocket('udp4') // NMEA0183 in
    this._serverVoice = dgram.createSocket('udp4') // RTP voice stream

    this._ports = {}
    this._findRadioTimer = null
    this._keepAliveTimer = null

    for (const [name, sock] of Object.entries({
      A: this._serverA,
      B: this._serverB,
      C: this._serverC,
      D: this._serverD,
      E: this._serverE,
      Voice: this._serverVoice
    })) {
      sock.on('error', (err) => this.emit('error', Object.assign(err, { server: name })))
    }

    this._serverA.on('message', (msg, info) => this._onServerAMessage(msg, info))
    this._serverB.on('message', (msg, info) => this._onServerBMessage(msg, info))
    this._serverD.on('message', (msg) => this._onServerDMessage(msg))
    this._serverC.on('message', (msg) => this._onServerCMessage(msg))
    this._serverVoice.on('message', (msg) => this._onVoiceMessage(msg))
  }

  async start () {
    this._stopped = false
    const bind = (sock) =>
      new Promise((resolve, reject) => {
        sock.once('error', reject)
        sock.bind({ address: this.bindAddress }, () => resolve())
      })

    await Promise.all([
      bind(this._serverA),
      bind(this._serverB),
      bind(this._serverC),
      bind(this._serverD),
      bind(this._serverE),
      bind(this._serverVoice)
    ])

    this._serverA.setBroadcast(true)
    this._ports = {
      a: this._serverA.address().port,
      b: this._serverB.address().port,
      c: this._serverC.address().port,
      d: this._serverD.address().port,
      e: this._serverE.address().port,
      voice: this._serverVoice.address().port
    }
    this.myIP = this.bindAddress

    this._findRadioTimer = setInterval(() => this._broadcastDiscovery(), 1000)
    this._broadcastDiscovery()
  }

  stop () {
    this._stopped = true
    if (this._pendingEnd) {
      clearTimeout(this._pendingEnd)
      this._pendingEnd = null
    }
    if (this.busy) {
      this.busy = false
      this._activeChannel = null
      this.emit('tx-end', { reason: 'stopped', endTs: Date.now() })
    }
    clearInterval(this._findRadioTimer)
    clearInterval(this._keepAliveTimer)
    clearInterval(this._signInWatchTimer)
    for (const timer of this._requestTimers) clearTimeout(timer)
    this._requestTimers = []
    for (const sock of [this._serverA, this._serverB, this._serverC, this._serverD, this._serverE, this._serverVoice]) {
      try {
        sock.close()
      } catch (e) {
        // already closed
      }
    }
  }

  _broadcastDiscovery () {
    if (!this.myIP) return
    const msg = protocol.buildDiscoveryPacket({ myIP: this.myIP, listenPortA: this._ports.a })
    this._serverA.send(msg, 0, msg.length, protocol.DISCOVERY_PORT, '255.255.255.255', (err) => {
      if (err) this.emit('error', err)
    })
  }

  _sendSignIn () {
    const msg = protocol.buildSignInPacket({
      myIP: this.myIP,
      radioIP: this.radio.ip,
      ports: { d: this._ports.d, voice: this._ports.voice, b: this._ports.b, c: this._ports.c, e: this._ports.e }
    })
    this._serverA.send(msg, 0, msg.length, this.radio.port, this.radio.ip, (err) => {
      if (err) this.emit('error', err)
    })
  }

  // Keepalives go back to wherever the radio's heartbeat came from (its
  // port 50002), not to the sign-in port 50000 — confirmed against a live
  // radio, where keepalives sent to :50000 drew identity broadcasts to
  // port 60000 instead of being treated as keepalives.
  _sendKeepAlive () {
    if (!this._keepAliveTarget) return
    const msg = protocol.buildKeepAlivePacket()
    this._serverB.send(msg, 0, msg.length, this._keepAliveTarget.port, this._keepAliveTarget.address, () => {})
  }

  // Read-only requests the radio needs before it pushes channel status and
  // voice: channel table part 1 (A -> sign-in port), part 2 after
  // tablePart2Ms, then ask-channel + status query on the control socket
  // (-> CHANNEL_CMD_PORT) after askStatusMs (both measured from part 1,
  // like the reference implementation). Nothing here changes radio state.
  _requestChannelTable () {
    if (this._tableRequested || !this.radio.ip) return
    this._tableRequested = true
    const myIP = this.myIP
    const radioIP = this.radio.ip
    const send = (sock, msg, port) => sock.send(msg, 0, msg.length, port, radioIP, (err) => {
      if (err) this.emit('error', err)
    })

    send(this._serverA, protocol.buildChannelTableRequest({ myIP, radioIP, part: 1 }), this.radio.port)
    this._later(() => send(this._serverA, protocol.buildChannelTableRequest({ myIP, radioIP, part: 2 }), this.radio.port), this._tablePart2Ms)
    this._later(() => {
      send(this._serverC, protocol.buildAskChannelPacket({ myIP, radioIP }), protocol.CHANNEL_CMD_PORT)
      send(this._serverC, protocol.buildQueryStatusPacket({ myIP, radioIP }), protocol.CHANNEL_CMD_PORT)
    }, this._askStatusMs)
  }

  _later (fn, ms) {
    const timer = setTimeout(() => {
      this._requestTimers = this._requestTimers.filter((t) => t !== timer)
      if (!this._stopped) fn()
    }, ms)
    if (typeof timer.unref === 'function') timer.unref()
    this._requestTimers.push(timer)
  }

  _onServerAMessage (msg, info) {
    if (!this.signedIn) {
      clearInterval(this._findRadioTimer)
      this.radio.ip = info.address
      this.radio.port = info.port
      this.signedIn = true
      this.emit('connected', { ip: this.radio.ip, port: this.radio.port })
      this._sendSignIn()
      this._watchSignIn()
    }
  }

  // The radio answers a good sign-in on our data port at once (command
  // 0x300) and then starts heartbeats; either one confirms it.
  _onServerDMessage (msg) {
    if (msg.length >= 24 && msg.readUInt32LE(16) === 0x300) this._confirmSignIn()
  }

  _confirmSignIn () {
    this._signInConfirmed = true
    clearInterval(this._signInWatchTimer)
    this._signInWatchTimer = null
  }

  _watchSignIn () {
    this._signInConfirmed = false
    this._signInRetries = 0
    clearInterval(this._signInWatchTimer)
    this._signInWatchTimer = setInterval(() => {
      if (this._stopped || this._signInConfirmed) return this._confirmSignIn()
      if (this._signInRetries < this._signInMaxRetries) {
        this._signInRetries++
        this.emit('sign-in-retry', { attempt: this._signInRetries })
        this._sendSignIn()
        return
      }
      // The radio never confirmed: forget it and start discovery over.
      this.emit('sign-in-failed', { retries: this._signInRetries })
      this._confirmSignIn()
      this.signedIn = false
      this.radio = { ip: null, port: null }
      this._keepAliveTarget = null
      clearInterval(this._keepAliveTimer)
      this._keepAliveTimer = null
      this._tableRequested = false
      this._findRadioTimer = setInterval(() => this._broadcastDiscovery(), 1000)
      this._broadcastDiscovery()
    }, this._signInRetryMs)
    if (typeof this._signInWatchTimer.unref === 'function') this._signInWatchTimer.unref()
  }

  _onServerBMessage (msg, info) {
    this._confirmSignIn()
    if (!this._keepAliveTarget && info) {
      this._keepAliveTarget = { address: info.address, port: info.port }
    }
    if (!this._keepAliveTimer) {
      this._keepAliveTimer = setInterval(() => this._sendKeepAlive(), 5000)
      this._requestChannelTable()
    }
  }

  // Status updates are keyed by channelNr, not just a bare busy flag: a
  // scanning/dual-watch radio interleaves status packets for multiple
  // channels on the same port, and an idle-channel update must not close
  // out a transmission that's still open on a different channel. A
  // not-busy reading on the *active* channel is also debounced, since
  // real speech produces brief squelch-closed blips between syllables.
  // See the Phase 0 "busy-flag replay" finding in CHANGELOG.md.
  _onServerCMessage (msg) {
    const status = protocol.parseChannelStatus(msg)
    if (!status) return
    if (status.busy) {
      if (this._activeChannel === null) {
        this._activeChannel = status.index
        this.busy = true
        this.emit('tx-start', { channelNr: status.channelNr, mode: status.mode, index: status.index, startTs: Date.now() })
      } else if (status.index === this._activeChannel && this._pendingEnd) {
        clearTimeout(this._pendingEnd)
        this._pendingEnd = null
      }
      // else: busy update for another channel while one is already
      // active — a single RTP stream can only belong to one transmission
      // at a time, so keep tracking the one already open.
    } else if (status.index === this._activeChannel && !this._pendingEnd) {
      this._pendingEnd = setTimeout(() => {
        this._pendingEnd = null
        this._activeChannel = null
        this.busy = false
        this.emit('tx-end', { reason: 'squelch-closed', endTs: Date.now() })
      }, this._busyDebounceMs)
      if (typeof this._pendingEnd.unref === 'function') this._pendingEnd.unref()
    }
    // else: not-busy update for a channel we aren't tracking — e.g. the
    // other side of a dual-watch scan — ignore it for tx-start/tx-end
    // purposes.
    this.emit('channel-status', { ...status, raw: msg })
  }

  _onVoiceMessage (msg) {
    if (this.busy) {
      this.emit('voice-data', { data: msg })
    }
  }
}

module.exports = RadioClient
