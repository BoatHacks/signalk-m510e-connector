'use strict'

// Icom M510E/CT-M500 WiFi protocol constants and pure encode/decode helpers.
//
// Reverse-engineered by GitHub user htool, not an Icom spec:
//   https://github.com/htool/signalk-icom-m510e-plugin
//   https://github.com/htool/signalk-icom-ct-m500-plugin
//
// Kept separate from RadioClient so every function here can be unit
// tested without a socket or real hardware.

const ICOM_HEX = '49636f6d' // ASCII "Icom" — magic prefix on every packet
const RS_M500_HEX = '52532d4d353030' // ASCII "RS-M500" — client identity we sign in as
const DISCOVERY_PORT = 50000
const CHANNEL_CMD_PORT = 50003

function ip2hex (addr) {
  const parts = addr.split('.')
  if (parts.length !== 4) throw new Error(`not an IPv4 address: ${addr}`)
  return parts
    .map((n) => {
      const v = parseInt(n, 10)
      if (!Number.isInteger(v) || v < 0 || v > 255) throw new Error(`not an IPv4 address: ${addr}`)
      return ('00' + v.toString(16)).slice(-2)
    })
    .reverse()
    .join('')
}

function port2hex (port) {
  if (!Number.isInteger(port) || port < 0 || port > 0xffff) throw new Error(`not a valid port: ${port}`)
  const hex = ('0000' + port.toString(16)).slice(-4)
  // byte-swap: htool's plugins consistently do porthex[2,3,0,1]
  return hex[2] + hex[3] + hex[0] + hex[1]
}

function buildDiscoveryPacket ({ myIP, listenPortA }) {
  const portHex = port2hex(listenPortA)
  return Buffer.from(
    ICOM_HEX + '01ff0000' + ip2hex(myIP) + 'ffffffff' + '0000000004000000' + portHex + '0000',
    'hex'
  )
}

function buildSignInPacket ({ myIP, radioIP, ports }) {
  const { d, voice, b, c, e } = ports
  return Buffer.from(
    ICOM_HEX + '01ff0000' + ip2hex(myIP) + ip2hex(radioIP) +
    '00020000380000000200' +
    port2hex(d) + port2hex(voice) + port2hex(b) + port2hex(c) + port2hex(e) +
    RS_M500_HEX +
    '00000042134195000000000000000000000000000000000000000000000000000000000000',
    'hex'
  )
}

function buildKeepAlivePacket () {
  return Buffer.from('8001004', 'hex')
}

// Generic "Icom" frame, as seen on the wire and as sent by htool's current
// plugin (https://github.com/htool/signalk-icom-m510e-plugin, protocol.js):
//   "Icom" | 0x01 | marker | 0x00 0x00 | srcIP | dstIP | command u32le |
//   bodyLength u32le | body
// srcIP/dstIP use ip2hex's reversed octet order.
const MARKER_PLAIN = 0x00
const MARKER_OPERATION = 0x02
const COMMAND_CHANNEL_TABLE = 0x00000400
const COMMAND_ASK_CHANNEL = 0x00000301
const COMMAND_STATUS = 0x00000201

function buildFrame ({ myIP, radioIP, marker, command, body = Buffer.alloc(0) }) {
  const header = Buffer.alloc(24)
  header.write('Icom', 0, 'ascii')
  header[4] = 0x01
  header[5] = marker
  Buffer.from(ip2hex(myIP), 'hex').copy(header, 8)
  Buffer.from(ip2hex(radioIP), 'hex').copy(header, 12)
  header.writeUInt32LE(command, 16)
  header.writeUInt32LE(body.length, 20)
  return Buffer.concat([header, body])
}

// Read-only post-login requests. Without them the radio signs us in and
// sends heartbeats but never pushes channel status or voice (confirmed
// against a live radio). Deliberately no builders for anything that
// changes radio state (channel change, squelch, PTT, intercom).

// The channel table comes in two parts: the first (body 00 00 00 00) is
// answered with ~10 properties frames (cmd 0x500) on our data port.
function buildChannelTableRequest ({ myIP, radioIP, part }) {
  const body = part === 1 ? Buffer.from([0x00, 0x00, 0x00, 0x00]) : Buffer.from([0x01, 0x00])
  return buildFrame({ myIP, radioIP, marker: MARKER_PLAIN, command: COMMAND_CHANNEL_TABLE, body })
}

function buildAskChannelPacket ({ myIP, radioIP }) {
  return buildFrame({ myIP, radioIP, marker: MARKER_PLAIN, command: COMMAND_ASK_CHANNEL })
}

// Empty status query (the operation-marker frame with command STATUS and
// no body, which RS-M500 sends alongside the ask-channel frame).
function buildQueryStatusPacket ({ myIP, radioIP }) {
  return buildFrame({ myIP, radioIP, marker: MARKER_OPERATION, command: COMMAND_STATUS })
}

// Port CHANNEL_CMD_PORT carries two distinct response shapes, both
// "Icom"-prefixed, distinguished by the response-type byte at [17]:
//   0x01 — a short (28-byte) ack/heartbeat, no channel data at all
//   0x02 — the full (40-byte) channel-status response this function parses
// Confirmed against a real capture (tools/capture-spike/capture.sanitized.pcap):
// every real status response was exactly 40 bytes with [17] === 0x02, and
// every 28-byte response had [17] === 0x01. The `msg.length < 36` guard
// below is a safety bound for the byte reads, not the actual packet-type
// discriminator — that's checked explicitly via [17].
//
// Byte offsets per htool's getChannel(): channel number is a little-endian
// pair at [26,27], squelch/busy flag is byte [34]/[35] (0x80 = busy).
const CHANNEL_STATUS_RESPONSE_TYPE = 0x02

function parseChannelStatus (msg) {
  if (!Buffer.isBuffer(msg) || msg.length < 36) return null
  if (msg[17] !== CHANNEL_STATUS_RESPONSE_TYPE) return null
  const channelNr = (msg[27] << 8) + msg[26]
  const squelchByte = msg[34]
  const busy = msg[35] === 128
  return { busy, channelNr, squelch: squelchByte }
}

module.exports = {
  ICOM_HEX,
  RS_M500_HEX,
  DISCOVERY_PORT,
  CHANNEL_CMD_PORT,
  CHANNEL_STATUS_RESPONSE_TYPE,
  ip2hex,
  port2hex,
  buildDiscoveryPacket,
  buildSignInPacket,
  buildKeepAlivePacket,
  buildChannelTableRequest,
  buildAskChannelPacket,
  buildQueryStatusPacket,
  parseChannelStatus
}
