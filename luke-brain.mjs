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
//   • ecosystem shipping     recent commits + a key-doc excerpt per shipping repo (GitHub)
//   • Substack               your blog's RSS — titles AND body excerpts of recent posts
//   • nostr engagement       replies/reactions on Luke & Nave (relays)
//
//   node luke-brain.mjs --dry-run     # gather + draft + print, don't propose
//   node luke-brain.mjs               # also POST each draft to /propose

import { readFile, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { finalizeEvent, getPublicKey, nip19 } from 'nostr-tools'
import { SimplePool } from 'nostr-tools/pool'
import { resolveNactEndpoint } from './nact-resolve.mjs'
import { ensureLinks, ensureHashtags, extractHashtags, hasApexLink, mentionedApps } from './post-format.mjs'

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
// AD-2: address Nact by IDENTITY, not a URL. If NACT_IDENTITY is set (npub or
// nactor@nave.pub) and no explicit URL is given, resolve the endpoint from the
// Nactor's published advert. The URL still wins when set (fast on-box path);
// identity is the discovery fallback for off-box callers. See nact-resolve.mjs.
const NACT_IDENTITY = process.env.NACT_IDENTITY?.trim()
const BRAIN_NSEC = process.env.BRAIN_NSEC?.trim()
// Default to the strongest model — depth is the goal, and drafting runs only
// twice a day so the cost is negligible. DRAFT_MODEL still overrides (cheaper
// runs, A/B). This is a config constant, not a claim in any post.
const DRAFT_MODEL = process.env.DRAFT_MODEL?.trim() || 'claude-opus-4-8'
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
// The Director's standing rule for every outbound post: a nave.pub link, a
// relevant card graphic, appropriate hashtags. The card menu is fetched from
// the site itself (manifest.json ships with the cards) so adding a card never
// needs a brain redeploy; if the fetch fails we still satisfy "always a
// graphic" with the built-in default. BRAIN_REPLY_PROMO=light relaxes the
// link+graphic rule on REPLIES only (conversation first) — default 'full'.
const CARDS_MANIFEST_URL = process.env.CARDS_MANIFEST_URL?.trim() || 'https://nave.pub/assets/cards/manifest.json'
const REPLY_PROMO = (process.env.BRAIN_REPLY_PROMO?.trim() || 'full').toLowerCase()
const DEFAULT_CARD = {
  slug: 'nave', url: 'https://nave.pub/assets/cards/nave.png',
  alt: 'Nave — a room on the open internet that no one can take from you',
  use: 'default — general Nave posts, or when nothing more specific fits',
}
// Public destinations the model may deep-link (never the gated hosts).
const PUBLIC_LINKS = [
  'https://nave.pub — the room itself (default)',
  'https://nvoy.nave.pub — Nvoy, the delegation console',
  'https://notegate.nave.pub — Notegate, the serverless tip line',
  'https://nact.nave.pub — Nact, agents that act with keys that stay home',
  'https://noir.nave.pub — Noir, the spycraft game',
  'https://nvelope.nave.pub — Nvelope', 'https://nontact.nave.pub — Nontact',
  'https://nherit.nave.pub — Nherit', 'https://nscope.nave.pub — Nscope',
  'https://ngage.nave.pub — Ngage, the sovereign posting desk',
  'https://warm.contact — warm.contact, inbound-first contact collection',
]

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

// --- signal helper: HTML/markdown → plain text -------------------------
// Flatten RSS bodies and README markdown into readable text for the excerpts
// we feed the model. Strips script/style, comments, markdown images/badges,
// and any remaining tags; decodes the common entities; collapses whitespace.
// Deliberately lossy — we want the gist, not fidelity.
const htmlToText = html => String(html || '')
  .replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ')
  .replace(/<!--[\s\S]*?-->/g, ' ')
  .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')             // markdown images / badge rows
  .replace(/<[^>]+>/g, ' ')                           // any remaining tags
  .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
  .replace(/&#39;|&rsquo;|&apos;/g, "'").replace(/&quot;|&ldquo;|&rdquo;/g, '"').replace(/&hellip;/g, '…')
  .replace(/&#[xX]([0-9a-fA-F]+);/g, (_, h) => { try { return String.fromCodePoint(parseInt(h, 16)) } catch { return ' ' } })
  .replace(/&#(\d+);/g, (_, n) => { try { return String.fromCodePoint(+n) } catch { return ' ' } })
  .replace(/\s+/g, ' ').trim()

// --- signal: ecosystem shipping (GitHub, unauthenticated) ---------------
// The significant repos whose top doc is worth pulling so the model grasps
// what a commit MEANS conceptually, not just its one-line subject. A doc is
// fetched ONLY for a repo that actually shipped in the window (see below).
const DOC_REPOS = new Set(['nave.pub', 'nostr-scoped-data-grants', 'nvoy', 'warm.contact', 'luke'])
// Pull ~600 chars of a repo's canonical top doc (its README) via the GitHub
// API. Best-effort: any failure returns null and drafting proceeds without it.
async function fetchRepoDoc(repo) {
  try {
    const r = await fetch(`https://api.github.com/repos/${GH_OWNER}/${repo}/readme`,
      { headers: { 'accept': 'application/vnd.github+json', 'user-agent': 'luke-brain' } })
    if (!r.ok) return null
    const j = await r.json()
    const raw = j.encoding === 'base64' ? Buffer.from(j.content || '', 'base64').toString('utf8') : String(j.content || '')
    const text = htmlToText(raw).slice(0, 600)
    return text ? { repo, text } : null
  } catch { return null }
}
async function signalShipping() {
  const commits = []
  const shipped = new Set()                           // repos with real (non-merge) commits in-window
  for (const repo of REPOS) {
    try {
      const r = await fetch(`https://api.github.com/repos/${GH_OWNER}/${repo}/commits?since=${sinceISO}&per_page=10`,
        { headers: { 'accept': 'application/vnd.github+json', 'user-agent': 'luke-brain' } })
      if (!r.ok) continue
      const list = await r.json()
      for (const c of list) {
        const msg = (c.commit?.message || '').split('\n')[0]
        if (msg && !/^Merge /.test(msg)) { commits.push({ repo, msg }); shipped.add(repo) }
      }
    } catch { /* skip a repo that errors */ }
  }
  // Enrich only the significant repos that actually shipped — parallel,
  // best-effort; a doc that fails to load is simply dropped, never blocks.
  const docs = (await Promise.all([...shipped].filter(r => DOC_REPOS.has(r)).map(fetchRepoDoc))).filter(Boolean)
  return { commits, docs }
}

// --- signal: Substack RSS ----------------------------------------------
// The master's essays ARE the bigger thoughts, so pull the post BODY, not just
// the title: <content:encoded> (the full post) preferred, <description> as a
// fallback, flattened to text. The 1–2 most recent posts get an ~1200-char
// excerpt so the model reasons from real material instead of a headline.
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
      if (title && date && new Date(date).getTime() > Date.now() - 3 * 864e5) {
        // content:encoded is Substack's full post HTML; description is a summary.
        items.push({ title, link, date, body: pick('content:encoded') || pick('description') || '' })
      }
    }
    // Newest first, then attach a plain-text excerpt to the 1–2 freshest essays.
    items.sort((a, b) => new Date(b.date) - new Date(a.date))
    for (const it of items.slice(0, 2)) {
      const text = htmlToText(it.body)
      if (text) it.excerpt = text.length > 1200 ? text.slice(0, 1200) + '…' : text
    }
    return items.map(({ title, link, excerpt }) => ({ title, link, excerpt }))
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
let _nactBase   // resolved once per run
async function nactBase() {
  if (_nactBase !== undefined) return _nactBase
  // URL wins (on-box internal, fast); else discover the endpoint from identity.
  _nactBase = NACT_BROKER_URL ||
    await resolveNactEndpoint({ identity: NACT_IDENTITY, relays: RELAYS, fallback: null })
  return _nactBase
}
async function callAnthropic(payload) {
  const base = (NACT_BROKER_URL || NACT_IDENTITY) && BRAIN_NSEC ? await nactBase() : null
  if (base && BRAIN_NSEC) {
    const u = base.replace(/\/$/, '') + '/broker'
    const body = JSON.stringify({ provider: 'anthropic', path: '/v1/messages', method: 'POST', body: payload })
    const r = await fetch(u, { method: 'POST', headers: { authorization: brokerAuth('POST', u, body), 'content-type': 'application/json' }, body })
    if (!r.ok) throw new Error(`broker anthropic ${r.status}: ${await r.text().catch(() => '')}`)
    return await r.json()
  }
  if (!ANTHROPIC_API_KEY) throw new Error('no LLM path configured: set NACT_BROKER_URL (or NACT_IDENTITY) + BRAIN_NSEC, or ANTHROPIC_API_KEY')
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'x-api-key': ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  })
  if (!r.ok) throw new Error(`anthropic ${r.status}: ${await r.text().catch(() => '')}`)
  return await r.json()
}

// --- card menu (the "always a graphic" rule) ----------------------------
// Fetch the manifest the site publishes next to the cards. Shape:
//   { "cards": [{ "slug", "url", "alt", "use" }, …] }
// Any failure → the built-in default card alone, so drafting never blocks on
// the site and every post still carries a graphic.
async function loadCards() {
  try {
    const r = await fetch(CARDS_MANIFEST_URL, { headers: { 'user-agent': 'luke-brain' } })
    if (!r.ok) throw new Error(`${r.status}`)
    const j = await r.json()
    const cards = (j.cards || []).filter(c => c.slug && c.url && /^https:\/\/nave\.pub\//.test(c.url))
    return cards.length ? cards : [DEFAULT_CARD]
  } catch (e) {
    log(`  ⚠ card manifest unavailable (${e.message}) — using the default card only`)
    return [DEFAULT_CARD]
  }
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
async function draftPosts(corpus, signals, history = { approved: [], passed: [] }, cards = [DEFAULT_CARD]) {
  if (!NACT_BROKER_URL && !NACT_IDENTITY && !ANTHROPIC_API_KEY) throw new Error('no LLM path: set NACT_BROKER_URL (or NACT_IDENTITY) + BRAIN_NSEC, or ANTHROPIC_API_KEY')
  const system = `You draft nostr posts for two identities on "the Nave": \
"nave" (the project's voice) and "luke" (a delegated agent). The corpus below is BOTH how we sound AND what we \
think about — treat its themes (D=F, user-owned data, agentic-but-on-a-leash, the Nact broker pattern) and \
focus areas as substance to reason WITH, not merely a style sheet. Follow it closely:\n\n${corpus}\n\n\
You will receive today's signals — commits (with short doc excerpts of what shipped), the master's own essays \
(with body excerpts), and engagement. Propose UP TO ${MAX_POSTS} posts; propose zero only if there is genuinely \
nothing worth saying. Do NOT ration when the material is rich — one developed thought is worth more than three \
thin ones. Each post must stand alone, sound like the corpus (no hype, no emoji spam), and earn its place.\n\n\
DEPTH — the point of this run. At least one candidate MUST be a genuinely DEVELOPED thought: 2–5 sentences that \
make a real argument or share a real insight, drawn from the substance in the signals and the corpus. Reach for \
the interesting IDEA inside the material — the tension a design decision resolves, the principle an essay is \
circling, why a change matters beyond the fact that it landed — instead of announcing that work happened. \
"We shipped revocation" is a changelog line; "revocation is just rotation seen from the other side — you don't \
delete access, you move the lock and let the old keys fall away" is a thought worth a stranger's time. Mine the \
Substack excerpts and the doc excerpts for these; that is where the bigger thinking already lives. Short, sharp \
posts are still welcome in the mix — but the SET as a whole must not read as headlines.\n\n\
CRAFT: no warm-ups — "we've been thinking about…" is a delete; open on the concrete (a claim, a number, a \
tension). The specific beats the general ("revoked a key and watched 300 grants re-issue themselves" beats \
"working on revocation"). One idea per post — but "one idea" can be a single line OR a developed paragraph; let \
the idea set its length, not a word budget. When a signal points at something real, ground the thought in it. \
End where a reader can go deeper — a link to walk through, or a question you actually want answered (never \
engagement-bait you don't care about).\n\n\
HOUSE RULES — every post carries all three, woven in so they read as part of the post, not a footer:\n\
1. LINKS: ALWAYS reference nave.pub itself. AND if the post names a specific app — Nontact, Nvoy, Nact/Nactor, \
Nvelope, Notegate, Ntrigue, Nherit, Nscope, Noir, Ngage, warm.contact — include THAT app's own link as well, \
in addition to nave.pub (menu below). Never invent other paths, never link anything else, and never link the \
gated hosts (Cockpit, Console).\n\
2. GRAPHIC: set "image" to the slug of the most relevant card from the CARD MENU. The graphic rides with the \
post, so don't describe it in the text.\n\
3. HASHTAGS: 1–3 lowercase topical hashtags IN the text (final line, or woven in where natural). Tags people \
actually follow — #privacy #opensource #bitcoin #ai #agents #devstr — plus #nave when it fits. NEVER #nostr \
(on nostr it reads like #twitter on Twitter; never tag the platform you are posting on) and no tag piles.\n\n\
LINK MENU (public only):\n${PUBLIC_LINKS.map(l => `- ${l}`).join('\n')}\n\n\
CARD MENU (slug — when to use):\n${cards.map(c => `- ${c.slug} — ${c.use || c.alt || ''}`).join('\n')}\n\n\
For an engagement follow-up, reply ONLY to a "reply" item (it has an id) — set "replyTo" to that id \
and pick the identity that was engaged with. Zaps/reposts/reactions are resonance signals to learn from, \
not things to reply to. Use the "on:" context to answer what was actually said. In a reply, the conversation \
comes first: answer the person plainly, and place the link/hashtags only where they serve the reader.\n\n\
If a "Your memory" section is present, honor it as a hard rule: never re-propose a PASSED item or a close \
variant of one (your human already declined it), and don't repeat an APPROVED item verbatim — match its register, move the idea forward.\n\n\
Return ONLY a JSON array, no prose, no code fence. Each element:\n\
{"identity":"nave"|"luke","text":"the post (link + hashtags included)","image":"<card slug>",\
"rationale":"one line: why this, for your human approver","replyTo":"<event id or omit>"}`

  const user = `TODAY'S SIGNALS (window: last ${SINCE_HOURS}h)\n\n` +
    `## Ecosystem shipping (recent commits)\n${signals.shipping.commits.length ? signals.shipping.commits.map(s => `- [${s.repo}] ${s.msg}`).join('\n') : '(nothing notable)'}\n\n` +
    (signals.shipping.docs.length ? `## What those repos are (key-doc excerpts — grasp the concept behind the commits, don't just restate them)\n${signals.shipping.docs.map(d => `### ${d.repo}\n${d.text}`).join('\n\n')}\n\n` : '') +
    `## New Substack posts — the master's essays (mine the excerpt for the bigger thought; never just echo a title)\n${signals.substack.length ? signals.substack.map(s => `- ${s.title} — ${s.link}${s.excerpt ? `\n  excerpt: ${s.excerpt}` : ''}`).join('\n\n') : '(none)'}\n\n` +
    `## Engagement on Luke & Nave (zaps & replies first)\n${signals.engagement.length ? signals.engagement.map(fmtEngagement).join('\n') : '(none)'}` +
    ((history.approved.length || history.passed.length) ? (
      `\n\n## Your memory — learn from your human's taps\n` +
      (history.approved.length ? `Recently APPROVED (published — this is what lands; echo the register, don't repeat verbatim):\n${history.approved.map(t => `- "${t}"`).join('\n')}\n` : '') +
      (history.passed.length ? `Recently PASSED (proposed, not approved — do NOT re-propose these or close variants):\n${history.passed.map(t => `- "${t}"`).join('\n')}` : '')
    ) : '')

  const j = await callAnthropic({ model: DRAFT_MODEL, max_tokens: 4000, system, messages: [{ role: 'user', content: user }] })
  const text = (j.content || []).map(c => c.text || '').join('').trim()
  // Tolerate markdown fences and any prose around the array: take the outermost
  // [...] span. (Also raised max_tokens above so the array can't truncate.)
  const s = text.indexOf('['), e = text.lastIndexOf(']')
  const jsonStr = (s !== -1 && e > s) ? text.slice(s, e + 1) : text.replace(/^```(?:json)?/i, '').replace(/```$/, '').trim()
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
  const bodyStr = JSON.stringify({ identity: p.identity, text: p.text, rationale: p.rationale, replyTo: p.replyTo || null, image: p.image || null })
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
const [shipping, substack, engagement, published, cards] = await Promise.all([
  signalShipping(), signalSubstack(), signalEngagement(pks), fetchOwnPublished(pks), loadCards(),
])
log(`  shipping: ${shipping.commits.length} commits (+${shipping.docs.length} doc excerpts) · substack: ${substack.length} posts (${substack.filter(s => s.excerpt).length} w/ body) · engagement: ${engagement.length} notes · cards: ${cards.length}`)

// P3: reconcile the continuity ledger — mark past proposals that got published
// (you approved them), and derive the approved/passed feedback for the prompt.
const ledger = await readLedger()
const history = reconcile(ledger, published)
if (BRAIN_LEDGER) log(`  memory: ${ledger.length} in ledger · ${history.approved.length} approved · ${history.passed.length} passed`)

const candidates = await draftPosts(corpus, { shipping, substack, engagement }, history, cards)
log(`  drafted ${candidates.length} candidate(s)\n`)

// House-rule enforcement — deterministic, after the model: the prompt asks,
// this GUARANTEES. Every non-reply post leaves here with a nave.pub link,
// ≥1 hashtag, and a resolved card; replies too unless BRAIN_REPLY_PROMO=light.
const bySlug = new Map(cards.map(c => [c.slug, c]))
for (const p of candidates) {
  const lightReply = p.replyTo && REPLY_PROMO === 'light'
  if (!lightReply) {
    p.text = ensureHashtags(ensureLinks(p.text))
    const card = bySlug.get(p.image) || bySlug.get('nave') || DEFAULT_CARD
    p.image = { slug: card.slug, url: card.url, alt: card.alt || card.slug }
  } else {
    // Conversation first: keep whatever the model chose to include, resolve a
    // card only if it named one, and never bolt promo onto a reply.
    const card = p.image && bySlug.get(p.image)
    p.image = card ? { slug: card.slug, url: card.url, alt: card.alt || card.slug } : null
  }
}

for (const [i, p] of candidates.entries()) {
  log(`  [${i + 1}] as ${p.identity}${p.replyTo ? ' (reply)' : ''}: ${p.text}`)
  log(`      ↳ ${p.rationale || ''}`)
  log(`      ⚙ card: ${p.image ? p.image.slug : '(none — light reply)'} · tags: ${extractHashtags(p.text).map(t => '#' + t).join(' ') || '(none)'} · links: ${[hasApexLink(p.text) ? 'nave.pub' : '—', ...mentionedApps(p.text).map(u => u.replace('https://',''))].join(' + ')}`)
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
