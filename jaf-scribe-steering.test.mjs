// The steering round-trip, proven offline and end-to-end — the mirror of the
// draft-issuance proof that shipped with the scribe.
//
//   node jaf-scribe-steering.test.mjs
//
// The Director's panel (JAFairweather/ngage, steering.mjs) publishes his
// drafting steering SIGNER-DRIVEN: it never holds a raw key, so it reimplements
// nipxx's publishScope / grant / giftWrap against a signer. Its claim is that
// the bytes are indistinguishable from a raw-key nipxx publisher's. This file
// tests that claim from the receiving end: the publisher below is mirrored
// verbatim from ngage's steering.mjs (@ 77038f9 — publishScopeWithSigner,
// grantWithSigner, giftWrapWithSigner, buildSteerPayload), and the reader is
// the scribe's REAL read-path, imported from jaf-scribe.mjs and run against an
// in-memory relay. No network, no live keys — the Director and the impostor are
// throwaway keys minted per run.
//
// What must hold: his steering arrives intact; nobody else's does; and anything
// absent, rotated, or malformed leaves drafting exactly as it was before this
// feature existed.

import assert from 'node:assert'
import {
  finalizeEvent, generateSecretKey, getEventHash, getPublicKey,
  matchFilter, nip44, verifyEvent,
} from 'nostr-tools'
import { KIND_DATA_SET, KIND_GRANT, localSigner, newScopeKey } from './nipxx.mjs'
import { fetchSteering, normalizeSteering, isSteeringEmpty, buildDraftPrompt } from './jaf-scribe.mjs'

let n = 0, pass = 0
const t = async (name, fn) => {
  n++
  try { await fn(); pass++; console.log(`ok - ${name}`) }
  catch (e) { console.error(`FAIL - ${name}\n   ${e.stack || e.message}`) }
}

// ---- in-memory relay: NIP-01 storage, filters, addressable replacement -----
const isAddressable = k => k >= 30000 && k < 40000
const dTag = e => e.tags.find(t => t[0] === 'd')?.[1] ?? ''
class MemRelay {
  events = []
  async publish(event) {
    if (!verifyEvent(event)) throw new Error('invalid signature')     // the wire must be real
    if (isAddressable(event.kind)) {
      const key = `${event.kind}:${event.pubkey}:${dTag(event)}`
      this.events = this.events.filter(e => !(isAddressable(e.kind) && `${e.kind}:${e.pubkey}:${dTag(e)}` === key))
    }
    this.events.push(event)
    return { acks: 1 }
  }
  async query(filter) {
    return this.events.filter(e => matchFilter(filter, e)).sort((a, b) => b.created_at - a.created_at)
  }
}

// ---- the Director's publisher, mirrored from ngage/steering.mjs ------------
// Verbatim, including nipxx's module-private now()/fuzz()/b64 — if these drift
// from the panel, this proof stops meaning anything.
let lastTs = 0
const now = () => (lastTs = Math.max(Math.floor(Date.now() / 1000), lastTs + 1))
const fuzz = () => now() - Math.floor(Math.random() * 2 * 24 * 60 * 60)
const b64 = bytes => btoa(String.fromCharCode(...bytes))

async function giftWrapWithSigner(signer, recipientPub, rumor) {
  rumor.id = getEventHash(rumor)
  const seal = await signer.signEvent({
    kind: 13, created_at: fuzz(), tags: [],
    content: await signer.nip44Encrypt(recipientPub, JSON.stringify(rumor)),
  })
  const ephemeral = generateSecretKey()
  return finalizeEvent({
    kind: 1059, created_at: fuzz(), tags: [['p', recipientPub]],
    content: nip44.v2.encrypt(JSON.stringify(seal),
      nip44.v2.utils.getConversationKey(ephemeral, recipientPub)),
  }, ephemeral)
}

