const test = require('node:test')
const assert = require('node:assert')
const path = require('path')
const { pathToFileURL } = require('url')

const helpers = () => import(pathToFileURL(path.join(__dirname, '..', 'public', 'js', 'helpers.js')).href)

test('positions are signed decimal degrees, zero-padded: +dd.ddddd and +ddd.ddddd', async () => {
  const { formatPositionLines } = await helpers()
  assert.deepStrictEqual(formatPositionLines(40.616726, 0.596472), ['+40.61673', '+000.59647'])
  assert.deepStrictEqual(formatPositionLines(-33.86, -151.2), ['-33.86000', '-151.20000'])
  assert.deepStrictEqual(formatPositionLines(5.5, -9.25), ['+05.50000', '-009.25000'])
})

test('a position that rounds to zero is not shown as negative zero, and unknown positions are null', async () => {
  const { formatPositionLines } = await helpers()
  assert.deepStrictEqual(formatPositionLines(-0.000001, 0), ['+00.00000', '+000.00000'])
  assert.strictEqual(formatPositionLines(null, 1), null)
  assert.strictEqual(formatPositionLines(1, undefined), null)
})
