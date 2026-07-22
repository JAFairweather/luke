// The per-identity voice split, proven offline.
//
//   node voices.test.mjs
//
// Before this split, one corpus described every voice and the model picked which
// hat to wear per post. These tests pin the properties that replaced it: a pass
// can only see its own steering, engagement and memory are scoped to the identity
// they belong to, and a quiet voice can't be crowded out of a run by a loud one.

import assert from 'node:assert'
import {
  VOICES, voiceHeader, engagementTarget, splitBudget, interleave, normText, reconcile,
} from './voices.mjs'

let n = 0, pass = 0
const t = (name, fn) => {
  n++
  try { fn(); pass++; console.log(`ok - ${name}`) }
  catch (e) { console.error(`FAIL - ${name}\n   ${e.stack || e.message}`) }
}

// ---- the isolation property ------------------------------------------------

const SHARED = 'SHARED-SUBSTANCE-MARKER: nave.pub link, a graphic, hashtags.'
const LUKE = 'LUKE-VOICE-MARKER: a hardass who is on your side. discipline = freedom.'
const NAVE = 'NAVE-VOICE-MARKER: the project speaking. the signature is the authorization.'

t('a pass carries its own steering', () => {
  const h = voiceHeader('luke', { shared: SHARED, steering: LUKE })
  assert.ok(h.includes(LUKE), 'luke pass must contain luke steering')
  assert.ok(h.includes(SHARED), 'every pass gets the shared substance')
})

t('a pass CANNOT see another identity\'s steering — the whole point of the split', () => {
  const luke = voiceHeader('luke', { shared: SHARED, steering: LUKE })
  const nave = voiceHeader('nave', { shared: SHARED, steering: NAVE })
  assert.ok(!luke.includes('NAVE-VOICE-MARKER'), 'luke must not see nave steering')
  assert.ok(!nave.includes('LUKE-VOICE-MARKER'), 'nave must not see luke steering')
})

t('the pass is told, by name, which identity it is and that it signs alone', () => {
  const h = voiceHeader('nave', { shared: SHARED, steering: NAVE })
  assert.ok(h.includes('"nave"'), 'names the identity')
  assert.ok(/signed by nave and by nobody else/.test(h), 'binds the signature to one identity')
})

t('a missing steering file degrades to an empty block, never to another voice', () => {
  const h = voiceHeader('luke', { shared: SHARED })
  assert.ok(h.includes(SHARED))
  assert.ok(!h.includes('NAVE-VOICE-MARKER') && !h.includes('LUKE-VOICE-MARKER'))
})

t('VOICES excludes jaf — the Director\'s drafts route to Ngage, not Telegram', () => {
  assert.deepStrictEqual(VOICES, ['nave', 'luke'])
  assert.ok(!VOICES.includes('jaf'), 'jaf must never be drafted into the Telegram path')
})

// ---- engagement attribution ------------------------------------------------

const PK_LUKE = 'a'.repeat(64), PK_NAVE = 'b'.repeat(64), PK_STRANGER = 'c'.repeat(64)
const whoIs = { [PK_LUKE]: 'luke', [PK_NAVE]: 'nave' }

t('the author of the engaged-with note wins over the p-tag', () => {
  // A reply that p-tags BOTH of ours, but is a reply to a note nave wrote.
  const e = { tags: [['p', PK_LUKE], ['p', PK_NAVE], ['e', 'x']] }
  assert.strictEqual(engagementTarget(e, whoIs, 'nave'), 'nave')
})

t('falls back to the p-tag naming one of ours when the note could not be fetched', () => {
  const e = { tags: [['p', PK_STRANGER], ['p', PK_LUKE]] }
  assert.strictEqual(engagementTarget(e, whoIs, null), 'luke')
})

t('unattributable engagement returns null — never a guessed identity', () => {
  const e = { tags: [['p', PK_STRANGER]] }
  assert.strictEqual(engagementTarget(e, whoIs, null), null)
  assert.strictEqual(engagementTarget({ tags: [] }, whoIs, null), null)
  assert.strictEqual(engagementTarget({}, whoIs, null), null)
})

