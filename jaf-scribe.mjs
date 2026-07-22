// jaf-scribe.mjs — drafts posts FOR THE DIRECTOR, delivered as scoped data
// grants to his own identity. The other half of Ngage (ngage.nave.pub).
//
// Where luke-brain proposes posts for the ROLE identities (luke/nave) behind
// a Telegram tap, the scribe writes in the Director's first person and hands
// him the draft as a `draft:post/*` scope granted to his npub. He reviews in
// Ngage and — if he likes it — signs the kind-1 with HIS OWN key. Nothing
// here can post as him; the scribe can only ever *offer*. His key never
// touches this box (the grant flows agent → sovereign, the signature flows
// only from his signer).
//
// Topics are deliberately WIDE — all of the Director's interests, not just
// Nave. brief/jaf.md is his steering file; signals add his Substack, shipping
// across ALL his public repos, and conversation around his npub.
//
// Steering now runs BOTH ways over the same wire. brief/jaf.md is the standing
// default he edits by hand; Ngage's settings panel publishes a live
// `steer:draft` grant TO this agent, and that is his current word. See the
// steering section below for precedence and the trust gate.
//
//   node jaf-scribe.mjs --dry-run     # gather + draft + print, don't issue
//   node jaf-scribe.mjs               # also publish scopes + gift-wrap grants
//
// Env (all on the box already): LUKE_NSEC (issuer — signs scopes/wraps, and
// the grantee key that opens his steering), LUKE_MASTER_NPUB (the Director —
// grantee of drafts, publisher of steering), broker path as luke-brain
// (NACT_BROKER_URL/NACT_IDENTITY + BRAIN_NSEC, or ANTHROPIC_API_KEY),
// LUKE_RELAYS. Optional: MAX_DRAFTS (3), SCRIBE_LEDGER, CARDS_MANIFEST_URL,
// STEER_DIRECTOR_NPUB (trust anchor for steering; defaults to the Director).

import { readFile, writeFile } from 'node:fs/promises'
import { createHash, randomBytes } from 'node:crypto'
import { pathToFileURL } from 'node:url'
import { finalizeEvent, getPublicKey, nip19 } from 'nostr-tools'
import { SimplePool } from 'nostr-tools/pool'
import { resolveNactEndpoint } from './nact-resolve.mjs'
import { newScopeKey, publishScope, grant, receiveGrants, latestGrants, fetchScope } from './nipxx.mjs'
import { extractHashtags, ensureAppLinks, ensureLinks, mentionedApps, htmlToText } from './post-format.mjs'

const DRY = process.argv.includes('--dry-run')
const log = (...a) => console.log(...a)

// --- config -------------------------------------------------------------
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY?.trim()
const NACT_BROKER_URL = process.env.NACT_BROKER_URL?.trim()
const NACT_IDENTITY = process.env.NACT_IDENTITY?.trim()
const BRAIN_NSEC = process.env.BRAIN_NSEC?.trim()
// Depth is the goal and the scribe runs on a schedule, so the strongest model
// is the default; DRAFT_MODEL still overrides for cheaper or A/B runs.
const DRAFT_MODEL = process.env.DRAFT_MODEL?.trim() || 'claude-opus-4-8'
const GH_OWNER = process.env.GITHUB_OWNER?.trim() || 'JAFairweather'
const SUBSTACK_FEED = process.env.SUBSTACK_FEED?.trim() || 'https://jafairweather.substack.com/feed'
const SINCE_HOURS = Number(process.env.SINCE_HOURS ?? 26)          // wider net than the brain
const RELAYS = (process.env.LUKE_RELAYS ?? 'wss://relay.damus.io,wss://nos.lol,wss://relay.primal.net')
  .split(',').map(s => s.trim()).filter(Boolean)
const MAX_DRAFTS = Number(process.env.MAX_DRAFTS ?? 3)
const SCRIBE_LEDGER = process.env.SCRIBE_LEDGER?.trim()
const LEDGER_KEEP = Number(process.env.LEDGER_KEEP ?? 80)
const CARDS_MANIFEST_URL = process.env.CARDS_MANIFEST_URL?.trim() || 'https://nave.pub/assets/cards/manifest.json'

