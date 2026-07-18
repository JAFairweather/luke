// luke-morning.mjs — the unified morning brief (one message, whole morning).
//
// Sections (per James's steering, 2026-07-17):
//   🗓 calendar   — today's events via Nactor's gcal broker (creds stay in Nactor)
//   📧 email      — label-aware via himalaya (IMAP read-only). James's inbox is
//                   managed by Cora, which auto-labels most mail on arrival — so
//                   INBOX alone is nearly empty signal. We read the "Next Brief"
//                   label (Cora's queue) first, then INBOX unseen. SUMMARIZE ONLY:
//                   no drafting yet, and sending is impossible (no SMTP config).
//   ☀️ weather    — wttr.in, only when WEATHER_LOC is set (no IP-geo guessing)
//   📌 nudges     — reads /state/nudges.md if present (CRM loop will write it)
//   🎸 interests  — reads /state/interests.md if present (tour watcher will write it)
// Missing/empty sections are omitted, never padded.
//
//   node luke-morning.mjs --dry-run    # print, don't send
//
// Auth: NIP-98 as `brain` (BRAIN_NSEC) for both broker calls; delivery to
// TELEGRAM_APPROVER_ID via the telegram broker. Private data → only to you.

import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { finalizeEvent, nip19 } from 'nostr-tools'

const DRY = process.argv.includes('--dry-run')
const log = (...a) => console.log(...a)

const NACT_BROKER_URL = process.env.NACT_BROKER_URL?.trim()
const BRAIN_NSEC = process.env.BRAIN_NSEC?.trim()
const APPROVER = process.env.TELEGRAM_APPROVER_ID?.trim()
const CAL_ID = process.env.CAL_ID?.trim() || 'primary'
const CAL_TZ = process.env.CAL_TZ?.trim() || 'America/New_York'
const CAL_MAX = Math.min(50, Math.max(1, Number(process.env.CAL_MAX ?? 25)))
const HIMALAYA = process.env.HIMALAYA_BIN?.trim() || 'himalaya'
// Cora's queue label first; INBOX unseen second. Override via MAIL_FOLDERS.
const MAIL_FOLDERS = (process.env.MAIL_FOLDERS?.trim() || 'Next Brief,INBOX')
  .split(',').map(s => s.trim()).filter(Boolean)
const MAIL_PER_FOLDER = Math.min(10, Math.max(1, Number(process.env.MAIL_PER_FOLDER ?? 5)))
const WEATHER_LOC = process.env.WEATHER_LOC?.trim()
const NUDGES_FILE = process.env.NUDGES_FILE?.trim() || '/state/nudges.md'
const INTERESTS_FILE = process.env.INTERESTS_FILE?.trim() || '/state/interests.md'

if (!NACT_BROKER_URL || !BRAIN_NSEC) { console.error('  ✗ need NACT_BROKER_URL + BRAIN_NSEC'); process.exit(1) }

// --- broker (NIP-98 as brain) -------------------------------------------
const sha256hex = s => createHash('sha256').update(s).digest('hex')
const SK = (() => {
  if (BRAIN_NSEC.startsWith('nsec1')) return nip19.decode(BRAIN_NSEC).data
  if (/^[0-9a-f]{64}$/i.test(BRAIN_NSEC)) return Uint8Array.from(BRAIN_NSEC.match(/.{1,2}/g).map(b => parseInt(b, 16)))
  throw new Error('BRAIN_NSEC must be nsec1… or 64-hex')
})()
async function broker(inner) {
  const u = NACT_BROKER_URL.replace(/\/$/, '') + '/broker'
  const body = JSON.stringify(inner)
  const tags = [['u', u], ['method', 'POST'], ['payload', sha256hex(body)]]
  const ev = finalizeEvent({ kind: 27235, created_at: Math.floor(Date.now() / 1000), tags, content: '' }, SK)
  const auth = 'Nostr ' + Buffer.from(JSON.stringify(ev)).toString('base64')
  const r = await fetch(u, { method: 'POST', headers: { authorization: auth, 'content-type': 'application/json' }, body })
  const text = await r.text().catch(() => '')
  let json = null; try { json = JSON.parse(text) } catch { }
  return { ok: r.ok, status: r.status, json, text }
}