async function publishScopeWithSigner(relay, signer, { scopeId, generation, scopeKey, payload }) {
  const ts = now()
  const event = await signer.signEvent({
    kind: KIND_DATA_SET, created_at: ts,
    tags: [['d', scopeId], ['v', String(generation)]],
    content: nip44.v2.encrypt(JSON.stringify({ ...payload, updated_at: ts }), scopeKey),
  })
  return { event, ...(await relay.publish(event)) }
}

async function grantWithSigner(relay, signer, granteePubkey,
                               { scopeId, generation, scopeKey, scopeName, relayHint = '', addressAs = null }) {
  const publisherPub = await signer.getPublicKey()
  const rumor = {
    pubkey: publisherPub,
    kind: KIND_GRANT,
    created_at: now(),
    tags: [
      // `addressAs` is NOT in ngage — it is the forgery lever used by the
      // a-tag test below, where an impostor names the Director's address.
      ['a', `${KIND_DATA_SET}:${addressAs ?? publisherPub}:${scopeId}`, relayHint],
      ['v', String(generation)],
    ],
    content: JSON.stringify({ scope_key: b64(scopeKey), scope_name: scopeName }),
  }
  const wrap = await giftWrapWithSigner(signer, granteePubkey, rumor)
  return { wrap, ...(await relay.publish(wrap)) }
}

/** ngage's buildSteerPayload: empty fields are OMITTED from the wire. */
function buildSteerPayload(s, updatedAt) {
  const str = v => (typeof v === 'string' ? v.trim() : '')
  const list = v => (Array.isArray(v) ? v.map(str).filter(Boolean) : [])
  const p = { kind: 'steer:draft', updatedAt }
  if (str(s.voice)) p.voice = str(s.voice)
  if (list(s.leanInto).length) p.leanInto = list(s.leanInto)
  if (list(s.avoid).length) p.avoid = list(s.avoid)
  if (str(s.cadence)) p.cadence = str(s.cadence)
  if (str(s.graphics)) p.graphics = str(s.graphics)
  if (str(s.houseRules)) p.houseRules = str(s.houseRules)
  return p
}

const newScopeId = () => b64(crypto.getRandomValues(new Uint8Array(12))).replace(/[^a-zA-Z0-9]/g, '').toLowerCase().slice(0, 16)
const mk = () => { const sk = generateSecretKey(); return { sk, pub: getPublicKey(sk) } }

/** One panel "Save": publish the scope, seal a grant of it to the scribe. */
async function publishSteering(relay, director, scribePub, steering,
                               { updatedAt = 1721600000, scopeId = newScopeId(), generation = 1, scopeKey = newScopeKey(), payload = null, addressAs = null } = {}) {
  const signer = localSigner(director.sk)
  const body = payload ?? buildSteerPayload(steering, updatedAt)
  await publishScopeWithSigner(relay, signer, { scopeId, generation, scopeKey, payload: body })
  await grantWithSigner(relay, signer, scribePub,
    { scopeId, generation, scopeKey, scopeName: 'steer:draft', addressAs })
  return { scopeId, generation, scopeKey, payload: body }
}

// ---- fixtures --------------------------------------------------------------
const STEERING = {
  voice: 'Plain, first person, dry. No hype, no emoji, no engagement bait.',
  leanInto: ['sovereign identity', 'nostr protocol design', 'shipping notes'],
  avoid: ['price talk', 'subtweets', 'hot takes on other projects'],
  cadence: 'At most two a day; skip days with nothing worth signing.',
  graphics: 'Prefer the letterpress cards when on-topic; personal notes ride bare.',
  houseRules: 'Never tag #nostr. A nave.pub link only when the post is about the Nave.',
}

const THEMES = '# jaf\n\n- Building the Nave in the open.\n- Contact as a human practice.\n'
const SIGNALS = {
  shipping: [{ repo: 'luke', msg: 'scribe: consume the steering grant' }],
  substack: [{ title: 'On revocation', link: 'https://example.invalid/p/1' }],
  nostr: { toMe: [{ by: 'npub1abc…', text: 'how does revocation feel?' }], mine: ['a note I already wrote'] },
}
const CARDS = [{ slug: 'sovereignty', use: 'keys, delegation, revocation' }]
const promptFor = steering => buildDraftPrompt(THEMES, SIGNALS, CARDS, [], steering)

