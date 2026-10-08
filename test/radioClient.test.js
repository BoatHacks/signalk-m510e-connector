const test = require('node:test')
const assert = require('node:assert')
const RadioClient = require('../lib/radioClient')
const protocol = require('../lib/protocol')

// Synthetic packets matching lib/protocol.js's parseChannelStatus offsets:
// response-type at [17], channel number little-endian at [26,27], squelch
// at [34], busy at [35].
function statusPacket ({ channelNr, busy }) {
  const buf = Buffer.alloc(36)
  buf[17] = protocol.CHANNEL_STATUS_RESPONSE_TYPE
  buf[26] = channelNr & 0xff
  buf[27] = (channelNr >> 8) & 0xff
  buf[34] = 0
  buf[35] = busy ? 0x80 : 0x00
  return buf
}

test('a dual-watch update for an idle channel does not close an active transmission', (t) => {
  const rc = new RadioClient()
  const events = []
  rc.on('tx-start', (e) => events.push({ type: 'tx-start', channelNr: e.channelNr }))
  rc.on('tx-end', () => events.push({ type: 'tx-end' }))

  rc._onServerCMessage(statusPacket({ channelNr: 84, busy: true })) // tx-start
  rc._onServerCMessage(statusPacket({ channelNr: 93, busy: true })) // scanned to other channel, also busy — ignored
  rc._onServerCMessage(statusPacket({ channelNr: 93, busy: false })) // other channel idle — must not end channel 84's tx
  assert.deepStrictEqual(events, [{ type: 'tx-start', channelNr: 84 }])
  assert.strictEqual(rc.busy, true)
})

test('a brief squelch-closed blip on the active channel is debounced, not treated as tx-end', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const rc = new RadioClient({ busyDebounceMs: 200 })
  const events = []
  rc.on('tx-start', (e) => events.push({ type: 'tx-start', channelNr: e.channelNr }))
  rc.on('tx-end', () => events.push({ type: 'tx-end' }))

  rc._onServerCMessage(statusPacket({ channelNr: 84, busy: true }))
  rc._onServerCMessage(statusPacket({ channelNr: 84, busy: false })) // brief blip
  t.mock.timers.tick(50) // well under the 200ms debounce
  rc._onServerCMessage(statusPacket({ channelNr: 84, busy: true })) // resumes — should cancel the pending end
  t.mock.timers.tick(300) // past the debounce window, nothing pending now

  assert.deepStrictEqual(events, [{ type: 'tx-start', channelNr: 84 }])
  assert.strictEqual(rc.busy, true)
})

test('a squelch-closed reading that outlasts the debounce window ends the transmission', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const rc = new RadioClient({ busyDebounceMs: 200 })
  const events = []
  rc.on('tx-start', (e) => events.push({ type: 'tx-start', channelNr: e.channelNr }))
  rc.on('tx-end', () => events.push({ type: 'tx-end' }))

  rc._onServerCMessage(statusPacket({ channelNr: 84, busy: true }))
  rc._onServerCMessage(statusPacket({ channelNr: 84, busy: false }))
  t.mock.timers.tick(201)

  assert.deepStrictEqual(events, [{ type: 'tx-start', channelNr: 84 }, { type: 'tx-end' }])
  assert.strictEqual(rc.busy, false)
})

// A RadioClient whose sockets just record what would be sent, so the
// post-login request sequence can be checked without a network.
function recordingClient (opts) {
  const rc = new RadioClient({ bindAddress: '10.42.23.1', ...opts })
  rc.myIP = '10.42.23.1'
  rc.radio = { ip: '10.42.23.78', port: 50000 }
  rc._stopped = false
  const sent = []
  for (const name of ['_serverA', '_serverB', '_serverC']) {
    rc[name].send = (msg, off, len, port, addr, cb) => { sent.push({ sock: name, hex: msg.toString('hex'), port, addr }); if (cb) cb() }
  }
  return { rc, sent }
}

const HB = { address: '10.42.23.78', port: 50002 }

test('first radio heartbeat starts the read-only request sequence with the reference timing', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] })
  const { rc, sent } = recordingClient()

  rc._onServerBMessage(Buffer.alloc(20), HB)
  assert.strictEqual(sent.length, 1) // table part 1, immediately, on A -> sign-in port
  assert.strictEqual(sent[0].sock, '_serverA')
  assert.strictEqual(sent[0].port, 50000)
  assert.ok(sent[0].hex.endsWith('0004000004000000' + '00000000'))

  t.mock.timers.tick(2000)
  assert.strictEqual(sent.length, 2) // part 2
  assert.strictEqual(sent[1].sock, '_serverA')

  t.mock.timers.tick(2000)
  assert.strictEqual(sent.length, 4) // ask-channel + status query, on C -> 50003
  assert.deepStrictEqual(sent.slice(2).map((s) => [s.sock, s.port]), [['_serverC', 50003], ['_serverC', 50003]])
  rc.stop()
})

test('the request sequence runs once, not on every heartbeat', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] })
  const { rc, sent } = recordingClient()
  rc._onServerBMessage(Buffer.alloc(20), HB)
  rc._onServerBMessage(Buffer.alloc(20), HB)
  rc._onServerBMessage(Buffer.alloc(20), HB)
  t.mock.timers.tick(4000)
  assert.strictEqual(sent.length, 4)
  rc.stop()
})

test('keepalives go back to the heartbeat source (port 50002), not the sign-in port', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] })
  const { rc, sent } = recordingClient()
  rc._onServerBMessage(Buffer.alloc(20), HB)
  sent.length = 0
  t.mock.timers.tick(5000)
  const keepalives = sent.filter((s) => s.hex === '800100')
  assert.strictEqual(keepalives.length, 1)
  assert.deepStrictEqual([keepalives[0].sock, keepalives[0].port, keepalives[0].addr], ['_serverB', 50002, '10.42.23.78'])
  rc.stop()
})

test('stop() cancels pending requests', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] })
  const { rc, sent } = recordingClient()
  rc._onServerBMessage(Buffer.alloc(20), HB)
  rc.stop()
  t.mock.timers.tick(10000)
  assert.strictEqual(sent.length, 1) // only the immediate part 1
})