// --- time helpers --------------------------------------------------------
function tzOffset(tz, at) {
  const p = new Intl.DateTimeFormat('en-US', { timeZone: tz, timeZoneName: 'longOffset' }).formatToParts(at)
  const m = ((p.find(x => x.type === 'timeZoneName') || {}).value || '').match(/GMT([+-]\d{2}:?\d{2})?/)
  if (!m || !m[1]) return '+00:00'
  return m[1].includes(':') ? m[1] : m[1].slice(0, 3) + ':' + m[1].slice(3)
}
function ymd(tz, at) {
  const p = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(at)
  const g = t => (p.find(x => x.type === t) || {}).value
  return `${g('year')}-${g('month')}-${g('day')}`
}
const esc = s => String(s).replace(/[<&>]/g, c => ({ '<': '&lt;', '&': '&amp;', '>': '&gt;' }[c]))
const hhmm = iso => new Intl.DateTimeFormat('en-US', { timeZone: CAL_TZ, hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(iso))

// --- section: calendar ---------------------------------------------------
async function calendarSection() {
  try {
    const now = new Date(), off = tzOffset(CAL_TZ, now), today = ymd(CAL_TZ, now)
    const end = new Date(Date.parse(`${today}T00:00:00${off}`) + 86400000)
    const qs = new URLSearchParams({
      timeMin: `${today}T00:00:00${off}`, timeMax: `${ymd(CAL_TZ, end)}T00:00:00${tzOffset(CAL_TZ, end)}`,
      singleEvents: 'true', orderBy: 'startTime', maxResults: String(CAL_MAX), timeZone: CAL_TZ,
    }).toString()
    const r = await broker({ provider: 'gcal', path: `/calendar/v3/calendars/${encodeURIComponent(CAL_ID)}/events?${qs}`, method: 'GET' })
    if (!r.ok) return { title: '🗓 Today', lines: [`(calendar unavailable: ${r.status})`] }
    const items = (r.json && r.json.items) || []
    if (!items.length) return { title: '🗓 Today', lines: ['Clear calendar.'] }
    return {
      title: '🗓 Today', lines: items.map(ev => {
        const t = esc(ev.summary || '(no title)')
        if (ev.start?.date) return `• <b>all day</b>  ${t}`
        const when = ev.start?.dateTime ? (ev.end?.dateTime ? `${hhmm(ev.start.dateTime)}–${hhmm(ev.end.dateTime)}` : hhmm(ev.start.dateTime)) : '—'
        return `• <code>${when}</code>  ${t}`
      })
    }
  } catch (e) { return { title: '🗓 Today', lines: [`(calendar error: ${esc(e.message || e)})`] } }
}

// --- section: email (himalaya, label-aware for Cora) ---------------------
function him(args) {
  return new Promise(resolve => {
    execFile(HIMALAYA, args, { timeout: 30000, maxBuffer: 4 * 1024 * 1024 }, (err, stdout) => {
      if (err && !stdout) return resolve(null)
      try { resolve(JSON.parse(stdout)) } catch { resolve(null) }
    })
  })
}
async function emailSection() {
  const lines = []
  for (const folder of MAIL_FOLDERS) {
    // INBOX: only unseen matters. Cora labels (e.g. "Next Brief"): latest items.
    const args = ['envelope', 'list', '-f', folder, '-s', String(MAIL_PER_FOLDER), '-o', 'json']
    if (folder.toUpperCase() === 'INBOX') args.push('not', 'seen')
    const envs = await him(args)
    if (!Array.isArray(envs) || !envs.length) continue
    lines.push(`<u>${esc(folder)}</u>`)
    for (const e of envs.slice(0, MAIL_PER_FOLDER)) {
      const from = esc(e.from?.name || e.from?.addr || 'unknown')
      const subj = esc(e.subject || '(no subject)')
      lines.push(`• <b>${from}</b> — ${subj}`)
    }
  }
  if (!lines.length) return null
  return { title: '📧 Mail (read-only; Cora runs the inbox)', lines }
}

// --- section: weather ----------------------------------------------------
async function weatherSection() {
  if (!WEATHER_LOC) return null
  try {
    const r = await fetch(`https://wttr.in/${encodeURIComponent(WEATHER_LOC)}?format=j1`, { headers: { 'user-agent': 'luke-morning' } })
    if (!r.ok) return null
    const j = await r.json()
    const c = j.current_condition?.[0], d = j.weather?.[0]
    if (!c) return null
    const desc = c.weatherDesc?.[0]?.value || ''
    return { title: '☀️ Weather', lines: [`${esc(WEATHER_LOC)}: ${c.temp_F}°F ${esc(desc)} · hi ${d?.maxtempF}° lo ${d?.mintempF}°`] }
  } catch { return null }
}

// --- sections from state files (written by later systems) ----------------
async function fileSection(path, title) {
  try {
    const t = (await readFile(path, 'utf8')).trim()
    if (!t) return null
    return { title, lines: t.split('\n').slice(0, 8).map(l => esc(l)) }
  } catch { return null }
}

// --- run -----------------------------------------------------------------
const day = new Intl.DateTimeFormat('en-US', { timeZone: CAL_TZ, weekday: 'long', month: 'long', day: 'numeric' }).format(new Date())
log(`\n  luke-morning — assembling the brief (${day})…`)
const sections = (await Promise.all([
  calendarSection(),
  emailSection(),
  fileSection(NUDGES_FILE, '📌 Nudges'),
  fileSection(INTERESTS_FILE, '🎸 Interests'),
  weatherSection(),
])).filter(Boolean)

const text = `☀️ <b>Morning, James</b> — ${day}\n\n` +
  sections.map(s => `<b>${s.title}</b>\n${s.lines.join('\n')}`).join('\n\n')

log(`  sections: ${sections.map(s => s.title.replace(/<[^>]+>/g, '')).join(' · ') || '(none)'}`)
if (DRY) { log('\n----- brief (dry run) -----\n' + text.replace(/<[^>]+>/g, '') + '\n---------------------------\n'); process.exit(0) }
if (!APPROVER) { log('  ⚠ TELEGRAM_APPROVER_ID unset — not sending'); process.exit(1) }
const r = await broker({ provider: 'telegram', tgMethod: 'sendMessage', method: 'POST', body: { chat_id: APPROVER, text, parse_mode: 'HTML', disable_web_page_preview: true } })
log(r.ok ? '  → sent.\n' : `  ✗ send failed ${r.status}: ${r.text.slice(0, 120)}\n`)
process.exit(r.ok ? 0 : 1)
