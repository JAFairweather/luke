// luke-brain.mjs — the "brain" of Luke's posting loop.
//
// Runs on a schedule (twice a day). Gathers the day's signals, drafts 1–3
// candidate posts in our voice, and POSTs each to Luke's /propose endpoint —
// which sends them to you on Telegram to approve. The brain holds NO POSTING
// key — it can only propose; your tap does the rest. (It may hold a dedicated
// `brain` identity used ONLY to authenticate LLM calls to Nactor's credential
// broker — that key cannot post as luke/nave, so the approve-before-post
// property is unchanged.)
//
// Signals (all public — no private data):
//   • themes/voice corpus   brief/voice.md
//   • ecosystem shipping     recent commits across the nave repos (GitHub)
//   • Substack               your blog's RSS
//   • nostr engagement       replies/reactions on Luke & Nave (relays)
//
//   node luke-brain.mjs --dry-run     # gather + draft + print, don't propose
//   node luke-brain.mjs               # also POST each draft to /propose

import { readFile, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { finalizeEvent, getPublicKey, nip19 } from 'nostr-tools'
import { SimplePool } from 'nostr-tools/pool'

const DRY = process.argv.includes('--dry-run')
const log = (...a) => console.log(...a)

// --- config -------------------------------------------------------------
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY?.trim()
// Credential-broker path (Phase 2): if set, LLM calls go THROUGH Nactor, which
// holds the Anthropic key in memory and injects it — the key never lives here.
// BRAIN_NSEC is a dedicated, activated `brain` identity used only to sign the
// NIP-98 auth to the broker; it is NOT a posting key. Both unset → direct call
// with ANTHROPIC_API_KEY (the pre-migration path), so this is non-breaking.
const NACT_BROKER_URL = process.env.NACT_BROKER_URL?.trim()   // e.g. http://nactor:8791/api
const BRAIN_NSEC = process.env.BRAIN_NSEC?.trim()
const DRAFT_MODEL = process.env.DRAFT_MODEL?.trim() || 'claude-sonnet-5'
const PROPOSE_URL = process.env.PROPOSE_URL?.trim() || 'https://luke.nave.pub/propose'
const PROPOSE_TOKEN = process.env.PROPOSE_TOKEN?.trim()
const GH_OWNER = process.env.GITHUB_OWNER?.trim() || 'JAFairweather'
const REPOS = (process.env.NAVE_REPOS?.trim() ||
  'nave.pub,noir,ntrigue,nvoy,nontact,nvelope,nherit,notegate,nostr-scoped-data-grants,luke')
  .split(',').map(s => s.trim()).filter(Boolean)
const SUBSTACK_FEED = process.env.SUBSTACK_FEED?.trim() || 'https://jafairweather.substack.com/feed'
const SINCE_HOURS = Number(process.env.SINCE_HOURS ?? 14)
const RELAYS = (process.env.LUKE_RELAYS ?? 'wss://relay.damus.io,wss://nos.lol,wss://relay.primal.net')
  .split(',').map(s => s.trim()).filter(Boolean)
const MAX_POSTS = Number(process.env.MAX_POSTS ?? 3)
// Continuity ledger (box-local JSON, mounted writable). Records what Luke has
// proposed so he doesn't repeat himself, and — by matching proposals against
// what later got PUBLISHED under luke/nave (i.e. what you approved) — learns
// which drafts you tap yes vs pass on. Unset (or unwritable) → feature off,
// non-breaking (local dry-runs without the mount still work).
const BRAIN_LEDGER = process.env.BRAIN_LEDGER?.trim()
const LEDGER_KEEP = Number(process.env.LEDGER_KEEP ?? 80)          // cap entries
const LEDGER_LOOKBACK_DAYS = Number(process.env.LEDGER_LOOKBACK_DAYS ?? 21)

const sinceSec = Math.floor(Date.now() / 1000) - SINCE_HOURS * 3600
const sinceISO = new Date(sinceSec * 1000).toISOString()

function pubkeys() {
  const out = {}
  for (const [scope, env] of [['luke', 'LUKE_NSEC'], ['nave', 'NAVE_NSEC']]) {
    const raw = process.env[env]?.trim(); if (!raw) continue
    const sk = raw.startsWith('nsec1') ? nip19.decode(raw).data
      : (/^[0-9a-f]{64}$/i.test(raw) ? Uint8Array.from(raw.match(/.{1,2}/g).map(b => parseInt(b, 16))) : null)
    if (sk) out[scope] = getPublicKey(sk)
  }
  return out
}

// --- signal: ecosystem shipping (GitHub, unauthenticated) ---------------
async function signalShipping() {
  const items = []
  for (const repo of REPOS) {
    try {
      const r = await fetch(`https://api.github.com/repos/${GH_OWNER}/${repo}/commits?since=${sinceISO}&per_page=10`,
        { headers: { 'accept': 'application/vnd.github+json', 'user-agent': 'luke-brain' } })
      if (!r.ok) continue
      const commits = await r.json()
      for (const c of commits) {
        const msg = (c.commit?.message || '').split('\n')[0]
        if (msg && !/^Merge /.test(msg)) items.push({ repo, msg })
      }
    } catch { /* skip a repo that errors */ }
  }
  return items
}

// --- signal: Substack RSS ----------------------------------------------
async function signalSubstack() {
  try {
    const r = await fetch(SUBSTACK_FEED, { headers: { 'user-agent': 'luke-brain' } })
    if (!r.ok) return []
    const xml = await r.text()
    const items = []
    for (const m of xml.matchAll(/<item>([\s\S]*?)<\/item>/g)) {
      const block = m[1]
      const pick = tag => (block.match(new RegExp(`<${tag}[^>]*>(?:<!\\[CDATA\\[)?([\\s\\S]*?)(?:\\]\\]>)?<\\/${tag}>`)) || [])[1]?.trim()
      const title = pick('title'), link = pick('link'), date = pick('pubDate')
      if (title && date && new Date(date).getTime() > Date.now() - 3 * 864e5) items.push({ title, link })
    }
    return items
  } catch { return [] }
}

// --- signal: nostr engagement on Luke & Nave ----------------------------
// Read the full engagement picture — replies/mentions (kind 1), reposts (6),
// reactions (7), and zaps (9735, the strongest resonance signal) — that
// reference our notes, and pull the text of the OUR note each one is about so
// the model has context for a reply. Zaps and replies rank first.
const shortNpub = pk => { try { return nip19.npubEncode(pk).slice(0, 13) + '…' } catch { return (pk || '').slice(0, 8) + '…' } }
// Sats from a zap receipt: parse the bolt11 amount (lnbc<n><unit>).
function zapSats(e) {
  const bolt = (e.tags.find(t => t[0] === 'bolt11') || [])[1] || ''
  const m = bolt.match(/lnbc(\d+)([munp])?/i); if (!m) return null
  const mult = { m: 1e-3, u: 1e-6, n: 1e-9, p: 1e-12 }[(m[2] || '').toLowerCase()] ?? 1
  return Math.round(Number(m[1]) * mult * 1e8) // BTC→sats
}
// The zapper's pubkey lives in the embedded zap request (description tag).
function zapSender(e) {
  try { return JSON.parse((e.tags.find(t => t[0] === 'description') || [])[1] || '{}').pubkey || e.pubkey }
  catch { return e.pubkey }
}
async function signalEngagement(pks) {
  const authors = Object.values(pks); if (!authors.length) return []
  const ours = new Set(authors)
  const pool = new SimplePool()
  try {
    const events = await pool.querySync(RELAYS,
      { kinds: [1, 6, 7, 9735], '#p': authors, since: sinceSec }, { maxWait: 5000 })
    // Fetch OUR notes being engaged with, so each item carries what it's about.
    const refIds = new Set()
    for (const e of events) for (const t of e.tags) if (t[0] === 'e' && t[1]) refIds.add(t[1])
    const refText = {}
    if (refIds.size) {
      const notes = await pool.querySync(RELAYS, { ids: [...refIds].slice(0, 50) }, { maxWait: 4000 })
      for (const n of notes) if (ours.has(n.pubkey)) refText[n.id] = (n.content || '').replace(/\s+/g, ' ').slice(0, 160)
    }
    const ctxOf = e => { const id = (e.tags.filter(t => t[0] === 'e').pop() || [])[1]; return id ? refText[id] || null : null }
    const items = events.flatMap(e => {
      if (e.kind === 9735) { const sats = zapSats(e); return [{ kind: 'zap', by: shortNpub(zapSender(e)), sats, ctx: ctxOf(e) }] }
      if (ours.has(e.pubkey)) return []                       // our own note/repost/reaction — skip
      if (e.kind === 7) return [{ kind: 'reaction', by: shortNpub(e.pubkey), text: (e.content || '+').slice(0, 16), ctx: ctxOf(e) }]
      if (e.kind === 6) return [{ kind: 'repost', by: shortNpub(e.pubkey), ctx: ctxOf(e) }]
      return [{ kind: 'reply', id: e.id, by: shortNpub(e.pubkey), text: (e.content || '').replace(/\s+/g, ' ').slice(0, 240), ctx: ctxOf(e) }]
    })
    // Zaps first (by size), then replies (repliable), then reposts, then reactions.
    const rank = { zap: 0, reply: 1, repost: 2, reaction: 3 }
    items.sort((a, b) => (rank[a.kind] - rank[b.kind]) || ((b.sats || 0) - (a.sats || 0)))
    return items.slice(0, 16)
  } catch { return [] }
  finally { pool.close(RELAYS) }
}

// --- Anthropic call: broker (Phase 2) or direct (fallback) --------------
const sha256hex = s => createHash('sha256').update(s).digest('hex')
function brainSk() {
  const v = BRAIN_NSEC
  if (v.startsWith('nsec1')) return nip19.decode(v).data
  if (/^[0-9a-f]{64}$/i.test(v)) return Uint8Array.from(Buffer.from(v, 'hex'))
  throw new Error('BRAIN_NSEC must be nsec1… or 64-hex')
}
function brokerAuth(method, url, bodyStr) {
  const tags = [['u', url], ['method', method]]
  if (bodyStr) tags.push(['payload', sha256hex(bodyStr)])
  const ev = finalizeEvent({ kind: 27235, created_at: Math.floor(Date.now() / 1000), tags, content: '' }, brainSk())
  return 'Nostr ' + Buffer.from(JSON.stringify(ev)).toString('base64')
}
// Returns the parsed Anthropic /v1/messages response, either brokered through
// Nactor (key stays in Nactor) or called directly (pre-migration fallback).
async function callAnthropic(payload) {
  if (NACT_BROKER_URL && BRAIN_NSEC) {
    const u = NACT_BROKER_URL.replace(/\/$/, '') + '/broker'
    const body = JSON.stringify({ provider: 'anthropic', path: '/v1/messages', method: 'POST', body: payload })
    const r = await fetch(u, { method: 'POST', headers: { authorization: brokerAuth('POST', u, body), 'content-type': 'application/json' }, body })
    if (!r.ok) throw new Error(`broker anthropic ${r.status}: ${await r.text().catch(() => '')}`)
    return await r.json()
  }
  if (!ANTHROPIC_API_KEY) throw new Error('no LLM path configured: set NACT_BROKER_URL + BRAIN_NSEC, or ANTHROPIC_API_KEY')
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'x-api-key': ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  })
  if (!r.ok) throw new Error(`anthropic ${r.status}: ${await r.text().catch(() => '')}`)
  return await r.json()
}

