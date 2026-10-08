const test = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const os = require('os')
const path = require('path')
const createPlugin = require('../index.js')

function fakeApp (dataDir, opts) {
  const handledMessages = (opts && opts.handledMessages) || []
  return {
    debug: () => {},
    error: () => {},
    getDataDirPath: () => dataDir,
    getSelfPath: () => undefined,
    handleMessage: (pluginId, delta) => { handledMessages.push({ pluginId, delta }) },
  }
}

function tempDataDir () {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'radio-log-plugin-test-'))
}

test('exposes standard SignalK plugin metadata', () => {
  const plugin = createPlugin(fakeApp(tempDataDir()))
  assert.strictEqual(plugin.id, 'signalk-m510e-connector')
  assert.strictEqual(typeof plugin.name, 'string')
  assert.strictEqual(typeof plugin.description, 'string')
  assert.strictEqual(typeof plugin.start, 'function')
  assert.strictEqual(typeof plugin.stop, 'function')
})

test('exposes a config schema with retention options', () => {
  const plugin = createPlugin(fakeApp(tempDataDir()))
  assert.ok(plugin.schema.properties.ipOverride)
  assert.ok(plugin.schema.properties.retentionDays)
  assert.ok(plugin.schema.properties.retentionMaxSizeMB)
})

test('start creates the data dir structure and stop cleans up without throwing', () => {
  const dataDir = tempDataDir()
  const plugin = createPlugin(fakeApp(dataDir))
  assert.doesNotThrow(() => plugin.start({ ipOverride: '127.0.0.1', retentionDays: 0, retentionMaxSizeMB: 0 }))
  assert.ok(fs.existsSync(path.join(dataDir, 'recordings')))
  assert.ok(fs.existsSync(path.join(dataDir, 'radio-log.sqlite')))
  assert.doesNotThrow(() => plugin.stop())
})

test('start emits an initial communication.vhf.recording.status = idle delta', () => {
  const dataDir = tempDataDir()
  const handledMessages = []
  const plugin = createPlugin(fakeApp(dataDir, { handledMessages }))
  plugin.start({ ipOverride: '127.0.0.1' })

  const recordingDeltas = handledMessages.filter((m) =>
    m.delta.updates[0].values[0].path === 'communication.vhf.recording.status'
  )
  assert.strictEqual(recordingDeltas.length, 1)
  assert.strictEqual(recordingDeltas[0].pluginId, 'signalk-m510e-connector')
  assert.strictEqual(recordingDeltas[0].delta.updates[0].values[0].value, 'idle')

  plugin.stop()
})

test('registerWithRouter exposes /status and /transmissions backed by real state', () => {
  const dataDir = tempDataDir()
  const plugin = createPlugin(fakeApp(dataDir))
  plugin.start({ ipOverride: '127.0.0.1' })

  const routes = {}
  const router = {
    get: (routePath, handler) => {
      routes[`GET ${routePath}`] = handler
    },
    post: (routePath, handler) => {
      routes[`POST ${routePath}`] = handler
    },
  }
  plugin.registerWithRouter(router)
  assert.strictEqual(typeof routes['GET /status'], 'function')
  assert.strictEqual(typeof routes['GET /transmissions'], 'function')
  assert.strictEqual(typeof routes['GET /transmissions/:id'], 'function')
  assert.strictEqual(typeof routes['GET /transmissions/:id/audio'], 'function')
  assert.strictEqual(typeof routes['POST /transmissions/:id/transcribe'], 'function')

  let statusBody = null
  routes['GET /status']({}, { json: (body) => { statusBody = body } })
  assert.strictEqual(statusBody.recording, false)
  assert.strictEqual(statusBody.connected, false)

  let txBody = null
  routes['GET /transmissions']({ query: {} }, { json: (body) => { txBody = body } })
  assert.deepStrictEqual(txBody, [])

  let notFoundStatus = null
  let notFoundBody = null
  routes['GET /transmissions/:id']({ params: { id: '999' } }, {
    status: (code) => { notFoundStatus = code; return { json: (body) => { notFoundBody = body } } },
  })
  assert.strictEqual(notFoundStatus, 404)
  assert.ok(notFoundBody.error)

  plugin.stop()
})

test('transcribe route returns 501 when asrUri is not configured', async () => {
  const dataDir = tempDataDir()
  const plugin = createPlugin(fakeApp(dataDir))
  plugin.start({ ipOverride: '127.0.0.1' }) // no asrUri

  const routes = {}
  const router = { get: (p, h) => { routes[`GET ${p}`] = h }, post: (p, h) => { routes[`POST ${p}`] = h } }
  plugin.registerWithRouter(router)

  let status = null
  let body = null
  await routes['POST /transmissions/:id/transcribe'](
    { params: { id: '1' } },
    { status: (code) => { status = code; return { json: (b) => { body = b } } } }
  )
  assert.strictEqual(status, 501)
  assert.ok(/not configured/.test(body.error))

  plugin.stop()
})

test('sign-in retries and failures from the radio client are logged as errors', (t) => {
  const RadioClient = require('../lib/radioClient')
  let client
  t.mock.method(RadioClient.prototype, 'start', async function () { client = this })
  const errors = []
  const app = { ...fakeApp(tempDataDir()), error: (msg) => errors.push(msg) }
  const plugin = createPlugin(app)
  plugin.start({ ipOverride: '127.0.0.1' })
  client.emit('sign-in-retry', { attempt: 2 })
  client.emit('sign-in-failed', { retries: 3 })
  plugin.stop()
  assert.ok(errors.some((m) => /resending.*attempt 2/.test(m)))
  assert.ok(errors.some((m) => /failed after 3 resends/.test(m)))
})