const sinceSec = Math.floor(Date.now() / 1000) - SINCE_HOURS * 3600
const sinceISO = new Date(sinceSec * 1000).toISOString()

function loadSk(raw) {
  if (!raw) return null
  if (raw.startsWith('nsec1')) return nip19.decode(raw).data
  if (/^[0-9a-f]{64}$/i.test(raw)) return Uint8Array.from(Buffer.from(raw, 'hex'))
  return null
}
function loadPk(raw) {
  if (!raw) return null
  try { return raw.startsWith('npub1') ? nip19.decode(raw).data : (/^[0-9a-f]{64}$/i.test(raw) ? raw.toLowerCase() : null) }
  catch { return null }
}
const LUKE_SK = loadSk(process.env.LUKE_NSEC?.trim())
const MASTER_PK = loadPk(process.env.LUKE_MASTER_NPUB?.trim())
// The steering publisher we trust. It is the same identity we grant drafts to;
// the override exists so a drill can point at a throwaway Director.
const DIRECTOR_PK = loadPk(process.env.STEER_DIRECTOR_NPUB?.trim()) ?? MASTER_PK

// --- signals ------------------------------------------------------------
// Shipping across ALL public repos (not just the Nave set) — the Director's
// interests are wider than the platform. Most-recently-pushed repos first.
async function signalShippingWide() {
  const items = []
  try {
    const r = await fetch(`https://api.github.com/users/${GH_OWNER}/repos?sort=pushed&per_page=12`,
      { headers: { accept: 'application/vnd.github+json', 'user-agent': 'jaf-scribe' } })
    if (!r.ok) return []
    const repos = (await r.json()).filter(x => !x.fork)
    for (const repo of repos) {
      if (new Date(repo.pushed_at).getTime() < Date.now() - SINCE_HOURS * 3600e3) continue
      try {
        const c = await fetch(`https://api.github.com/repos/${GH_OWNER}/${repo.name}/commits?since=${sinceISO}&per_page=6`,
          { headers: { accept: 'application/vnd.github+json', 'user-agent': 'jaf-scribe' } })
        if (!c.ok) continue
        for (const x of await c.json()) {
          const msg = (x.commit?.message || '').split('\n')[0]
          if (msg && !/^Merge /.test(msg)) items.push({ repo: repo.name, msg })
        }
      } catch { /* skip */ }
    }
  } catch { /* offline → empty */ }
  return items.slice(0, 24)
}

async function signalSubstack() {
  try {
    const r = await fetch(SUBSTACK_FEED, { headers: { 'user-agent': 'jaf-scribe' } })
    if (!r.ok) return []
    const xml = await r.text()
    const items = []
    for (const m of xml.matchAll(/<item>([\s\S]*?)<\/item>/g)) {
      const block = m[1]
      const pick = tag => (block.match(new RegExp(`<${tag}[^>]*>(?:<!\\[CDATA\\[)?([\\s\\S]*?)(?:\\]\\]>)?<\\/${tag}>`)) || [])[1]?.trim()
      const title = pick('title'), link = pick('link'), date = pick('pubDate')
      // The BODY is where his bigger thoughts live — titles are headlines. Take
      // content:encoded (fallback description), flatten to text, keep an excerpt.
      const body = htmlToText(pick('content:encoded') || pick('description') || '')
      if (title && date && new Date(date).getTime() > Date.now() - 7 * 864e5)
        items.push({ title, link, at: new Date(date).getTime(),
                     excerpt: body ? body.slice(0, 1200) + (body.length > 1200 ? '…' : '') : '' })
    }
    // Newest first; only the freshest couple carry excerpts into the prompt.
    items.sort((a, b) => (b.at || 0) - (a.at || 0))
    return items.map((it, i) => (i < 2 ? it : { ...it, excerpt: '' }))
  } catch { return [] }
}