// Render one engagement item for the prompt, with an icon per kind and the
// "on:" context (the text of our note it references).
function fmtEngagement(e) {
  const on = e.ctx ? `  (on: "${e.ctx}")` : ''
  if (e.kind === 'zap') return `- ⚡ zap${e.sats ? ` ${e.sats} sats` : ''} from ${e.by}${on}`
  if (e.kind === 'repost') return `- ♻ repost by ${e.by}${on}`
  if (e.kind === 'reaction') return `- ❤ reaction "${e.text}" by ${e.by}${on}`
  return `- 💬 reply (id ${e.id}) from ${e.by}: "${e.text}"${on}`
}

// --- draft via Anthropic ------------------------------------------------
async function draftPosts(corpus, signals, history = { approved: [], passed: [] }) {
  if (!NACT_BROKER_URL && !ANTHROPIC_API_KEY) throw new Error('no LLM path: set NACT_BROKER_URL + BRAIN_NSEC, or ANTHROPIC_API_KEY')
  const system = `You draft short nostr posts for two identities on "the Nave": \
"nave" (the project's voice) and "luke" (a delegated agent). Follow this voice corpus EXACTLY:\n\n${corpus}\n\n\
You will receive today's signals. Propose AT MOST ${MAX_POSTS} posts — fewer is better; propose zero if the \
signals are thin. Each post must stand alone, sound like the corpus (no hype, no emoji spam), and be genuinely \
worth posting. Write channel-appropriately — use what a channel's readers expect and skip what they wouldn't. \
You are drafting for nostr right now: NEVER add a #nostr hashtag (on nostr it reads like #twitter on Twitter — the \
same tag could be right on a different platform like Twitter/X, but here it is noise). Never tag the platform you \
are posting on, and on nostr use any hashtag only when it genuinely aids discovery. \
For an engagement follow-up, reply ONLY to a "reply" item (it has an id) — set "replyTo" to that id \
and pick the identity that was engaged with. Zaps/reposts/reactions are resonance signals to learn from, \
not things to reply to. Use the "on:" context to answer what was actually said.\n\n\
If a "Your memory" section is present, honor it as a hard rule: never re-propose a PASSED item or a close \
variant of one (your human already declined it), and don't repeat an APPROVED item verbatim — match its register, move the idea forward.\n\n\
Return ONLY a JSON array, no prose, no code fence. Each element:\n\
{"identity":"nave"|"luke","text":"the post","rationale":"one line: why this, for your human approver","replyTo":"<event id or omit>"}`

  const user = `TODAY'S SIGNALS (window: last ${SINCE_HOURS}h)\n\n` +
    `## Ecosystem shipping (recent commits)\n${signals.shipping.length ? signals.shipping.map(s => `- [${s.repo}] ${s.msg}`).join('\n') : '(nothing notable)'}\n\n` +
    `## New Substack posts\n${signals.substack.length ? signals.substack.map(s => `- ${s.title} — ${s.link}`).join('\n') : '(none)'}\n\n` +
    `## Engagement on Luke & Nave (zaps & replies first)\n${signals.engagement.length ? signals.engagement.map(fmtEngagement).join('\n') : '(none)'}` +
    ((history.approved.length || history.passed.length) ? (
      `\n\n## Your memory — learn from your human's taps\n` +
      (history.approved.length ? `Recently APPROVED (published — this is what lands; echo the register, don't repeat verbatim):\n${history.approved.map(t => `- "${t}"`).join('\n')}\n` : '') +
      (history.passed.length ? `Recently PASSED (proposed, not approved — do NOT re-propose these or close variants):\n${history.passed.map(t => `- "${t}"`).join('\n')}` : '')
    ) : '')

  const j = await callAnthropic({ model: DRAFT_MODEL, max_tokens: 1400, system, messages: [{ role: 'user', content: user }] })
  const text = (j.content || []).map(c => c.text || '').join('').trim()
  const jsonStr = text.replace(/^```(?:json)?/i, '').replace(/```$/, '').trim()
  let arr; try { arr = JSON.parse(jsonStr) } catch { throw new Error(`model did not return JSON:\n${text}`) }
  return Array.isArray(arr) ? arr : []
}

