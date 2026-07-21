// Unit tests for nave-connect — no browser, no relay. Real crypto for the local
// signer; injected fakes for the NIP-46 bunker (its connect is a network
// round-trip we don't make here). Verifies the shared signer shape, session
// serialize/parse (incl. legacy), and the lazy-connect + client-key persistence.
import assert from 'node:assert'
import { generateSecretKey, getPublicKey, verifyEvent } from 'nostr-tools'
import {
  nip07Signer, localSigner, nip46Signer,
  serializeSession, parseSession, signerFromSession,
} from './nave-connect.mjs'

let n = 0, pass = 0
const t = async (name, fn) => { n++; try { await fn(); pass++; console.log(`ok - ${name}`) } catch (e) { console.error(`FAIL - ${name}\n   ${e.stack || e.message}`) } }

const SHAPE = (s) => typeof s.getPublicKey === 'function' && typeof s.signEvent === 'function'

await t('localSigner: shape + real signed event verifies', async () => {
  const sk = generateSecretKey()
  const s = localSigner(sk)
  assert.ok(SHAPE(s) && s.kind === 'local')
  assert.equal(await s.getPublicKey(), getPublicKey(sk))
  const ev = await s.signEvent({ kind: 1, created_at: 0, tags: [], content: 'hi' })
  assert.ok(verifyEvent(ev), 'event must verify')
})

await t('nip07Signer: uses injected window.nostr', async () => {
  const win = { nostr: { getPublicKey: async () => 'ab'.repeat(32), signEvent: async (e) => ({ ...e, sig: 'x' }) } }
  const s = nip07Signer(win)
  assert.ok(SHAPE(s) && s.kind === 'nip07')
  assert.equal(await s.getPublicKey(), 'ab'.repeat(32))
})

await t('nip07Signer: enable() consent ceremony runs before first key access', async () => {
  const calls = []
  const win = { nostr: { enable: async () => calls.push('enable'),
    getPublicKey: async () => { calls.push('getPublicKey'); return 'ab'.repeat(32) },
    signEvent: async (e) => e, nip44: { encrypt: async () => 'e', decrypt: async () => 'd' } } }
  const s = nip07Signer(win)
  await s.getPublicKey()
  await s.getPublicKey()   // cached — ceremony must not repeat
  assert.deepEqual(calls, ['enable', 'getPublicKey'])
})

await t('nip07Signer: declined enable() aborts sign-in', async () => {
  const win = { nostr: { enable: async () => { throw new Error('nope') },
    getPublicKey: async () => 'ab'.repeat(32), signEvent: async (e) => e,
    nip44: { encrypt: async () => 'e', decrypt: async () => 'd' } } }
  await assert.rejects(() => nip07Signer(win).getPublicKey(), /connection declined/)
})

await t('nip07Signer: no enable() → standard lazy flow unchanged', async () => {
  const win = { nostr: { getPublicKey: async () => 'ab'.repeat(32), signEvent: async (e) => e,
    nip44: { encrypt: async () => 'e', decrypt: async () => 'd' } } }
  assert.equal(await nip07Signer(win).getPublicKey(), 'ab'.repeat(32))
})

await t('nip07Signer: throws with no extension', () => {
  assert.throws(() => nip07Signer({}), /no NIP-07/)
})

await t('nip46Signer: lazy connect, shape, persists client key', async () => {
  let connected = 0
  const fakePointer = { pubkey: 'cd'.repeat(32), relays: ['wss://r'] }
  const FakeBunker = class {
    constructor(local) { this.local = local }
    async connect() { connected++ }
    async getPublicKey() { return 'ef'.repeat(32) }
    async signEvent(e) { return { ...e, pubkey: 'ef'.repeat(32), sig: 'sig' } }
  }
  const s = nip46Signer('bunker://whatever', {
    _BunkerSigner: FakeBunker, _parseBunkerInput: async () => fakePointer,
  })
  assert.ok(SHAPE(s) && s.kind === 'nip46')
  assert.match(s.clientSecretHex, /^[0-9a-f]{64}$/, 'exposes a persistable client key')
  assert.equal(connected, 0, 'connect is lazy — not called on construct')
  assert.equal(await s.getPublicKey(), 'ef'.repeat(32))
  assert.equal(connected, 1, 'connected on first use')
  await s.signEvent({ kind: 1, created_at: 0, tags: [], content: 'x' })
  assert.equal(connected, 1, 'reuses the connection')
})

await t('nip46Signer: reuses a persisted client key', async () => {
  const cs = 'a'.repeat(64)
  const s = nip46Signer('bunker://x', {
    clientSecret: cs, _BunkerSigner: class { async connect() {} async getPublicKey() { return '00'.repeat(32) } },
    _parseBunkerInput: async () => ({ pubkey: 'x', relays: [] }),
  })
  assert.equal(s.clientSecretHex, cs, 'restored key, not a fresh one')
})

await t('nip46Signer: rejects junk bunker input', async () => {
  const s = nip46Signer('not-a-bunker', { _parseBunkerInput: async () => null })
  await assert.rejects(() => s.getPublicKey(), /not a valid bunker/)
})

await t('session: nip07 round-trips', () => {
  assert.equal(serializeSession('nip07'), 'nip07')
  assert.deepEqual(parseSession('nip07'), { kind: 'nip07' })
})

await t('session: nip46 round-trips uri + client key', () => {
  const saved = serializeSession('nip46', { uri: 'bunker://abc?relay=wss://r', clientSecretHex: 'b'.repeat(64) })
  const p = parseSession(saved)
  assert.equal(p.kind, 'nip46')
  assert.equal(p.uri, 'bunker://abc?relay=wss://r')
  assert.equal(p.clientSecret, 'b'.repeat(64))
})

await t('session: legacy bare-hex is treated as local', () => {
  const p = parseSession('ab'.repeat(32))
  assert.equal(p.kind, 'local')
  assert.equal(p.hexKey, 'ab'.repeat(32))
})

await t('signerFromSession: nip07 + local-returns-null', () => {
  assert.equal(signerFromSession({ kind: 'nip07' }, { win: { nostr: {} } }).kind, 'nip07')
  assert.equal(signerFromSession({ kind: 'local', hexKey: 'x' }), null, 'app rebuilds local itself')
  assert.equal(signerFromSession(null), null)
})

console.log(`\n${pass}/${n} passed`)
process.exit(pass === n ? 0 : 1)