// Conversation around HIS npub (mentions/replies), plus his own recent notes —
// the voice sample and the don't-repeat set.
async function signalNostr() {
  if (!MASTER_PK) return { toMe: [], mine: [] }
  const pool = new SimplePool()
  const short = pk => { try { return nip19.npubEncode(pk).slice(0, 13) + '…' } catch { return pk.slice(0, 8) + '…' } }
  try {
    const [inbound, mine] = await Promise.all([
      pool.querySync(RELAYS, { kinds: [1], '#p': [MASTER_PK], since: sinceSec }, { maxWait: 5000 }),
      pool.querySync(RELAYS, { kinds: [1], authors: [MASTER_PK], since: sinceSec - 13 * 86400 }, { maxWait: 5000 }),
    ])
    return {
      toMe: inbound.filter(e => e.pubkey !== MASTER_PK).slice(0, 10)
        .map(e => ({ by: short(e.pubkey), text: (e.content || '').replace(/\s+/g, ' ').slice(0, 200) })),
      mine: mine.sort((a, b) => b.created_at - a.created_at).slice(0, 8)
        .map(e => (e.content || '').replace(/\s+/g, ' ').slice(0, 240)),
    }
  } catch { return { toMe: [], mine: [] } }
  finally { pool.close(RELAYS) }
}

async function loadCards() {
  try {
    const r = await fetch(CARDS_MANIFEST_URL, { headers: { 'user-agent': 'jaf-scribe' } })
    if (!r.ok) throw new Error(String(r.status))
    const j = await r.json()
    return (j.cards || []).filter(c => c.slug && c.url && /^https:\/\/nave\.pub\//.test(c.url))
  } catch { return [] }
}

// --- LLM (same broker discipline as luke-brain) -------------------------
const sha256hex = s => createHash('sha256').update(s).digest('hex')
function brainSk() { const sk = loadSk(BRAIN_NSEC); if (!sk) throw new Error('BRAIN_NSEC must be nsec1… or 64-hex'); return sk }
function brokerAuth(method, url, bodyStr) {
  const tags = [['u', url], ['method', method]]
  if (bodyStr) tags.push(['payload', sha256hex(bodyStr)])
  const ev = finalizeEvent({ kind: 27235, created_at: Math.floor(Date.now() / 1000), tags, content: '' }, brainSk())
  return 'Nostr ' + Buffer.from(JSON.stringify(ev)).toString('base64')
}
async function callAnthropic(payload) {
  let base = NACT_BROKER_URL
  if (!base && NACT_IDENTITY && BRAIN_NSEC) base = await resolveNactEndpoint(NACT_IDENTITY, { relays: RELAYS })
  if (base && BRAIN_NSEC) {
    const u = base.replace(/\/$/, '') + '/broker'
    const body = JSON.stringify({ provider: 'anthropic', path: '/v1/messages', method: 'POST', body: payload })
    const r = await fetch(u, { method: 'POST', headers: { authorization: brokerAuth('POST', u, body), 'content-type': 'application/json' }, body })
    if (!r.ok) throw new Error(`broker anthropic ${r.status}: ${await r.text().catch(() => '')}`)
    return await r.json()
  }
  if (!ANTHROPIC_API_KEY) throw new Error('no LLM path: set NACT_BROKER_URL (or NACT_IDENTITY) + BRAIN_NSEC, or ANTHROPIC_API_KEY')
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'x-api-key': ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  })
  if (!r.ok) throw new Error(`anthropic ${r.status}: ${await r.text().catch(() => '')}`)
  return await r.json()
}

// --- relay adapter ------------------------------------------------------
// All nipxx needs: publish() fanning out to the pool, query() gathering back.
// Shared by the issuance path (below) and the steering read (next).
const pool = new SimplePool()
const relay = {
  publish: async (event) => {
    const rs = await Promise.allSettled(pool.publish(RELAYS, event))
    const acks = rs.filter(r => r.status === 'fulfilled').length
    if (!acks) throw new Error('no relay accepted the event')
    return { acks }
  },
  query: async (filter) => {
    // Gift wraps carry FUZZED timestamps (up to two days back), so never narrow
    // this with `since` — only cap it. Newest-first: fetchScope takes [0].
    const evs = await pool.querySync(RELAYS, { limit: 500, ...filter }, { maxWait: 6000 })
    const byId = new Map(evs.map(e => [e.id, e]))          // same event from N relays
    return [...byId.values()].sort((a, b) => b.created_at - a.created_at)
  },
}

