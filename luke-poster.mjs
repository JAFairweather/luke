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

import { finalizeEvent, getPublicKey, nip19 } from 'nostr-tools'
import { SimplePool } from 'nostr-tools/pool'
import { randomBytes, timingSafeEqual, createHash } from 'node:crypto'

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
const TG = m => `https://api.telegram.org/bot${BOT}/${m}`

function loadSecret(env) {
  const raw = process.env[env]?.trim()
  if (!raw) return null
  if (raw.startsWith('nsec1')) return nip19.decode(raw).data
  if (/^[0-9a-f]{64}$/i.test(raw)) return Uint8Array.from(raw.match(/.{1,2}/g).map(b => parseInt(b, 16)))
  return null
}

// The identities the poster can sign as: scope → { sk, npub }.
const IDENTITIES = {}
for (const [scope, env] of [['luke', 'LUKE_NSEC'], ['nave', 'NAVE_NSEC']]) {
  const sk = loadSecret(env)
  if (sk) IDENTITIES[scope] = { sk, pk: getPublicKey(sk), npub: nip19.npubEncode(getPublicKey(sk)) }
}

export function posterStatus() {
  const telegram = Boolean((BOT || NACT_BROKER_URL) && APPROVER)
  return {
    ready: Boolean(telegram && PROPOSE_TOKEN && Object.keys(IDENTITIES).length),
    identities: Object.keys(IDENTITIES),
    telegram,
    relays: RELAYS.length,
  }
}

// --- pending proposals (in-memory; a mid-day restart drops unresolved ones) ---
const pending = new Map() // id -> { identity, text, replyTo, created }
const TTL_MS = 36 * 60 * 60 * 1000
function gc() { const now = Date.now(); for (const [k, v] of pending) if (now - v.created > TTL_MS) pending.delete(k) }

const shortId = () => randomBytes(6).toString('base64url')
const esc = s => String(s).replace(/[<&>]/g, c => ({ '<': '&lt;', '&': '&amp;', '>': '&gt;' }[c]))

const sha256hex = s => createHash('sha256').update(s).digest('hex')
function lukeBrokerAuth(httpMethod, url, bodyStr) {
  const sk = IDENTITIES.luke?.sk
  if (!sk) throw new Error('no luke identity to sign the broker request')
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
  if (NACT_BROKER_URL && IDENTITIES.luke) {
    try {
      const u = NACT_BROKER_URL.replace(/\/$/, '') + '/broker'
      const payload = JSON.stringify({ provider: 'telegram', tgMethod: method, method: 'POST', body })
      const r = await fetch(u, { method: 'POST', headers: { authorization: lukeBrokerAuth('POST', u, payload), 'content-type': 'application/json' }, body: payload })
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

// --- POST /propose : the brain hands us a draft --------------------------
export async function handlePropose(req, res, raw) {
  const auth = (req.headers['authorization'] || '').replace(/^Bearer\s+/i, '')
  if (!PROPOSE_TOKEN || !constantEq(auth, PROPOSE_TOKEN)) return json(res, 401, { why: 'bad propose token' })
  let d; try { d = JSON.parse(raw) } catch { return json(res, 400, { why: 'bad json' }) }
  const identity = String(d.identity || '').toLowerCase()
  if (!IDENTITIES[identity]) return json(res, 400, { why: `unknown identity '${identity}'` })
  const text = String(d.text || '').trim()
  if (!text) return json(res, 400, { why: 'empty text' })
  if (!BOT || !APPROVER) return json(res, 503, { why: 'telegram not configured' })
  gc()
  const id = shortId()
  pending.set(id, { identity, text, replyTo: d.replyTo || null, rationale: d.rationale || null, created: Date.now() })
  const sent = await sendCard(id, { identity, text, rationale: d.rationale })
  if (!sent) { pending.delete(id); return json(res, 502, { why: 'telegram send failed' }) }
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
  pending.delete(id)

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
