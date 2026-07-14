// luke-brain.mjs — the "brain" of Luke's posting loop.
//
// Runs on a schedule (twice a day). Gathers the day's signals, drafts 1–3
// candidate posts in our voice, and POSTs each to Luke's /propose endpoint —
// which sends them to you on Telegram to approve. The brain holds NO signing
// key; it can only propose. Your tap does the rest.
//
// Signals (all public — no private data):
//   • themes/voice corpus   brief/voice.md
//   • ecosystem shipping     recent commits across the nave repos (GitHub)
//   • Substack               your blog's RSS
//   • nostr engagement       replies/reactions on Luke & Nave (relays)
//
//   node luke-brain.mjs --dry-run     # gather + draft + print, don't propose
//   node luke-brain.mjs               # also POST each draft to /propose

import { readFile } from 'node:fs/promises'
import { getPublicKey, nip19 } from 'nostr-tools'
import { SimplePool } from 'nostr-tools/pool'

const DRY = process.argv.includes('--dry-run')
const log = (...a) => console.log(...a)

// --- config -------------------------------------------------------------
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY?.trim()
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
async function signalEngagement(pks) {
  const authors = Object.values(pks); if (!authors.length) return []
  const pool = new SimplePool()
  try {
    const events = await pool.querySync(RELAYS, { kinds: [1], '#p': authors, since: sinceSec }, { maxWait: 4000 })
    return events
      .filter(e => !authors.includes(e.pubkey)) // others' replies/mentions, not our own
      .slice(0, 12)
      .map(e => ({ id: e.id, by: nip19.npubEncode(e.pubkey).slice(0, 12) + '…', text: (e.content || '').slice(0, 240) }))
  } catch { return [] }
  finally { pool.close(RELAYS) }
}

// --- draft via Anthropic ------------------------------------------------
async function draftPosts(corpus, signals) {
  if (!ANTHROPIC_API_KEY) throw new Error('ANTHROPIC_API_KEY not set')
  const system = `You draft short nostr posts for two identities on "the Nave": \
"nave" (the project's voice) and "luke" (a delegated agent). Follow this voice corpus EXACTLY:\n\n${corpus}\n\n\
You will receive today's signals. Propose AT MOST ${MAX_POSTS} posts — fewer is better; propose zero if the \
signals are thin. Each post must stand alone, sound like the corpus (no hype, no emoji spam), and be genuinely \
worth posting. Write channel-appropriately — use what a channel's readers expect and skip what they wouldn't. \
You are drafting for nostr right now: NEVER add a #nostr hashtag (on nostr it reads like #twitter on Twitter — the \
same tag could be right on a different platform like Twitter/X, but here it is noise). Never tag the platform you \
are posting on, and on nostr use any hashtag only when it genuinely aids discovery. \
For an engagement follow-up, set "replyTo" to that event id and pick the right identity to answer as.\n\n\
Return ONLY a JSON array, no prose, no code fence. Each element:\n\
{"identity":"nave"|"luke","text":"the post","rationale":"one line: why this, for your human approver","replyTo":"<event id or omit>"}`

  const user = `TODAY'S SIGNALS (window: last ${SINCE_HOURS}h)\n\n` +
    `## Ecosystem shipping (recent commits)\n${signals.shipping.length ? signals.shipping.map(s => `- [${s.repo}] ${s.msg}`).join('\n') : '(nothing notable)'}\n\n` +
    `## New Substack posts\n${signals.substack.length ? signals.substack.map(s => `- ${s.title} — ${s.link}`).join('\n') : '(none)'}\n\n` +
    `## Engagement to consider replying to\n${signals.engagement.length ? signals.engagement.map(e => `- (${e.id}) ${e.by}: ${e.text}`).join('\n') : '(none)'}`

  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'x-api-key': ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
    body: JSON.stringify({ model: DRAFT_MODEL, max_tokens: 1400, system, messages: [{ role: 'user', content: user }] }),
  })
  if (!r.ok) throw new Error(`anthropic ${r.status}: ${await r.text().catch(() => '')}`)
  const j = await r.json()
  const text = (j.content || []).map(c => c.text || '').join('').trim()
  const jsonStr = text.replace(/^```(?:json)?/i, '').replace(/```$/, '').trim()
  let arr; try { arr = JSON.parse(jsonStr) } catch { throw new Error(`model did not return JSON:\n${text}`) }
  return Array.isArray(arr) ? arr : []
}

// --- propose ------------------------------------------------------------
async function propose(p) {
  const r = await fetch(PROPOSE_URL, {
    method: 'POST',
    headers: { 'authorization': `Bearer ${PROPOSE_TOKEN}`, 'content-type': 'application/json' },
    body: JSON.stringify({ identity: p.identity, text: p.text, rationale: p.rationale, replyTo: p.replyTo || null }),
  })
  const body = await r.json().catch(() => ({}))
  return { ok: r.ok, status: r.status, body }
}

// --- run ----------------------------------------------------------------
const corpus = await readFile(new URL('./brief/voice.md', import.meta.url), 'utf8').catch(() => '')
if (!corpus) log('  ⚠ brief/voice.md not found — drafting without the voice corpus')
const pks = pubkeys()

log(`\n  luke-brain — gathering signals (last ${SINCE_HOURS}h)…`)
const [shipping, substack, engagement] = await Promise.all([signalShipping(), signalSubstack(), signalEngagement(pks)])
log(`  shipping: ${shipping.length} commits · substack: ${substack.length} posts · engagement: ${engagement.length} notes`)

const candidates = await draftPosts(corpus, { shipping, substack, engagement })
log(`  drafted ${candidates.length} candidate(s)\n`)

for (const [i, p] of candidates.entries()) {
  log(`  [${i + 1}] as ${p.identity}${p.replyTo ? ' (reply)' : ''}: ${p.text}`)
  log(`      ↳ ${p.rationale || ''}`)
  if (DRY) continue
  if (!PROPOSE_TOKEN) { log('      ⚠ PROPOSE_TOKEN unset — not proposing'); continue }
  const res = await propose(p)
  log(`      → ${res.ok ? `proposed (id ${res.body.id}) — awaiting your Telegram tap` : `FAILED ${res.status}: ${JSON.stringify(res.body)}`}`)
}

log(`\n  done — ${DRY ? 'dry run, nothing proposed' : `${candidates.length} sent to Telegram for approval`}.\n`)
process.exit(0)