// --- steering: the Director's live word ---------------------------------
// Ngage's settings panel publishes his drafting steering as a NIP-DA
// `steer:draft` Scoped Data Set and gift-wraps a grant of it TO THIS AGENT.
// Identical wire to the drafts we send him, running the other way: he is the
// publisher, luke the grantee, LUKE_NSEC the key that opens it.
//
// PRECEDENCE — brief/jaf.md is the STANDING DEFAULT: the file he edits by hand,
// and the whole story whenever nothing else is said. A live `steer:draft` grant
// is the Director's CURRENT WORD: it AUGMENTS the file, and where the two
// disagree the grant wins — it is newer, and he published it deliberately from
// his own app. No grant → the file alone, byte-for-byte the prompt we sent
// before this feature existed.
//
// TRUST — only grants whose a-tag publisher is the Director are honoured.
// Anyone may gift-wrap us a `steer:draft` grant; one naming its true author is
// dropped by the filter below, and one forging the Director's address in the
// a-tag dies downstream anyway, because fetchScope dereferences the DIRECTOR'S
// OWN kind-30440 (authors: [publisher]) and a foreign scope key fails its MAC
// → status 'stale'. Never his key, never our trust, by two independent gates.
const STEER_SCOPE_NAME = 'steer:draft'          // the grant's scope name (the filter)
const STEER_KIND = 'steer:draft'                // the payload's self-description
const EMPTY_STEERING = { voice: '', leanInto: [], avoid: [], cadence: '', graphics: '', houseRules: '', updatedAt: 0 }

/**
 * Coerce a decrypted payload into the canonical steering shape. EVERY field is
 * optional, and every field is tolerated absent, wrong-typed, or oversized:
 * garbage in → an empty document, which renders to nothing at the prompt.
 * Never throws.
 */
export function normalizeSteering(data) {
  const o = data && typeof data === 'object' && !Array.isArray(data) ? data : {}
  // `kind` self-describes the document. Absent is fine (all fields optional);
  // present and contradictory means this scope is not ours — treat as empty.
  if (typeof o.kind === 'string' && o.kind && o.kind !== STEER_KIND) return { ...EMPTY_STEERING }
  const one = v => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, 800) : '')
  const many = v => (Array.isArray(v) ? v.map(one).filter(Boolean).slice(0, 24) : [])
  return {
    voice: one(o.voice), leanInto: many(o.leanInto), avoid: many(o.avoid),
    cadence: one(o.cadence), graphics: one(o.graphics), houseRules: one(o.houseRules),
    updatedAt: Number.isFinite(o.updatedAt) ? o.updatedAt : 0,
  }
}

/** True when a steering document carries no actual guidance — i.e. it is inert. */
export const isSteeringEmpty = s =>
  !s || !(s.voice || s.leanInto?.length || s.avoid?.length || s.cadence || s.graphics || s.houseRules)

/** Render steering for the prompt. '' when there is nothing to say — that empty
 *  string is what keeps the no-steering prompt identical to the old one. */
export function steeringBlock(s) {
  if (isSteeringEmpty(s)) return ''
  const when = s.updatedAt ? new Date(s.updatedAt * 1000).toISOString().slice(0, 10) : 'undated'
  const lines = []
  if (s.voice) lines.push(`- Voice: ${s.voice}`)
  if (s.leanInto.length) lines.push(`- Lean into: ${s.leanInto.join('; ')}`)
  if (s.avoid.length) lines.push(`- Avoid: ${s.avoid.join('; ')}`)
  if (s.cadence) lines.push(`- Cadence: ${s.cadence}`)
  if (s.graphics) lines.push(`- Graphics: ${s.graphics}`)
  if (s.houseRules) lines.push(`- House rules: ${s.houseRules}`)
  return `HIS LIVE STEERING (sent from his own app, ${when} — his CURRENT word). It AUGMENTS the steering \
file above and OVERRIDES it wherever the two disagree: the file is his standing default, this is what he \
has just told you.\n\n${lines.join('\n')}\n\n`
}

