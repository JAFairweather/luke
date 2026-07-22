// voices.mjs — the per-identity drafting rules, factored out of the brain so
// they can be tested without running it.
//
// The property this module exists to guarantee: **a drafting pass sees its own
// identity's steering and never another's.** Before this split there was one
// corpus describing every voice and the model chose which hat to wear per post,
// which is exactly how two voices regress toward one average voice.
//
// Everything here is pure — no IO, no network, no keys.

// The identities the brain drafts for. Adding a voice = adding `brief/<name>.md`
// and a name here. jaf is deliberately absent: the Director's drafts are the
// scribe's job and they route to Ngage, not Telegram, because approval happens
// where the signing key lives.
export const VOICES = ['nave', 'luke']

// The steering block a single pass is given. `steering` is that identity's own
// file; `shared` is the substance and house rules every drafter gets. No other
// identity's file is reachable from here — the isolation is structural, not a
// prompt instruction the model could talk itself out of.
export function voiceHeader(identity, { shared = '', steering = '' } = {}) {
  return `You are drafting nostr posts as ONE identity on "the Nave": "${identity}". ` +
    `Every post you return is signed by ${identity} and by nobody else. You are not writing for any other ` +
    `identity and must not borrow another one's register.\n\n` +
    `=== HOW "${identity}" SOUNDS — this is the voice, follow it closely ===\n${steering}\n\n` +
    `=== SHARED SUBSTANCE AND HOUSE RULES — what we think about, and what every post must obey ===\n${shared}\n\n`
}

// Which of our identities an engagement event landed on.
//
// `refTo` is the identity that authored the note being engaged with — the truth
// when we managed to fetch that note. Otherwise fall back to the p-tag naming
// one of ours. Returns null when neither resolves, and null means "do not offer
// this for a reply": replying as a guessed identity is worse than not replying.
export function engagementTarget(event, whoIs = {}, refTo = null) {
  if (refTo) return refTo
  for (const t of event?.tags || []) if (t[0] === 'p' && whoIs[t[1]]) return whoIs[t[1]]
  return null
}

// Each voice's share of the run's post budget. At least 1, so a voice is never
// silenced by arithmetic — only by having nothing to say.
export function splitBudget(maxPosts, voiceCount) {
  return Math.max(1, Math.ceil(maxPosts / Math.max(1, voiceCount)))
}

// Merge the per-voice results round-robin, then cap. Interleaving matters: a
// straight concat + slice would let the first talkative voice eat the whole run
// and push a quieter one off the end every single time.
export function interleave(lists, max) {
  const out = []
  for (let i = 0; out.length < max && lists.some(l => l[i]); i++) {
    for (const l of lists) if (l[i] && out.length < max) out.push(l[i])
  }
  return out
}

// Normalize post text for comparison: lowercase, links and punctuation dropped.
// Used to match a proposal against what actually got published.
export const normText = s => (s || '').toLowerCase()
  .replace(/https?:\/\/\S+/g, '').replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim()

// Reconcile the ledger against what's now published, and derive the two feedback
// lists for the prompt: recently APPROVED (published) and PASSED (proposed a
// while ago, never published → the human tapped no or let it lapse).
//
// `identity` scopes both lists to that voice's own history. Nave learning from
// what Luke got approved for would reintroduce the very bleed this split exists
// to prevent. Entries predating the split carry no identity and are left out of
// every scoped view rather than shown to all — a voice inheriting the old shared
// corpus's habits is the thing we are trying to stop.
//
// Mutates `ledger` entries' `published` flag, which is how the caller persists
// what it learned.
export function reconcile(ledger, publishedNorm, identity = null, nowSec = Math.floor(Date.now() / 1000)) {
  const pub = new Set(publishedNorm)
  for (const e of ledger) if (!e.published && pub.has(normText(e.text))) e.published = true
  const mine = identity ? ledger.filter(e => e.identity === identity) : ledger
  const approved = mine.filter(e => e.published).slice(-8).map(e => e.text)
  const passed = mine.filter(e => !e.published && (nowSec - (e.at || 0)) > 2 * 86400).slice(-8).map(e => e.text)
  return { approved, passed }
}