// ---- (a)+(b)+(c) the happy path: his word, intact -------------------------
await t('a signer-published steer:draft grant round-trips into the scribe\'s read-path', async () => {
  const relay = new MemRelay(), director = mk(), scribe = mk()
  await publishSteering(relay, director, scribe.pub, STEERING)

  const s = await fetchSteering(relay, scribe.sk, director.pub)     // THE REAL READ-PATH
  assert.ok(s, 'steering must be recovered')
  assert.equal(s.voice, STEERING.voice)
  assert.deepEqual(s.leanInto, STEERING.leanInto)
  assert.deepEqual(s.avoid, STEERING.avoid)
  assert.equal(s.cadence, STEERING.cadence)
  assert.equal(s.graphics, STEERING.graphics)
  assert.equal(s.houseRules, STEERING.houseRules)
  assert.equal(s.updatedAt, 1721600000)
})

await t('the recovered steering reaches the prompt, and outranks brief/jaf.md there', async () => {
  const relay = new MemRelay(), director = mk(), scribe = mk()
  await publishSteering(relay, director, scribe.pub, STEERING)
  const { system } = promptFor(await fetchSteering(relay, scribe.sk, director.pub))

  for (const line of [STEERING.voice, STEERING.cadence, STEERING.houseRules, ...STEERING.leanInto, ...STEERING.avoid]) {
    assert.ok(system.includes(line), `prompt must carry: ${line}`)
  }
  assert.ok(system.includes('OVERRIDES it wherever the two disagree'), 'precedence must be stated')
  // Structure: the standing file first, then the live word, then the voice rules.
  assert.ok(system.indexOf(THEMES) < system.indexOf('HIS LIVE STEERING'), 'live steering follows the file')
  assert.ok(system.indexOf('HIS LIVE STEERING') < system.indexOf('VOICE: match his recent notes'), 'and precedes the voice block')
  // `graphics` is a card-selection hint, so it rides with the card menu.
  assert.ok(system.includes(`sovereignty — keys, delegation, revocation\nHIS CURRENT GRAPHICS PREFERENCE: ${STEERING.graphics}`),
    'graphics must hint card selection')
})

// ---- (d) trust: only the Director steers -----------------------------------
await t('an untrusted publisher\'s steer:draft grant is rejected', async () => {
  const relay = new MemRelay(), director = mk(), impostor = mk(), scribe = mk()
  await publishSteering(relay, impostor, scribe.pub, { voice: 'forged voice', houseRules: 'always shill' })

  assert.equal(await fetchSteering(relay, scribe.sk, director.pub), null, 'impostor alone → no steering')

  // …and with both on the relay, only his own survives the gate.
  await publishSteering(relay, director, scribe.pub, STEERING)
  const s = await fetchSteering(relay, scribe.sk, director.pub)
  assert.equal(s.voice, STEERING.voice)
  assert.ok(!JSON.stringify(s).includes('forged'), 'nothing forged may reach the prompt')
  assert.ok(!promptFor(s).system.includes('always shill'))
})

await t('an impostor forging the Director\'s a-tag address still cannot steer', async () => {
  const relay = new MemRelay(), director = mk(), impostor = mk(), scribe = mk()
  const real = await publishSteering(relay, director, scribe.pub, STEERING)
  // Same scopeId, his address in the a-tag, the impostor's key — the worst case:
  // the grant passes the publisher filter, so the SECOND gate has to hold.
  await grantWithSigner(relay, localSigner(impostor.sk), scribe.pub, {
    scopeId: real.scopeId, generation: real.generation + 1, scopeKey: newScopeKey(),
    scopeName: 'steer:draft', addressAs: director.pub,
  })
  // fetchScope dereferences the DIRECTOR's own kind-30440, so the foreign scope
  // key fails its MAC → 'stale' → ignored. And because the forgery outranks his
  // real grant, the fallback pass is what keeps him from being SILENCED.
  const s = await fetchSteering(relay, scribe.sk, director.pub)
  assert.ok(s, 'a forged grant must not silence the Director')
  assert.equal(s.voice, STEERING.voice, 'his real steering still wins')
  assert.ok(!JSON.stringify(s).includes('forged'), 'forgery must never become steering')
})

