// luke-morning.mjs — the unified morning brief (one message, whole morning).
//
// Sections (per James's steering, 2026-07-17):
//   🗓 calendar   — today's events via Nactor's gcal broker (creds stay in Nactor)
//   📧 email      — label-aware via himalaya (IMAP read-only). James's inbox is
//                   managed by Cora, which auto-labels most mail on arrival — so
//                   INBOX alone is nearly empty signal. We read the "Next Brief"
//                   label (Cora's queue) first, then INBOX unseen. SUMMARIZE ONLY:
//                   no drafting yet, and sending is impossible (no SMTP config).
//   ☀️ weather    — Milford CT + Sámara CR with tides (Open-Meteo + NOAA, keyless)
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
const MAIL_FOLDERS = (process.env.MAIL_FOLDERS?.trim() || '📥 Next Brief,INBOX')
  .split(',').map(s => s.trim()).filter(Boolean)
const MAIL_PER_FOLDER = Math.min(10, Math.max(1, Number(process.env.MAIL_PER_FOLDER ?? 5)))
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
    // Latest items per folder. Cora's labels are emoji-prefixed ("📥 Next Brief");
    // INBOX stays lean under Cora, so latest-N is honest signal there too.
    const args = ['envelope', 'list', '-f', folder, '-s', String(MAIL_PER_FOLDER), '-o', 'json']
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

// --- section: weather + tides (James's two shores) ------------------------
// Milford CT (home, Long Island Sound) + Sámara CR (Esterones). Forecast via
// Open-Meteo (keyless, unambiguous coords). Tides: NOAA CO-OPS hi/lo
// predictions for Milford (Bridgeport station 8467150, the local reference);
// Open-Meteo marine sea-level extrema for Sámara (NOAA is US-only) — hourly
// resolution, so those times are ≈. Both APIs return LOCAL times as strings.
const SHORES = [
  { name: 'Milford CT', lat: 41.222, lon: -73.057, tz: 'America/New_York', tide: { kind: 'noaa', station: '8467150' } },
  { name: 'Sámara CR', lat: 9.881, lon: -85.528, tz: 'America/Costa_Rica', tide: { kind: 'marine' } },
]
const WMO = c => c === 0 ? 'clear' : c <= 2 ? 'partly cloudy' : c === 3 ? 'cloudy' : c <= 48 ? 'fog'
  : c <= 57 ? 'drizzle' : c <= 67 ? 'rain' : c <= 77 ? 'snow' : c <= 82 ? 'showers' : c >= 95 ? 'storms' : 'mixed'
const ampm = hm => { const [h, m] = hm.split(':').map(Number); const h12 = ((h + 11) % 12) + 1; return `${h12}:${String(m).padStart(2, '0')}${h < 12 ? 'a' : 'p'}` }
async function tideLine(loc) {
  try {
    if (loc.tide.kind === 'noaa') {
      const d = ymd(loc.tz, new Date()).replace(/-/g, '')
      const u = `https://api.tidesandcurrents.noaa.gov/api/prod/datagetter?product=predictions&application=nave-luke&begin_date=${d}&end_date=${d}&datum=MLLW&station=${loc.tide.station}&time_zone=lst_ldt&units=english&interval=hilo&format=json`
      const j = await (await fetch(u)).json()
      const p = j.predictions || []
      if (!p.length) return null
      return p.map(t => `${t.type === 'H' ? '▲' : '▼'}${ampm(t.t.slice(11, 16))}`).join(' ')
    }
    // marine: find local extrema in today's hourly sea-level series
    const u = `https://marine-api.open-meteo.com/v1/marine?latitude=${loc.lat}&longitude=${loc.lon}&hourly=sea_level_height_msl&timezone=${encodeURIComponent(loc.tz)}&forecast_days=1`
    const j = await (await fetch(u)).json()
    const hs = j.hourly?.sea_level_height_msl || [], ts = j.hourly?.time || []
    const ext = []
    for (let i = 1; i < hs.length - 1; i++) {
      if (hs[i] >= hs[i - 1] && hs[i] > hs[i + 1]) ext.push(`▲≈${ampm(ts[i].slice(11, 16))}`)
      else if (hs[i] <= hs[i - 1] && hs[i] < hs[i + 1]) ext.push(`▼≈${ampm(ts[i].slice(11, 16))}`)
    }
    return ext.length ? ext.join(' ') : null
  } catch { return null }
}
async function weatherSection() {
  const lines = []
  for (const loc of SHORES) {
    try {
      const u = `https://api.open-meteo.com/v1/forecast?latitude=${loc.lat}&longitude=${loc.lon}&daily=temperature_2m_max,temperature_2m_min,weather_code,precipitation_probability_max&temperature_unit=fahrenheit&timezone=${encodeURIComponent(loc.tz)}&forecast_days=1`
      const j = await (await fetch(u)).json()
      const d = j.daily
      if (!d) continue
      const rain = d.precipitation_probability_max?.[0]
      let line = `<b>${esc(loc.name)}</b>: ${WMO(d.weather_code?.[0] ?? -1)} · hi ${Math.round(d.temperature_2m_max[0])}° lo ${Math.round(d.temperature_2m_min[0])}°${rain != null ? ` · rain ${rain}%` : ''}`
      const tides = await tideLine(loc)
      if (tides) line += `\n   tides ${tides}`
      lines.push(line)
    } catch { /* skip a shore that errors */ }
  }
  return lines.length ? { title: '☀️ Weather + tides', lines } : null
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
// Speak AS Luke or not at all: the assistant bot's token lives in Nactor as
// 'telegram-luke'. There is deliberately NO fallback to the approvals bot —
// wrong voice is worse than no message (2026-07-17). If the credential isn't
// loaded yet, log and exit non-zero so the cron log shows it.
const msg = { chat_id: APPROVER, text, parse_mode: 'HTML', disable_web_page_preview: true }
const r = await broker({ provider: 'telegram-luke', tgMethod: 'sendMessage', method: 'POST', body: msg })
log(r.ok ? '  → sent.\n' : `  ✗ send failed ${r.status}: ${r.text.slice(0, 120)}\n`)
process.exit(r.ok ? 0 : 1)
