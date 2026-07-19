// Unit tests for nact-resolve — no live relays/network. Injects a fake pool +
// fetch so we test the resolution logic, tag/content extraction, fallback, and
// cache deterministically.
import assert from 'node:assert'
import { resolveNactEndpoint, endpointFromEvent, _resetCache } from './nact-resolve.mjs'

const NACTOR_HEX = '20d4f68158d7a633fff5166f36e23ee62b3135b01567bb20114f288e92857df6'
const NPUB = 'npub1' // not used directly; identity passed as hex/nip05 below

function fakePool(ev) {
  return { get: async () => ev, close() {} }
}
const advert = (endpoint, { inContent = false } = {}) => ({
  kind: 31990,
  tags: [['d', 'nactor'], ...(inContent ? [] : [['web', endpoint, 'nactor']])],
  content: inContent ? JSON.stringify({ name: 'Nave Nactor', web: endpoint }) : JSON.stringify({ name: 'Nave Nactor' }),
})

let n = 0, pass = 0
const t = async (name, fn) => { n++; try { await fn(); pass++; console.log(`ok - ${name}`) } catch (e) { console.error(`FAIL - ${name}\n   ${e.message}`) } }

await t('endpointFromEvent reads the web tag', () => {
  assert.equal(endpointFromEvent(advert('https://nact.nave.pub/api')), 'https://nact.nave.pub/api')
})
await t('endpointFromEvent falls back to content.web', () => {
  assert.equal(endpointFromEvent(advert('https://x.example/api', { inContent: true })), 'https://x.example/api')
})
await t('endpointFromEvent returns null when absent', () => {
  assert.equal(endpointFromEvent({ kind: 31990, tags: [['d', 'nactor']], content: '{}' }), null)
})

await t('resolves endpoint from a hex identity', async () => {
  _resetCache()
  const got = await resolveNactEndpoint({ identity: NACTOR_HEX, pool: fakePool(advert('https://nact.nave.pub/api')), fallback: 'FB' })
  assert.equal(got, 'https://nact.nave.pub/api')
})

await t('unset identity returns fallback', async () => {
  _resetCache()
  assert.equal(await resolveNactEndpoint({ identity: '', fallback: 'FB' }), 'FB')
})

await t('no advert found returns fallback', async () => {
  _resetCache()
  assert.equal(await resolveNactEndpoint({ identity: NACTOR_HEX, pool: fakePool(null), fallback: 'FB' }), 'FB')
})

await t('nip05 identity resolves via fetch then advert', async () => {
  _resetCache()
  const fetchImpl = async (url) => ({ json: async () => ({ names: { nactor: NACTOR_HEX } }) })
  const got = await resolveNactEndpoint({
    identity: 'nactor@nave.pub', pool: fakePool(advert('https://nact.nave.pub/api')),
    fetchImpl, fallback: 'FB',
  })
  assert.equal(got, 'https://nact.nave.pub/api')
})

await t('cache hit avoids a second pool call', async () => {
  _resetCache()
  let calls = 0
  const pool = { get: async () => { calls++; return advert('https://cached/api') }, close() {} }
  await resolveNactEndpoint({ identity: NACTOR_HEX, pool, fallback: 'FB' })
  await resolveNactEndpoint({ identity: NACTOR_HEX, pool, fallback: 'FB' })
  assert.equal(calls, 1, 'second call should be served from cache')
})

console.log(`\n${pass}/${n} passed`)
process.exit(pass === n ? 0 : 1)