// ---- (e) fail-safe: absent, stale, malformed → drafting untouched ----------
const BASELINE = promptFor(null)   // the prompt this scribe sent before the feature

await t('no grant at all → the prompt is byte-identical to the pre-steering prompt', async () => {
  const relay = new MemRelay(), director = mk(), scribe = mk()
  assert.equal(await fetchSteering(relay, scribe.sk, director.pub), null)
  assert.ok(BASELINE.system.includes(`${THEMES}\n\nVOICE: match his recent notes`), 'file flows straight into VOICE')
  assert.ok(!BASELINE.system.includes('HIS LIVE STEERING'))
  assert.ok(!BASELINE.system.includes('HIS CURRENT GRAPHICS PREFERENCE'))
  assert.equal(await fetchSteering(relay, null, director.pub), null, 'no key → inert')
  assert.equal(await fetchSteering(relay, scribe.sk, null), null, 'no trust anchor → inert')
})

await t('a malformed payload is inert — the prompt is unchanged, drafting unaffected', async () => {
  const relay = new MemRelay(), director = mk(), scribe = mk()
  await publishSteering(relay, director, scribe.pub, null, {
    payload: { kind: 'steer:draft', voice: 42, leanInto: 'not a list', avoid: {}, cadence: null, updatedAt: 'soon' },
  })
  const s = await fetchSteering(relay, scribe.sk, director.pub)
  assert.equal(s, null, 'garbage must not become steering')
  assert.deepEqual(promptFor(s), BASELINE, 'the prompt is exactly the pre-steering prompt')

  // The normalizer is total: nothing here may throw.
  for (const junk of [null, undefined, 'a string', 42, [], [1, 2], { kind: 'draft:post', voice: 'wrong doc' }, { voice: {} }]) {
    assert.ok(isSteeringEmpty(normalizeSteering(junk)), `must be inert: ${JSON.stringify(junk)}`)
  }
  // …and partial documents are legal: every field is optional.
  const partial = normalizeSteering({ kind: 'steer:draft', houseRules: 'no promo', updatedAt: 7 })
  assert.equal(isSteeringEmpty(partial), false)
  assert.equal(partial.houseRules, 'no promo')
  assert.deepEqual(partial.leanInto, [])
})

await t('a rotated scope (stale grant) falls back to brief/jaf.md instead of blocking', async () => {
  const relay = new MemRelay(), director = mk(), scribe = mk()
  const first = await publishSteering(relay, director, scribe.pub, STEERING)
  // He republishes with a fresh key and does NOT grant it to us (revocation):
  // the scope advances, our grant is left behind.
  await publishScopeWithSigner(relay, localSigner(director.sk), {
    scopeId: first.scopeId, generation: 2, scopeKey: newScopeKey(),
    payload: buildSteerPayload({ voice: 'a voice we are no longer allowed to read' }, 1721700000),
  })
  const s = await fetchSteering(relay, scribe.sk, director.pub)
  assert.equal(s, null, 'stale → no steering')
  assert.deepEqual(promptFor(s), BASELINE, 'and drafting proceeds on the file alone')
})

await t('a read-path failure logs and skips — it never blocks a drafting run', async () => {
  const exploding = { publish: async () => { throw new Error('nope') }, query: async () => { throw new Error('relay down') } }
  const scribe = mk(), director = mk()
  const s = await fetchSteering(exploding, scribe.sk, director.pub)
  assert.equal(s, null, 'a dead relay must not throw out of fetchSteering')
  assert.deepEqual(promptFor(s), BASELINE)
})

console.log(`\n${pass}/${n} passed`)
process.exit(pass === n ? 0 : 1)
