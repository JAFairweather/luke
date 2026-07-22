// Unit tests for nave-connect — no browser, no relay. Real crypto for the local
// signer; injected fakes for the NIP-46 bunker (its connect is a network
// round-trip we don't make here). Verifies the shared signer shape, session
// serialize/parse (incl. legacy), and the lazy-connect + client-key persistence.
import assert from 'node:assert'
import { generateSecretKey, getPublicKey, verifyEvent } from 'nostr-tools'
import {
  nip07Signer, localSigner, nip46Signer, nostrConnectSigner,
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


// ---- nostrconnect:// reverse pairing -------------------------------------
// Promoted from nact. Each test below pins a fix that exists because a real
// signer broke without it — see the module comment.

// A fake pool: captures the filter, hands the test a way to push acks back.
function fakePool({ reachable = true } = {}) {
  const state = { filters: [], relays: [], closed: false, emit: null, ensured: [] }
  return {
    state,
    subscribe(relays, filter, { onevent }) {
      state.relays = relays; state.filters.push(filter); state.emit = onevent
      return { close: () => { state.closed = true } }
    },
    ensureRelay: async (r) => { state.ensured.push(r); if (!reachable) throw new Error('unreachable'); return {} },
    close: () => {},
  }
}
const SIGNER_PK = 'ab'.repeat(32)
const fakeBunker = {
  fromBunker: (_sk, pointer) => ({
    pointer,
    getPublicKey: async () => SIGNER_PK,
    signEvent: async (e) => ({ ...e, sig: 'ok' }),
    nip44Encrypt: async () => 'ct', nip44Decrypt: async () => 'pt',
    close: async () => {},
  }),
}
// Decryption doubles: nip44 succeeds or throws; nip04 is the fallback path.
const nip44Ok = (payload) => ({ decrypt: () => JSON.stringify(payload), getConversationKey: () => 'k' })
const nip44Fails = { decrypt: () => { throw new Error('not nip44') }, getConversationKey: () => 'k' }

async function pairWith({ ack, nip44Impl, nip04Impl, pool }) {
  const p = pool || fakePool()
  const promise = nostrConnectSigner({
    relays: ['wss://r1'], appName: 'Test', _pool: p, _BunkerSigner: fakeBunker,
    _nip44: nip44Impl ?? nip44Ok(ack), _nip04: nip04Impl ?? { decrypt: async () => { throw new Error('no') } },
    _createNostrConnectURI: ({ secret }) => `nostrconnect://client?secret=${secret}`,
  })
  await new Promise(r => setImmediate(r))         // let the subscription attach
  await p.state.emit({ pubkey: SIGNER_PK, content: 'x' })
  return { signer: await promise, pool: p }
}

await t('nostrconnect: an "ack" result pairs — stock fromURI hangs on this', async () => {
  const { signer } = await pairWith({ ack: { result: 'ack' } })
  assert.ok(SHAPE(signer))
  assert.equal(signer.kind, 'nip46', 'a nostrconnect pairing IS a nip46 session')
  assert.equal(signer.via, 'nostrconnect')
  assert.equal(await signer.getPublicKey(), SIGNER_PK)
})

await t('nostrconnect: a NIP-04-encrypted ack pairs — stock accepts only NIP-44', async () => {
  const { signer } = await pairWith({
    nip44Impl: nip44Fails,
    nip04Impl: { decrypt: async () => JSON.stringify({ result: 'ack' }) },
  })
  assert.equal(await signer.getPublicKey(), SIGNER_PK)
})

await t('nostrconnect: any non-error result pairs; an error result does NOT', async () => {
  const { signer } = await pairWith({ ack: { result: 'somethingelse' } })
  assert.ok(signer, 'a signer that answers with its own token still pairs')

  const p = fakePool()
  let settled = false
  nostrConnectSigner({
    relays: ['wss://r1'], _pool: p, _BunkerSigner: fakeBunker, timeoutMs: 50,
    _nip44: nip44Ok({ result: 'x', error: 'user rejected' }),
    _createNostrConnectURI: () => 'nostrconnect://c',
  }).then(() => { settled = 'resolved' }, () => { settled = 'rejected' })
  await new Promise(r => setImmediate(r))
  await p.state.emit({ pubkey: SIGNER_PK, content: 'x' })
  await new Promise(r => setTimeout(r, 80))
  assert.equal(settled, 'rejected', 'an error result must never count as a pairing')
})

await t('nostrconnect: the filter carries NO `since` — the clock-skew fix', async () => {
  const { pool } = await pairWith({ ack: { result: 'ack' } })
  const f = pool.state.filters[0]
  assert.ok(!('since' in f), 'a `since` floor drops acks stamped by a signer whose clock differs')
  assert.equal(f.limit, 0, 'limit:0 = stream new events, no stored history')
  assert.deepStrictEqual(f.kinds, [24133])
})

await t('nostrconnect: an unreachable relay is informational, not fatal', async () => {
  const { signer } = await pairWith({ ack: { result: 'ack' }, pool: fakePool({ reachable: false }) })
  assert.ok(signer, 'one reachable relay is enough; the probe never gates pairing')
})

await t('nostrconnect: the URI reaches the caller before any waiting begins', async () => {
  let shown = null
  const p = fakePool()
  const promise = nostrConnectSigner({
    relays: ['wss://r1'], _pool: p, _BunkerSigner: fakeBunker,
    _nip44: nip44Ok({ result: 'ack' }), onUri: (u) => { shown = u },
    _createNostrConnectURI: ({ secret }) => `nostrconnect://client?secret=${secret}`,
  })
  assert.ok(shown?.startsWith('nostrconnect://'), 'the link must be displayable immediately')
  await new Promise(r => setImmediate(r))
  await p.state.emit({ pubkey: SIGNER_PK, content: 'x' })
  await promise
})

await t('nostrconnect: hands back a bunker:// so a reload re-pairs as a nip46 session', async () => {
  const { signer } = await pairWith({ ack: { result: 'ack' } })
  assert.ok(signer.bunkerUri.startsWith(`bunker://${SIGNER_PK}?`))
  assert.match(signer.bunkerUri, /relay=wss%3A%2F%2Fr1/)
  assert.match(signer.bunkerUri, /secret=[0-9a-f]{64}/)
  const round = parseSession(serializeSession('nip46', { uri: signer.bunkerUri, clientSecretHex: signer.clientSecretHex }))
  assert.equal(round.kind, 'nip46')
  assert.equal(round.uri, signer.bunkerUri)
  assert.equal(round.clientSecret, signer.clientSecretHex)
})

await t('nostrconnect: a timeout reports whether the relays or the signer was silent', async () => {
  const p = fakePool()
  await assert.rejects(
    nostrConnectSigner({ relays: ['wss://r1'], _pool: p, _BunkerSigner: fakeBunker, timeoutMs: 30,
      _createNostrConnectURI: () => 'nostrconnect://c' }),
    /Zero events/, 'with no events the error must point at the relays, not the signer')
  assert.ok(p.state.closed, 'the subscription is closed on timeout')
})

console.log(`\n${pass}/${n} passed`)
process.exit(pass === n ? 0 : 1)