/**
 * Read the Director's current steering off the relays. Returns a normalized
 * document, or null when there is none to honour: absent, untrusted, rotated
 * past us ('stale'), missing, malformed, or simply empty. NEVER throws — every
 * failure is a quiet fall back to brief/jaf.md, never a blocked drafting run.
 */
export async function fetchSteering(rl = relay, granteeSk = LUKE_SK, directorPk = DIRECTOR_PK) {
  if (!granteeSk || !directorPk) return null
  try {
    const mine = (await receiveGrants(rl, granteeSk))
      .filter(g => g.scopeName === STEER_SCOPE_NAME && g.publisher === directorPk)   // the trust gate
    if (!mine.length) return null
    // Normally exactly one scope (Ngage reuses its scopeId and bumps the
    // generation), so latestGrants is the whole story: newest grant per scope,
    // most recently updated document wins.
    //
    // The second pass exists because latestGrants ranks on the a-tag, which an
    // impostor can forge: a bogus grant claiming the Director's address, his
    // scopeId and a higher generation would SHADOW his real one. It can never
    // become steering (its key fails the MAC), but without this it could
    // silence him. So if nothing in the first pass dereferences, we fall back
    // to the grants it shadowed rather than let an outsider mute the Director.
    const latest = latestGrants(mine)
    let best = null, bestRank = -1
    for (const round of [latest, mine.filter(g => !latest.includes(g))]) {
      for (const g of round) {
        const scope = await fetchScope(rl, g)
        if (scope.status !== 'ok') { log(`  ⚠ steering scope ${g.scopeId.slice(0, 8)}… ${scope.status} — ignoring`); continue }
        const s = normalizeSteering(scope.data)
        if (isSteeringEmpty(s)) continue
        const rank = s.updatedAt || g.issuedAt || 0
        if (rank > bestRank) { best = s; bestRank = rank }
      }
      if (best) break
    }
    return best
  } catch (e) {
    log(`  ⚠ steering read failed (${e.message}) — drafting from brief/jaf.md alone`)
    return null
  }
}

// --- draft --------------------------------------------------------------
/**
 * Build the exact prompt pair the drafter sends. Pure, and exported so the
 * steering round-trip can prove that no/garbage steering leaves it untouched.
 */
