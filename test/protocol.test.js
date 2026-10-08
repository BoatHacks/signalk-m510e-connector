const test = require('node:test')
const assert = require('node:assert')
const protocol = require('../lib/protocol')

test('ip2hex byte-reverses each octet', () => {
  assert.strictEqual(protocol.ip2hex('192.168.1.100'), '6401a8c0')
  assert.strictEqual(protocol.ip2hex('0.0.0.0'), '00000000')
  assert.strictEqual(protocol.ip2hex('255.255.255.255'), 'ffffffff')
})

test('ip2hex rejects malformed addresses', () => {
  assert.throws(() => protocol.ip2hex('not-an-ip'))
  assert.throws(() => protocol.ip2hex('1.2.3'))
  assert.throws(() => protocol.ip2hex('1.2.3.256'))
})

test('port2hex byte-swaps and zero-pads', () => {
  assert.strictEqual(protocol.port2hex(50000), '50c3')
  assert.strictEqual(protocol.port2hex(80), '5000')
  assert.strictEqual(protocol.port2hex(0), '0000')
})

test('port2hex rejects out-of-range ports', () => {
  assert.throws(() => protocol.port2hex(-1))
  assert.throws(() => protocol.port2hex(70000))
})

test('buildDiscoveryPacket starts with the Icom magic bytes', () => {
  const pkt = protocol.buildDiscoveryPacket({ myIP: '192.168.1.50', listenPortA: 12345 })
  assert.strictEqual(pkt.subarray(0, 4).toString('hex'), protocol.ICOM_HEX)
})

test('buildSignInPacket embeds the RS-M500 identity string', () => {
  const pkt = protocol.buildSignInPacket({
    myIP: '192.168.1.50',
    radioIP: '192.168.1.1',
    ports: { d: 1, voice: 2, b: 3, c: 4, e: 5 },
  })
  assert.ok(pkt.toString('hex').includes(protocol.RS_M500_HEX))
})

test('buildKeepAlivePacket is stable', () => {
  // Note: the source literal '8001004' has an odd number of hex digits;
  // Buffer.from(..., 'hex') silently drops the trailing nibble, so the
  // real wire packet is 3 bytes (800100), not 3.5. Preserved as-is since
  // it matches the packet htool's original capture actually sent.
  assert.strictEqual(protocol.buildKeepAlivePacket().toString('hex'), '800100')
})

test('parseChannelStatus reads busy flag and channel number', () => {
  const buf = Buffer.alloc(36)
  buf[17] = protocol.CHANNEL_STATUS_RESPONSE_TYPE
  buf[26] = 0x10 // channel low byte
  buf[27] = 0x00 // channel high byte
  buf[34] = 0x01
  buf[35] = 0x80 // busy
  const status = protocol.parseChannelStatus(buf)
  assert.deepStrictEqual(status, { busy: true, channelNr: 0x10, squelch: 0x01 })
})

test('parseChannelStatus reports not-busy', () => {
  const buf = Buffer.alloc(36)
  buf[17] = protocol.CHANNEL_STATUS_RESPONSE_TYPE
  buf[35] = 0x00
  const status = protocol.parseChannelStatus(buf)
  assert.strictEqual(status.busy, false)
})

test('parseChannelStatus returns null for undersized packets', () => {
  assert.strictEqual(protocol.parseChannelStatus(Buffer.alloc(10)), null)
  assert.strictEqual(protocol.parseChannelStatus(null), null)
})

test('parseChannelStatus returns null for the real 28-byte ack/heartbeat response (type 0x01)', () => {
  // Real packet captured on CHANNEL_CMD_PORT — same "Icom" prefix as a
  // status response but response-type byte [17] is 0x01, not 0x02, and
  // it's shorter than a status response besides.
  const buf = Buffer.from(
    '49636f6d010000009201a8c01901a8c0010100000400000003ff0000',
    'hex'
  )
  assert.strictEqual(protocol.parseChannelStatus(buf), null)
})

test('parseChannelStatus returns null for a long-enough buffer with the wrong response type', () => {
  // Guards the [17] discriminator itself, independent of the length
  // check: a buffer that passes the length guard but has response-type
  // 0x01 must still be rejected.
  const buf = Buffer.alloc(40)
  buf[17] = 0x01
  buf[26] = 0x10
  buf[35] = 0x80
  assert.strictEqual(protocol.parseChannelStatus(buf), null)
})

// Expected bytes generated with htool's current encoders
// (signalk-icom-m510e-plugin protocol.js), myIP 10.42.23.1 -> radio 10.42.23.78.
const REQ = { myIP: '10.42.23.1', radioIP: '10.42.23.78' }

test('buildChannelTableRequest matches the reference bytes, part 1 and 2', () => {
  assert.strictEqual(
    protocol.buildChannelTableRequest({ ...REQ, part: 1 }).toString('hex'),
    '49636f6d0100000001172a0a4e172a0a000400000400000000000000'
  )
  assert.strictEqual(
    protocol.buildChannelTableRequest({ ...REQ, part: 2 }).toString('hex'),
    '49636f6d0100000001172a0a4e172a0a00040000020000000100'
  )
})

test('buildAskChannelPacket and buildQueryStatusPacket match the reference bytes', () => {
  assert.strictEqual(protocol.buildAskChannelPacket(REQ).toString('hex'), '49636f6d0100000001172a0a4e172a0a0103000000000000')
  assert.strictEqual(protocol.buildQueryStatusPacket(REQ).toString('hex'), '49636f6d0102000001172a0a4e172a0a0102000000000000')
})

test('protocol exports no builder for anything that changes radio state', () => {
  const writers = Object.keys(protocol).filter((k) => /ptt|setchannel|squelch|intercom|operation|favourite/i.test(k))
  assert.deepStrictEqual(writers, [])
})