// --- propose ------------------------------------------------------------
// Prefer NIP-98 (sign as `brain`), binding this exact body; fall back to the
// shared bearer token if BRAIN_NSEC isn't set. Non-breaking during migration.
function proposeAuth(url, bodyStr) {
  if (BRAIN_NSEC) {
    try {
      const tags = [['u', url], ['method', 'POST'], ['payload', sha256hex(bodyStr)]]
      const ev = finalizeEvent({ kind: 27235, created_at: Math.floor(Date.now() / 1000), tags, content: '' }, brainSk())
      return { authorization: 'Nostr ' + Buffer.from(JSON.stringify(ev)).toString('base64') }
    } catch { /* fall through to bearer */ }
  }
  return PROPOSE_TOKEN ? { authorization: `Bearer ${PROPOSE_TOKEN}` } : {}
}
async function propose(p) {
  const bodyStr = JSON.stringify({ identity: p.identity, text: p.text, rationale: p.rationale, replyTo: p.replyTo || null })
  const r = await fetch(PROPOSE_URL, {
    method: 'POST',
    headers: { ...proposeAuth(PROPOSE_URL, bodyStr), 'content-type': 'application/json' },
    body: bodyStr,
  })
  const body = await r.json().catch(() => ({}))
  return { ok: r.ok, status: r.status, body }
}