export function buildDraftPrompt(themes, signals, cards, dontRepeat, steering = null) {
  const steer = steeringBlock(steering)
  // Empty when there is no live steering, so the prompt is then exactly the
  // prompt this scribe has always sent.
  const graphicsHint = steering?.graphics ? `\nHIS CURRENT GRAPHICS PREFERENCE: ${steering.graphics}` : ''

  const system = `You draft nostr posts FOR James to publish under HIS OWN identity — first person, his voice. \
He reviews each draft in his own app and signs only what he actually wants to say; your job is to offer him \
posts he'd be glad he wrote.\n\n\
HIS STEERING FILE (themes, interests, current focus — the boss document):\n\n${themes}\n\n\
${steer}VOICE: match his recent notes (samples in the signals). Plain, specific, first person. No hype, no \
engagement-bait, no emoji spam. A post earns its place with a concrete observation, a real question, or a \
thing that actually happened. His range is WIDE — the platform he's building, but also everything else the \
steering file names. Do not make every post about Nave.\n\n\
Propose UP TO ${MAX_DRAFTS} drafts — zero if nothing is genuinely worth his signature, but do NOT ration when \
the material is rich: one developed thought is worth more than three thin ones.\n\n\
DEPTH — the point of this run. At least one draft MUST be a genuinely DEVELOPED thought: 2-5 sentences that \
make a real argument or share a real insight, drawn from the substance in the signals (his essay excerpts, \
what the work actually changed). Reach for the interesting IDEA inside the material — the tension a decision \
resolves, the principle an essay is circling, why something matters beyond the fact that it happened — \
instead of announcing that work happened. Short, sharp posts are welcome in the mix, but the SET must not \
read as headlines. Let the idea set the length, not a word budget. \
Hashtags: only where they aid discovery, 0–3, lowercase, in the text; NEVER #nostr (never tag the platform \
you post on). A nave.pub link ONLY when the post is about the Nave (deep public links fine); personal posts \
carry no promo. "image": a card slug from the menu ONLY if the post is squarely on that card's topic — \
otherwise omit it (his personal posts usually ride bare).\n\n\
CARD MENU (slug — topic):\n${cards.map(c => `- ${c.slug} — ${c.use || ''}`).join('\n') || '(none available)'}${graphicsHint}\n\n\
NEVER repropose (he has already seen these): ${dontRepeat.length ? dontRepeat.map(t => `"${t.slice(0, 80)}"`).join('; ') : '(nothing yet)'}\n\n\
Return ONLY a JSON array, no prose, no code fence. Each element:\n\
{"text":"the post, first person","image":"<card slug or omit>","rationale":"one line: why he'd want to say this today","topic":"2-4 word label"}`

  const user = `TODAY'S SIGNALS (last ${SINCE_HOURS}h)\n\n` +
    `## Shipping across his repos\n${signals.shipping.length ? signals.shipping.map(s => `- [${s.repo}] ${s.msg}`).join('\n') : '(quiet)'}\n\n` +
    `## His Substack — mine these for the bigger thought; never echo the title\n${signals.substack.length
      ? signals.substack.map(s => `- ${s.title} — ${s.link}${s.excerpt ? `\n  excerpt: ${s.excerpt}` : ''}`).join('\n')
      : '(none)'}\n\n` +
    `## Said to him on nostr\n${signals.nostr.toMe.length ? signals.nostr.toMe.map(e => `- ${e.by}: "${e.text}"`).join('\n') : '(quiet)'}\n\n` +
    `## His own recent notes (voice sample — do not repeat)\n${signals.nostr.mine.length ? signals.nostr.mine.map(t => `- "${t}"`).join('\n') : '(none)'}`

  return { system, user }
}

async function draftForJaf(themes, signals, cards, dontRepeat, steering = null) {
  const { system, user } = buildDraftPrompt(themes, signals, cards, dontRepeat, steering)
  const j = await callAnthropic({ model: DRAFT_MODEL, max_tokens: 4000, system, messages: [{ role: 'user', content: user }] })
  const text = (j.content || []).map(c => c.text || '').join('').trim()
  const s = text.indexOf('['), e = text.lastIndexOf(']')
  const jsonStr = (s !== -1 && e > s) ? text.slice(s, e + 1) : text
  let arr; try { arr = JSON.parse(jsonStr) } catch { throw new Error(`model did not return JSON:\n${text}`) }
  return Array.isArray(arr) ? arr : []
}

// --- issue: scope + grant to the Director -------------------------------
async function issueDraft(p) {
  const scopeId = randomBytes(12).toString('hex')                 // opaque d tag
  const scopeKey = newScopeKey()
  const payload = {
    kind: 'draft:post', text: p.text,
    image: p.image || null, rationale: p.rationale || null, topic: p.topic || null,
    proposedBy: 'luke', proposedAt: Math.floor(Date.now() / 1000),
  }
  await publishScope(relay, LUKE_SK, { scopeId, generation: 1, scopeKey, payload })
  const { acks } = await grant(relay, LUKE_SK, MASTER_PK,
    { scopeId, generation: 1, scopeKey, scopeName: `draft:post/${scopeId.slice(0, 8)}` })
  return { scopeId, acks }
}

// --- ledger (no-repeat memory) ------------------------------------------
const normText = s => (s || '').toLowerCase().replace(/https?:\/\/\S+/g, '').replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim()
async function readLedger() {
  if (!SCRIBE_LEDGER) return []
  try { const a = JSON.parse(await readFile(SCRIBE_LEDGER, 'utf8')); return Array.isArray(a) ? a : [] } catch { return [] }
}
async function saveLedger(entries) {
  if (!SCRIBE_LEDGER) return
  try { await writeFile(SCRIBE_LEDGER, JSON.stringify(entries.slice(-LEDGER_KEEP), null, 2)) }
  catch (e) { log(`  ⚠ ledger write failed (${e.message}) — continuing`) }
}

