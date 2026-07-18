// luke-calendar.mjs — Luke's private daily agenda beat.
//
// Runs on a morning schedule. Reads the day's events from Google Calendar
// THROUGH Nactor's `gcal` broker (Nactor holds the OAuth refresh bundle and mints
// a short-lived token; this script never sees a credential), formats a compact
// briefing, and sends it privately to you on Telegram via the `telegram` broker.
//
// This is PRIVATE data. Unlike luke-brain (public post signals), the agenda is
// NEVER proposed or posted — it only ever goes to TELEGRAM_APPROVER_ID (you).
//
//   node luke-calendar.mjs --dry-run   # fetch + format + print, don't send
//   node luke-calendar.mjs             # also send the briefing to your Telegram
//
// Auth: signs each broker call as the credential's OWNER (credential sovereignty)
// — the calendar read as `luke` (LUKE_NSEC), the Nact-Approvals Telegram send as
// `Nact_jaf` (NACTJAF_NSEC) once that key is on-box, with brain/luke as migration
// fallbacks. Under ownership enforcement the broker checks the caller holds a
// grant for the credential, so the signer must match the manifest.

import { createHash } from 'node:crypto'
import { finalizeEvent, nip19 } from 'nostr-tools'

const DRY = process.argv.includes('--dry-run')
const log = (...a) => console.log(...a)

// --- config -------------------------------------------------------------
const NACT_BROKER_URL = process.env.NACT_BROKER_URL?.trim()          // http://nactor:8791/api
const LUKE_NSEC = process.env.LUKE_NSEC?.trim()                      // reads the calendar (gcal is Luke's I/O)
const NACTJAF_NSEC = process.env.NACTJAF_NSEC?.trim()               // owns the Nact-Approvals telegram (once provisioned)
const BRAIN_NSEC = process.env.BRAIN_NSEC?.trim()                    // migration fallback
const APPROVER = process.env.TELEGRAM_APPROVER_ID?.trim()            // your Telegram chat id
const CAL_ID = process.env.CAL_ID?.trim() || 'primary'
const CAL_TZ = process.env.CAL_TZ?.trim() || process.env.TZ?.trim() || 'America/New_York'
const CAL_DAYS = Math.max(1, Number(process.env.CAL_DAYS ?? 1))     // 1 = today; 2 = today+tomorrow
const CAL_MAX = Math.min(50, Math.max(1, Number(process.env.CAL_MAX ?? 25)))

if (!NACT_BROKER_URL || !(LUKE_NSEC || BRAIN_NSEC)) {
  console.error('  ✗ need NACT_BROKER_URL + LUKE_NSEC (the broker path). Nothing to do.')
  process.exit(1)
}

// --- broker auth — sign each call as the credential's OWNER (sovereignty) ----
// gcal is Luke's I/O → sign as luke; the Nact-Approvals telegram send → sign as
// Nact_jaf (falling back to luke/brain until that key is on-box). Under ownership
// enforcement the broker checks the caller holds a grant for the credential, so
// the signer must match the manifest.
const sha256hex = s => createHash('sha256').update(s).digest('hex')
const loadSk = v => {
  if (!v) return null
  if (v.startsWith('nsec1')) return nip19.decode(v).data
  if (/^[0-9a-f]{64}$/i.test(v)) return Uint8Array.from(v.match(/.{1,2}/g).map(b => parseInt(b, 16)))
  throw new Error('nsec must be nsec1… or 64-hex')
}
const LUKE_SK = loadSk(LUKE_NSEC)
const BRAIN_SK = loadSk(BRAIN_NSEC)
const LUKE_OR_BRAIN = LUKE_SK || BRAIN_SK                       // the calendar reader (luke), brain as fallback
const APPROVE_SK = loadSk(NACTJAF_NSEC) || LUKE_OR_BRAIN        // the approvals telegram — Nact_jaf when present
function brokerAuth(url, bodyStr, sk) {
  const tags = [['u', url], ['method', 'POST']]
  if (bodyStr) tags.push(['payload', sha256hex(bodyStr)])
  const ev = finalizeEvent({ kind: 27235, created_at: Math.floor(Date.now() / 1000), tags, content: '' }, sk)
  return 'Nostr ' + Buffer.from(JSON.stringify(ev)).toString('base64')
}
// One RPC to Nactor's broker. `inner` is the { provider, path/tgMethod, method, body }
// envelope the broker forwards; `sk` is the identity to sign as. Returns { ok, status, json, text }.
async function broker(inner, sk = LUKE_OR_BRAIN) {
  const u = NACT_BROKER_URL.replace(/\/$/, '') + '/broker'
  const body = JSON.stringify(inner)
  const r = await fetch(u, { method: 'POST', headers: { authorization: brokerAuth(u, body, sk), 'content-type': 'application/json' }, body })
  const text = await r.text().catch(() => '')
  let json = null; try { json = JSON.parse(text) } catch { /* non-json */ }
  return { ok: r.ok, status: r.status, json, text }
}