// --- continuity ledger (P3) ---------------------------------------------
const normText = s => (s || '').toLowerCase().replace(/https?:\/\/\S+/g, '').replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim()
const draftHash = (identity, text) => sha256hex(`${identity}\n${normText(text)}`)
async function readLedger() {
  if (!BRAIN_LEDGER) return []
  try { const a = JSON.parse(await readFile(BRAIN_LEDGER, 'utf8')); return Array.isArray(a) ? a : [] }
  catch { return [] }               // missing/empty/corrupt → start fresh
}
async function saveLedger(entries) {
  if (!BRAIN_LEDGER) return
  const trimmed = entries.slice(-LEDGER_KEEP)
  try { await writeFile(BRAIN_LEDGER, JSON.stringify(trimmed, null, 2)) }
  catch (e) { log(`  ⚠ ledger write failed (${e.message}) — continuing`) }
}
// What Luke actually published (= what you approved): our own recent kind-1 notes.
async function fetchOwnPublished(pks) {
  const authors = Object.values(pks); if (!authors.length || !BRAIN_LEDGER) return []
  const since = Math.floor(Date.now() / 1000) - LEDGER_LOOKBACK_DAYS * 86400
  const pool = new SimplePool()
  try {
    const events = await pool.querySync(RELAYS, { kinds: [1], authors, since }, { maxWait: 4000 })
    return events.map(e => normText(e.content))
  } catch { return [] }
  finally { pool.close(RELAYS) }
}
// Reconcile the ledger against what's now published, and derive the two
// feedback lists for the prompt: recently APPROVED (published) and PASSED
// (proposed a while ago, never published → you tapped no / let it lapse).
function reconcile(ledger, publishedNorm) {
  const pub = new Set(publishedNorm)
  const nowSec = Math.floor(Date.now() / 1000)
  for (const e of ledger) if (!e.published && pub.has(normText(e.text))) e.published = true
  const approved = ledger.filter(e => e.published).slice(-8).map(e => e.text)
  const passed = ledger.filter(e => !e.published && (nowSec - (e.at || 0)) > 2 * 86400).slice(-8).map(e => e.text)
  return { approved, passed }
}