// ---- budget and fairness ---------------------------------------------------

t('the budget splits across voices and never rounds a voice down to zero', () => {
  assert.strictEqual(splitBudget(3, 2), 2)
  assert.strictEqual(splitBudget(4, 2), 2)
  assert.strictEqual(splitBudget(1, 2), 1, 'a voice is silenced by having nothing to say, not by arithmetic')
  assert.strictEqual(splitBudget(3, 0), 3, 'no voices → no division by zero')
})

t('interleaving stops a loud voice from crowding out a quiet one', () => {
  const nave = ['n1', 'n2'], luke = ['l1']
  assert.deepStrictEqual(interleave([nave, luke], 2), ['n1', 'l1'],
    'a straight concat+slice would have returned ["n1","n2"] and dropped luke entirely')
})

t('a silent voice yields its share rather than wasting it', () => {
  assert.deepStrictEqual(interleave([['n1', 'n2', 'n3'], []], 3), ['n1', 'n2', 'n3'])
})

t('interleave respects the cap and tolerates every voice being silent', () => {
  assert.deepStrictEqual(interleave([['n1', 'n2'], ['l1', 'l2']], 3), ['n1', 'l1', 'n2'])
  assert.deepStrictEqual(interleave([[], []], 3), [])
})

// ---- per-identity memory ---------------------------------------------------

const DAY = 86400
const NOW = 1_800_000_000                       // fixed clock — no wall-time flake

t('memory is scoped to the voice: nave never learns from luke\'s approvals', () => {
  const ledger = [
    { identity: 'luke', text: 'luke approved post', at: NOW - 10 * DAY, published: true },
    { identity: 'nave', text: 'nave approved post', at: NOW - 10 * DAY, published: true },
  ]
  const nave = reconcile(ledger, [], 'nave', NOW)
  assert.deepStrictEqual(nave.approved, ['nave approved post'])
  const luke = reconcile(ledger, [], 'luke', NOW)
  assert.deepStrictEqual(luke.approved, ['luke approved post'])
})

t('a proposal that later appears published is marked approved, link-punctuation aside', () => {
  const ledger = [{ identity: 'nave', text: 'The grant rotates. https://nave.pub #nave', at: NOW - 10 * DAY }]
  const r = reconcile(ledger, [normText('the grant rotates!  #nave')], 'nave', NOW)
  assert.strictEqual(ledger[0].published, true, 'reconcile marks the ledger entry')
  assert.deepStrictEqual(r.approved, ['The grant rotates. https://nave.pub #nave'])
  assert.deepStrictEqual(r.passed, [])
})

t('an old unpublished proposal becomes PASSED; a fresh one is still pending', () => {
  const ledger = [
    { identity: 'luke', text: 'old and declined', at: NOW - 5 * DAY },
    { identity: 'luke', text: 'proposed this morning', at: NOW - 3600 },
  ]
  const r = reconcile(ledger, [], 'luke', NOW)
  assert.deepStrictEqual(r.passed, ['old and declined'])
  assert.deepStrictEqual(r.approved, [])
})

t('pre-split entries carry no identity and are shown to NO voice', () => {
  // These were drafted from the old single shared corpus. Feeding them to a
  // scoped pass would teach the new voice the habits of the averaged one.
  const ledger = [{ text: 'a post from before the split', at: NOW - 10 * DAY, published: true }]
  assert.deepStrictEqual(reconcile(ledger, [], 'luke', NOW).approved, [])
  assert.deepStrictEqual(reconcile(ledger, [], 'nave', NOW).approved, [])
  assert.deepStrictEqual(reconcile(ledger, [], null, NOW).approved, ['a post from before the split'],
    'unscoped still sees everything, so nothing is lost — just not attributed')
})

console.log(`\n${pass}/${n} passed`)
process.exit(pass === n ? 0 : 1)