// --- time helpers (timezone-aware, no external lib) ---------------------
// The numeric UTC offset for CAL_TZ at a given instant, as "+HH:MM" / "-HH:MM".
function tzOffset(tz, at) {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: tz, timeZoneName: 'longOffset' }).formatToParts(at)
  const name = (parts.find(p => p.type === 'timeZoneName') || {}).value || 'GMT+00:00'
  const m = name.match(/GMT([+-]\d{2}:?\d{2})?/)
  if (!m || !m[1]) return '+00:00'
  return m[1].includes(':') ? m[1] : m[1].slice(0, 3) + ':' + m[1].slice(3)
}
// The Y-M-D of an instant, as seen in CAL_TZ.
function ymd(tz, at) {
  const p = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(at)
  const g = t => (p.find(x => x.type === t) || {}).value
  return `${g('year')}-${g('month')}-${g('day')}`
}
// Start-of-today (local) and end-of-window as RFC3339 instants with the local offset.
function windowRFC3339() {
  const now = new Date()
  const off = tzOffset(CAL_TZ, now)
  const today = ymd(CAL_TZ, now)
  const timeMin = `${today}T00:00:00${off}`
  // end = start of (today + CAL_DAYS) local — captures full days inclusive.
  const endInstant = new Date(Date.parse(`${today}T00:00:00${off}`) + CAL_DAYS * 86400000)
  const endYmd = ymd(CAL_TZ, endInstant)
  const endOff = tzOffset(CAL_TZ, endInstant)
  const timeMax = `${endYmd}T00:00:00${endOff}`
  return { timeMin, timeMax, today }
}

// --- fetch the day's events --------------------------------------------
async function fetchEvents() {
  const { timeMin, timeMax } = windowRFC3339()
  const qs = new URLSearchParams({
    timeMin, timeMax, singleEvents: 'true', orderBy: 'startTime',
    maxResults: String(CAL_MAX), timeZone: CAL_TZ,
  }).toString()
  const path = `/calendar/v3/calendars/${encodeURIComponent(CAL_ID)}/events?${qs}`
  const r = await broker({ provider: 'gcal', path, method: 'GET' })
  if (!r.ok) throw new Error(`gcal ${r.status}: ${(r.json && (r.json.error?.message || r.json.error)) || r.text.slice(0, 160)}`)
  return { items: (r.json && r.json.items) || [], calendar: (r.json && r.json.summary) || CAL_ID }
}

// --- format the briefing ------------------------------------------------
const esc = s => String(s).replace(/[<&>]/g, c => ({ '<': '&lt;', '&': '&amp;', '>': '&gt;' }[c]))
function hhmm(iso) {
  return new Intl.DateTimeFormat('en-US', { timeZone: CAL_TZ, hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(iso))
}
function dayLabel(dateStr) {
  // dateStr is Y-M-D; render as "Fri, Jul 18" in CAL_TZ (noon avoids DST edges).
  return new Intl.DateTimeFormat('en-US', { timeZone: CAL_TZ, weekday: 'short', month: 'short', day: 'numeric' }).format(new Date(dateStr + 'T12:00:00'))
}
function eventLine(ev) {
  const title = esc(ev.summary || '(no title)')
  const loc = ev.location ? `  · ${esc(String(ev.location).split(',')[0])}` : ''
  if (ev.start?.date) return `• <b>all day</b>  ${title}${loc}`            // all-day event
  const s = ev.start?.dateTime, e = ev.end?.dateTime
  const when = s ? (e ? `${hhmm(s)}–${hhmm(e)}` : hhmm(s)) : '—'
  return `• <code>${when}</code>  ${title}${loc}`
}
function briefing(items, today) {
  const head = `🗓 <b>Your day</b> — ${dayLabel(today)}`
  if (!items.length) return `${head}\n\nNothing on the calendar. Clear day.`
  // Group by local date so a 2-day window is readable.
  const byDay = new Map()
  for (const ev of items) {
    const key = ev.start?.date || ymd(CAL_TZ, new Date(ev.start?.dateTime || Date.now()))
    if (!byDay.has(key)) byDay.set(key, [])
    byDay.get(key).push(ev)
  }
  const blocks = [...byDay.keys()].sort().map(k => {
    const lines = byDay.get(k).map(eventLine).join('\n')
    return byDay.size > 1 ? `<u>${dayLabel(k)}</u>\n${lines}` : lines
  })
  const n = items.length
  return `${head}\n\n${blocks.join('\n\n')}\n\n— ${n} event${n === 1 ? '' : 's'}`
}

// --- deliver ------------------------------------------------------------
async function send(text) {
  if (!APPROVER) { log('  ⚠ TELEGRAM_APPROVER_ID unset — printing instead of sending.'); log('\n' + text + '\n'); return false }
  const r = await broker({ provider: 'telegram', tgMethod: 'sendMessage', method: 'POST', body: { chat_id: APPROVER, text, parse_mode: 'HTML', disable_web_page_preview: true } }, APPROVE_SK)
  if (!r.ok) { log(`  ✗ telegram send failed ${r.status}: ${r.text.slice(0, 160)}`); return false }
  return true
}

// --- run ----------------------------------------------------------------
try {
  log(`\n  luke-calendar — reading ${CAL_ID} (${CAL_TZ}, ${CAL_DAYS} day${CAL_DAYS === 1 ? '' : 's'})…`)
  const { items, calendar } = await fetchEvents()
  const { today } = windowRFC3339()
  log(`  ${items.length} event(s) on "${calendar}"`)
  const text = briefing(items, today)
  if (DRY) { log('\n----- briefing (dry run) -----\n' + text.replace(/<[^>]+>/g, '') + '\n------------------------------\n'); process.exit(0) }
  const sent = await send(text)
  log(sent ? '  → sent to your Telegram.\n' : '  → not sent (see above).\n')
  process.exit(sent ? 0 : 1)
} catch (e) {
  console.error(`  ✗ ${e?.message || e}`)
  process.exit(1)
}