// --- run ----------------------------------------------------------------
const corpus = await readFile(new URL('./brief/voice.md', import.meta.url), 'utf8').catch(() => '')
if (!corpus) log('  ⚠ brief/voice.md not found — drafting without the voice corpus')
const pks = pubkeys()

log(`\n  luke-brain — gathering signals (last ${SINCE_HOURS}h)…`)
const [shipping, substack, engagement, published] = await Promise.all([
  signalShipping(), signalSubstack(), signalEngagement(pks), fetchOwnPublished(pks),
])
log(`  shipping: ${shipping.length} commits · substack: ${substack.length} posts · engagement: ${engagement.length} notes`)

// P3: reconcile the continuity ledger — mark past proposals that got published
// (you approved them), and derive the approved/passed feedback for the prompt.
const ledger = await readLedger()
const history = reconcile(ledger, published)
if (BRAIN_LEDGER) log(`  memory: ${ledger.length} in ledger · ${history.approved.length} approved · ${history.passed.length} passed`)

const candidates = await draftPosts(corpus, { shipping, substack, engagement }, history)
log(`  drafted ${candidates.length} candidate(s)\n`)

for (const [i, p] of candidates.entries()) {
  log(`  [${i + 1}] as ${p.identity}${p.replyTo ? ' (reply)' : ''}: ${p.text}`)
  log(`      ↳ ${p.rationale || ''}`)
  if (DRY) continue
  // Phase 2: the brain authenticates /propose with its NIP-98 `brain` signature
  // (BRAIN_NSEC); the shared PROPOSE_TOKEN is only a pre-migration fallback. Gate
  // on "no auth at all", so proposing keeps working once the bearer token is retired.
  if (!BRAIN_NSEC && !PROPOSE_TOKEN) { log('      ⚠ no /propose auth (set BRAIN_NSEC or PROPOSE_TOKEN) — not proposing'); continue }
  const res = await propose(p)
  log(`      → ${res.ok ? `proposed (id ${res.body.id}) — awaiting your Telegram tap` : `FAILED ${res.status}: ${JSON.stringify(res.body)}`}`)
  // P3: record what we proposed so future runs don't repeat it (and can learn
  // from whether you later publish it). Only log actually-proposed drafts.
  if (res.ok) ledger.push({ hash: draftHash(p.identity, p.text), identity: p.identity, text: p.text, at: Math.floor(Date.now() / 1000), published: false })
}

if (!DRY) await saveLedger(ledger)
log(`\n  done — ${DRY ? 'dry run, nothing proposed' : `${candidates.length} sent to Telegram for approval`}.\n`)
process.exit(0)