// --- run ----------------------------------------------------------------
// Guarded so the round-trip proof can import the read-path and drive it against
// an in-memory relay. `node jaf-scribe.mjs` behaves exactly as before.
const IS_MAIN = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href

if (IS_MAIN) {
  if (!LUKE_SK) { log('  ✗ LUKE_NSEC missing — the scribe signs scopes/wraps as luke'); process.exit(1) }
  if (!MASTER_PK) { log('  ✗ LUKE_MASTER_NPUB missing — no Director to grant to'); process.exit(1) }

  const themes = await readFile(new URL('./brief/jaf.md', import.meta.url), 'utf8').catch(() => '')
  if (!themes) log('  ⚠ brief/jaf.md not found — drafting from signals alone')

  log(`\n  jaf-scribe — drafting for ${nip19.npubEncode(MASTER_PK).slice(0, 13)}… (last ${SINCE_HOURS}h)`)
  // fetchSteering never throws and never blocks: worst case it returns null.
  const [shipping, substack, nostr, cards, ledger, steering] = await Promise.all([
    signalShippingWide(), signalSubstack(), signalNostr(), loadCards(), readLedger(), fetchSteering(),
  ])
  log(`  shipping: ${shipping.length} commits · substack: ${substack.length} · to-him: ${nostr.toMe.length} · his notes: ${nostr.mine.length} · cards: ${cards.length}`)
  log(steering
    ? `  steering: LIVE from the Director${steering.updatedAt ? ` (${new Date(steering.updatedAt * 1000).toISOString().slice(0, 10)})` : ''} — augments brief/jaf.md`
    : '  steering: none granted — brief/jaf.md alone')

  const dontRepeat = [...ledger.slice(-12).map(e => e.text), ...nostr.mine]
  const drafts = await draftForJaf(themes, { shipping, substack, nostr }, cards, dontRepeat, steering)
  log(`  drafted ${drafts.length} candidate(s)\n`)

  const bySlug = new Map(cards.map(c => [c.slug, c]))
  for (const [i, p] of drafts.entries()) {
    // Hygiene only — no forced promo in the Director's own hand. Cards resolve
    // to {url, alt}; an unknown slug simply drops (bare post).
    p.text = String(p.text || '').replace(/#nostr\b/gi, '').replace(/[ \t]+\n/g, '\n').trim()
    if (!p.text) continue
    // Standing link rule, applied WITHOUT turning his personal posts into ads:
    // a draft that names an app always carries that app's link (and nave.pub
    // with it, since it is a Nave post). A purely personal draft — no app, no
    // Nave — stays bare; this is his own hand, not a promo channel.
    if (mentionedApps(p.text).length) p.text = ensureLinks(p.text)
    else if (/\bnave\b/i.test(p.text)) p.text = ensureAppLinks(ensureLinks(p.text))
    const card = p.image && bySlug.get(p.image)
    p.image = card ? { slug: card.slug, url: card.url, alt: card.alt || card.slug } : null
    log(`  [${i + 1}] (${p.topic || 'untitled'}) ${p.text}`)
    log(`      ↳ ${p.rationale || ''}`)
    log(`      ⚙ card: ${p.image ? p.image.slug : '(bare)'} · tags: ${extractHashtags(p.text).map(t => '#' + t).join(' ') || '(none)'} · links: ${mentionedApps(p.text).map(u => u.replace('https://', '')).join(' + ') || '(bare — personal)'}`)
    if (DRY) continue
    try {
      const { scopeId, acks } = await issueDraft(p)
      log(`      → granted to the Director (scope ${scopeId.slice(0, 8)}…, ${acks} relays) — review in Ngage`)
      ledger.push({ scopeId, text: p.text, topic: p.topic || null, at: Math.floor(Date.now() / 1000) })
    } catch (e) { log(`      ✗ issue failed: ${e.message}`) }
  }

  if (!DRY) await saveLedger(ledger)
  log(`\n  done — ${DRY ? 'dry run, nothing issued' : `${drafts.length} draft(s) granted; they appear in ngage.nave.pub`}.\n`)
  pool.close(RELAYS)
  process.exit(0)
}
