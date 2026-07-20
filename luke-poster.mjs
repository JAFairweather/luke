// luke-poster.mjs — the "hands" of Luke's posting loop.
//
// The brain (a scheduled Claude routine) drafts a candidate post and POSTs
// it here. This module:
//   1. stores the pending draft and sends YOU a Telegram card (Approve/Reject),
//   2. on your Approve tap, signs the event with the ROLE key (Luke or Nave)
//      and broadcasts it to the relays,
//   3. never signs without your tap, and never for anyone but the approver.
//
// The role keys live only here (SOPS-decrypted env). The brain never holds
// them — it can only ever *propose*. Your tap is the authorization.
//
// Endpoints (wired in luke-service.mjs):
//   POST /propose          — brain → box. Bearer PROPOSE_TOKEN. Body:
//                            { identity: "luke"|"nave", text, rationale?, replyTo? }
//   POST /telegram/webhook — Telegram → box. Verified by secret-token header.

import { finalizeEvent, getPublicKey, verifyEvent, nip19 } from 'nostr-tools'
import { SimplePool } from 'nostr-tools/pool'
import { randomBytes, timingSafeEqual, createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'

// --- config -------------------------------------------------------------
const RELAYS = (process.env.LUKE_RELAYS ?? 'wss://relay.damus.io,wss://nos.lol,wss://relay.primal.net')
  .split(',').map(s => s.trim()).filter(Boolean)
const BOT = process.env.TELEGRAM_BOT_TOKEN?.trim()
const APPROVER = process.env.TELEGRAM_APPROVER_ID?.trim()
const PROPOSE_TOKEN = process.env.PROPOSE_TOKEN?.trim()
const WEBHOOK_SECRET = process.env.TELEGRAM_WEBHOOK_SECRET?.trim()
// Phase 2: if set, Telegram calls go THROUGH Nactor's broker (which holds the
// bot token in memory and injects it into the URL path), so the token need not
// live here. Signed NIP-98 as the activated `luke` identity.
const NACT_BROKER_URL = process.env.NACT_BROKER_URL?.trim()   // e.g. http://nactor:8791/api
// Phase 2: the brain authenticates to /propose by SIGNING (NIP-98) as `brain`
// instead of presenting a shared bearer token. We authorize its pubkey here.
const BRAIN_PK = (() => { const v = process.env.BRAIN_NPUB?.trim(); if (!v) return null; try { return v.startsWith('npub1') ? nip19.decode(v).data : (/^[0-9a-f]{64}$/i.test(v) ? v.toLowerCase() : null) } catch { return null } })()
const TG = m => `https://api.telegram.org/bot${BOT}/${m}`

function loadSecret(env) {
  const raw = process.env[env]?.trim()
  if (!raw) return null
  if (raw.startsWith('nsec1')) return nip19.decode(raw).data
  if (/^[0-9a-f]{64}$/i.test(raw)) return Uint8Array.from(raw.match(/.{1,2}/g).map(b => parseInt(b, 16)))
  return null
}

// The identities the poster can sign as: scope → { sk, npub }. nactjaf owns the
// Nact-Approvals telegram channel — the approval cards are sent as it.
const IDENTITIES = {}
for (const [scope, env] of [['luke', 'LUKE_NSEC'], ['nave', 'NAVE_NSEC'], ['nactjaf', 'NACTJAF_NSEC']]) {
  const sk = loadSecret(env)
  if (sk) IDENTITIES[scope] = { sk, pk: getPublicKey(sk), npub: nip19.npubEncode(getPublicKey(sk)) }
}
// The signer for the approvals telegram send: Nact_jaf (owns credential:telegram),
// falling back to luke during migration if that key isn't on-box yet.
const APPROVE_SK = (IDENTITIES.nactjaf || IDENTITIES.luke)?.sk

export function posterStatus() {
  const telegram = Boolean((BOT || NACT_BROKER_URL) && APPROVER)
  return {
    ready: Boolean(telegram && PROPOSE_TOKEN && Object.keys(IDENTITIES).length),
    identities: Object.keys(IDENTITIES),
    telegram,
    relays: RELAYS.length,
  }
}

// --- pending proposals ---------------------------------------------------
// Held in memory, but PERSISTED to a box-local file when PENDING_FILE is set, so
// a restart/deploy never drops a draft you haven't tapped yet. The TTL counts
// from the real created-time (which survives), so a proposal lives out its 36h
// regardless of how many times the service restarts. Unset → in-memory only
// (non-breaking).
const PENDING_FILE = process.env.PENDING_FILE?.trim()
const pending = new Map() // id -> { identity, text, replyTo, rationale, created }
const TTL_MS = 36 * 60 * 60 * 1000
function savePending() {
  if (!PENDING_FILE) return
  try { writeFileSync(PENDING_FILE, JSON.stringify([...pending.entries()])) }
  catch (e) { console.warn('  ⚠ pending save failed:', e.message) }
}
function loadPending() {
  if (!PENDING_FILE) return
  try {
    const now = Date.now()
    for (const [k, v] of JSON.parse(readFileSync(PENDING_FILE, 'utf8')))
      if (v?.created && now - v.created <= TTL_MS) pending.set(k, v)
    if (pending.size) console.log(`  ↺ restored ${pending.size} pending proposal(s) from ${PENDING_FILE}`)
  } catch { /* missing/corrupt → start empty */ }
}
function gc() {
  const now = Date.now(); let changed = false
  for (const [k, v] of pending) if (now - v.created > TTL_MS) { pending.delete(k); changed = true }
  if (changed) savePending()
}
loadPending()

const shortId = () => randomBytes(6).toString('base64url')
const esc = s => String(s).replace(/[<&>]/g, c => ({ '<': '&lt;', '&': '&amp;', '>': '&gt;' }[c]))

const sha256hex = s => createHash('sha256').update(s).digest('hex')
function brokerAuth(sk, httpMethod, url, bodyStr) {
  if (!sk) throw new Error('no signing identity for the broker request')
  const tags = [['u', url], ['method', httpMethod]]
  if (bodyStr) tags.push(['payload', sha256hex(bodyStr)])
  const ev = finalizeEvent({ kind: 27235, created_at: Math.floor(Date.now() / 1000), tags, content: '' }, sk)
  return 'Nostr ' + Buffer.from(JSON.stringify(ev)).toString('base64')
}
async function tg(method, body) {
  // Broker path (Phase 2): route through Nactor, which injects the bot token —
  // it never lives in this process. Signed NIP-98 as `luke`. If the broker path
  // errors AND we still hold the bot token, fall back to the direct call — a
  // safety net so switching the broker on can't drop approval cards. Once the
  // broker is proven stable and BOT is removed from the env, there's no fallback.
  if (NACT_BROKER_URL && APPROVE_SK) {
    try {
      const u = NACT_BROKER_URL.replace(/\/$/, '') + '/broker'
      const payload = JSON.stringify({ provider: 'telegram-nactjaf', tgMethod: method, method: 'POST', body })
      const r = await fetch(u, { method: 'POST', headers: { authorization: brokerAuth(APPROVE_SK, 'POST', u, payload), 'content-type': 'application/json' }, body: payload })
      if (r.ok) return true
      console.warn(`  ⚠ telegram(broker) ${method} → ${r.status} ${await r.text().catch(() => '')}`)
    } catch (e) { console.warn(`  ⚠ telegram(broker) ${method} threw: ${e?.message || e}`) }
    if (!BOT) return false
    console.warn(`  ↩ telegram ${method}: falling back to the direct call`)
  }
  if (!BOT) { console.warn(`  ⚠ telegram ${method}: no bot token and no broker configured`); return false }
  const r = await fetch(TG(method), {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  })
  if (!r.ok) console.warn(`  ⚠ telegram ${method} → ${r.status} ${await r.text().catch(() => '')}`)
  return r.ok
}

// Send YOU the draft as an Approve/Reject card.
async function sendCard(id, { identity, text, rationale }) {
  const idn = IDENTITIES[identity]
  const head = `📝 <b>Draft as ${identity}@nave.pub</b>\n<code>${idn.npub.slice(0, 16)}…</code>`
  const why = rationale ? `\n\n<i>${esc(rationale)}</i>` : ''
  const body = `${head}\n\n${esc(text)}${why}`
  return tg('sendMessage', {
    chat_id: APPROVER, text: body, parse_mode: 'HTML',
    reply_markup: { inline_keyboard: [[
      { text: '✅ Approve & post', callback_data: `ok:${id}` },
      { text: '❌ Reject', callback_data: `no:${id}` },
    ]] },
  })
}

// Register the Telegram webhook so approval taps actually reach
// /telegram/webhook. Runs on boot and is idempotent (Telegram overwrites). This
// is what keeps approvals alive across a bot/token change: without it, Telegram
// keeps pushing callbacks to a stale URL/bot and every tap silently vanishes.
// Registered via the broker as the SAME bot that sends the cards (telegram-nactjaf),
// so send-bot and receive-webhook are always the same identity.
const WEBHOOK_URL = process.env.LUKE_WEBHOOK_URL?.trim() || 'https://luke.nave.pub/telegram/webhook'
export async function registerWebhook() {
  if (!(BOT || NACT_BROKER_URL) || !APPROVER) { console.log('  webhook: skipped (telegram not configured)'); return false }
  const body = { url: WEBHOOK_URL, allowed_updates: ['callback_query'] }
  if (WEBHOOK_SECRET) body.secret_token = WEBHOOK_SECRET
  const ok = await tg('setWebhook', body)
  console.log(`  webhook: ${ok ? 'registered → ' + WEBHOOK_URL + (WEBHOOK_SECRET ? ' (secret set)' : '') : 'FAILED — approval taps will not arrive'}`)
  return ok
}

// --- POST /propose : the brain hands us a draft --------------------------
export async function handlePropose(req, res, raw) {
  if (!verifyProposeAuth(req, raw)) return json(res, 401, { why: 'unauthorized — sign NIP-98 as brain, or present the propose token' })
  let d; try { d = JSON.parse(raw) } catch { return json(res, 400, { why: 'bad json' }) }
  const identity = String(d.identity || '').toLowerCase()
  if (!IDENTITIES[identity]) return json(res, 400, { why: `unknown identity '${identity}'` })
  const text = String(d.text || '').trim()
  if (!text) return json(res, 400, { why: 'empty text' })
  if (!(BOT || NACT_BROKER_URL) || !APPROVER) return json(res, 503, { why: 'telegram not configured' })
  gc()
  const id = shortId()
  pending.set(id, { identity, text, replyTo: d.replyTo || null, rationale: d.rationale || null, created: Date.now() })
  savePending()
  const sent = await sendCard(id, { identity, text, rationale: d.rationale })
  if (!sent) { pending.delete(id); savePending(); return json(res, 502, { why: 'telegram send failed' }) }
  return json(res, 200, { ok: true, id, status: 'awaiting-approval' })
}

// --- POST /telegram/webhook : your tap arrives ---------------------------
export async function handleTelegramWebhook(req, res, raw) {
  if (WEBHOOK_SECRET && req.headers['x-telegram-bot-api-secret-token'] !== WEBHOOK_SECRET)
    return res.writeHead(401).end()
  let update; try { update = JSON.parse(raw) } catch { return res.writeHead(400).end() }
  res.writeHead(200).end() // ack fast; process below

  const cq = update.callback_query
  if (!cq) return
  const fromId = String(cq.from?.id || '')
  const data = cq.data || ''
  const answer = (text) => tg('answerCallbackQuery', { callback_query_id: cq.id, text })
  const editDone = (mark) => tg('editMessageText', {
    chat_id: cq.message.chat.id, message_id: cq.message.message_id,
    // esc() the original (Telegram returns it as plain text) so a draft with
    // < or & can't break HTML parse; mark carries the only live HTML tags.
    text: `${esc(cq.message.text)}\n\n${mark}`, parse_mode: 'HTML',
  })

  if (APPROVER && fromId !== APPROVER) { await answer('Not authorized.'); return }
  const [verb, id] = data.split(':')
  const p = pending.get(id)
  if (!p) { await answer('This draft has expired.'); return }
  pending.delete(id); savePending()

  if (verb === 'no') { await answer('Discarded.'); await editDone('❌ <b>Discarded</b>'); return }
  if (verb === 'ok') {
    try {
      const { evt, seen } = await signAndBroadcast(p)
      await answer(`Posted to ${seen} relays.`)
      await editDone(`✅ <b>Posted</b> · <code>${nip19.noteEncode(evt.id).slice(0, 20)}…</code> · ${seen} relays`)
    } catch (e) {
      await answer('Publish failed.')
      await editDone(`⚠️ <b>Publish failed:</b> ${esc(e.message || e)}`)
    }
  }
}

const pool = new SimplePool()
async function signAndBroadcast({ identity, text, replyTo }) {
  const { sk } = IDENTITIES[identity]
  const tags = []
  if (replyTo) tags.push(['e', replyTo, '', 'root'])
  const evt = finalizeEvent({ kind: 1, created_at: Math.floor(Date.now() / 1000), tags, content: text }, sk)
  const results = await Promise.allSettled(pool.publish(RELAYS, evt))
  const seen = results.filter(r => r.status === 'fulfilled').length
  if (seen === 0) throw new Error('no relay accepted the event')
  return { evt, seen }
}

// --- helpers ------------------------------------------------------------
function json(res, code, obj) { res.writeHead(code, { 'content-type': 'application/json' }).end(JSON.stringify(obj)) }
function constantEq(a, b) {
  const x = Buffer.from(a || ''), y = Buffer.from(b || '')
  return x.length === y.length && timingSafeEqual(x, y)
}
// Authorize POST /propose. Preferred: a NIP-98 (kind 27235) signature from the
// `brain` identity, binding this exact body (payload hash) and freshness — no
// shared secret. Fallback (pre-migration): the bearer PROPOSE_TOKEN.
function verifyProposeAuth(req, raw) {
  const h = req.headers['authorization'] || ''
  if (h.startsWith('Nostr ') && BRAIN_PK) {
    try {
      const ev = JSON.parse(Buffer.from(h.slice(6).trim(), 'base64').toString('utf8'))
      const tag = n => (ev.tags.find(t => t[0] === n) || [])[1]
      if (ev.kind !== 27235 || ev.pubkey !== BRAIN_PK || !verifyEvent(ev)) return false
      if (Math.abs(Math.floor(Date.now() / 1000) - (ev.created_at || 0)) > 60) return false
      if ((tag('method') || '').toUpperCase() !== 'POST') return false
      let uPath; try { uPath = new URL(tag('u')).pathname } catch { return false }
      if (uPath !== '/propose') return false
      if (raw && raw.length && tag('payload') !== sha256hex(raw)) return false
      return true
    } catch { return false }
  }
  const bearer = h.replace(/^Bearer\s+/i, '')
  return Boolean(PROPOSE_TOKEN && constantEq(bearer, PROPOSE_TOKEN))
}
