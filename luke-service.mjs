// Luke — a delegated agent, and the nostr-signed gate to his cockpit.
//
// Two planes on one port (see docs/LUKE.md):
//   • PUBLIC   GET /            Luke's card (identity, mandate, delegation)
//              GET /health      the same, as JSON
//   • CONTROL  GET /gate/login  prove you're Luke's master (NIP-07 sign)
//              POST /gate/auth  verify NIP-98, set a session cookie
//              GET /gate/verify forward_auth endpoint for Caddy
//              GET /gate/logout drop the session
//
// The cockpit itself (the OpenClaw Control UI) is proxied by Caddy to
// host:57419 ONLY after /gate/verify returns 200 — this service never
// touches OpenClaw; it only decides who Caddy lets through.

import { createServer } from 'node:http'
import { createHmac, timingSafeEqual, randomBytes } from 'node:crypto'
import { generateSecretKey, getPublicKey, nip19, verifyEvent } from 'nostr-tools'
import { handlePropose, handleTelegramWebhook, posterStatus } from './luke-poster.mjs'

const PORT = Number(process.env.LUKE_PORT ?? 8790)
const NAME = process.env.LUKE_NAME ?? 'Luke'
const MANDATE = process.env.LUKE_MANDATE ?? 'To keep the master’s work moving between visits.'
const TTL = Number(process.env.GATE_SESSION_TTL ?? 43200) // 12h
const SESSION_SKEW = 60 // seconds of NIP-98 clock tolerance

// --- Luke's own identity ------------------------------------------------
function loadSecret(env) {
  const raw = process.env[env]?.trim()
  if (!raw) return null
  if (raw.startsWith('nsec1')) return nip19.decode(raw).data
  return Uint8Array.from(raw.match(/.{1,2}/g).map(b => parseInt(b, 16)))
}
let LUKE_SK = loadSecret('LUKE_NSEC')
if (!LUKE_SK) {
  LUKE_SK = generateSecretKey()
  console.warn('  ⚠ LUKE_NSEC unset — generated an EPHEMERAL identity. Set LUKE_NSEC to keep Luke stable.')
}
const LUKE_PK = getPublicKey(LUKE_SK)
const LUKE_NPUB = nip19.npubEncode(LUKE_PK)

// --- The master: the ONE key the gate lets in ---------------------------
function decodeNpub(v) {
  if (!v) return null
  const s = v.trim()
  try { return s.startsWith('npub1') ? nip19.decode(s).data : (/^[0-9a-f]{64}$/i.test(s) ? s.toLowerCase() : null) }
  catch { return null }
}
const MASTER_PK = decodeNpub(process.env.LUKE_MASTER_NPUB)
const MASTER_NPUB = MASTER_PK ? nip19.npubEncode(MASTER_PK) : null
if (!MASTER_PK) console.warn('  ⚠ LUKE_MASTER_NPUB unset — the cockpit gate will refuse EVERYONE until you set it.')

// --- Cookie signing (stable across restarts if derived from the key) ----
const GATE_SECRET = process.env.GATE_SECRET
  ? Buffer.from(process.env.GATE_SECRET)
  : createHmac('sha256', Buffer.from(LUKE_SK)).update('luke-gate-v1').digest()

const b64u = b => Buffer.from(b).toString('base64url')
const sign = payload => {
  const body = b64u(JSON.stringify(payload))
  const mac = createHmac('sha256', GATE_SECRET).update(body).digest('base64url')
  return `${body}.${mac}`
}
const verifyToken = token => {
  if (!token || !token.includes('.')) return null
  const [body, mac] = token.split('.')
  const expect = createHmac('sha256', GATE_SECRET).update(body).digest('base64url')
  const a = Buffer.from(mac), b = Buffer.from(expect)
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null
  try {
    const p = JSON.parse(Buffer.from(body, 'base64url').toString())
    if (!p.exp || p.exp < Math.floor(Date.now() / 1000)) return null
    return p
  } catch { return null }
}
const parseCookies = h => Object.fromEntries((h ?? '').split(';').map(c => c.trim().split('=').map(decodeURIComponent)).filter(p => p[0]))

// --- NIP-98 replay guard (dedupe recently-seen event ids) ---------------
const seen = new Map()
function freshId(id) {
  const now = Date.now()
  for (const [k, t] of seen) if (now - t > SESSION_SKEW * 1000 * 2) seen.delete(k)
  if (seen.has(id)) return false
  seen.set(id, now); return true
}

// Verify a NIP-98 (kind 27235) auth event for this request.
function verifyNip98(evt, expectUrl) {
  try {
    if (!evt || evt.kind !== 27235) return { ok: false, why: 'not a NIP-98 auth event' }
    if (!verifyEvent(evt)) return { ok: false, why: 'bad signature' }
    if (Math.abs(evt.created_at - Math.floor(Date.now() / 1000)) > SESSION_SKEW) return { ok: false, why: 'stale timestamp' }
    const tag = k => evt.tags.find(t => t[0] === k)?.[1]
    const method = (tag('method') || '').toUpperCase()
    if (method !== 'POST') return { ok: false, why: 'method mismatch' }
    const u = tag('u')
    if (!u || u.replace(/\/$/, '') !== expectUrl.replace(/\/$/, '')) return { ok: false, why: 'url mismatch' }
    if (!freshId(evt.id)) return { ok: false, why: 'replay' }
    if (!MASTER_PK) return { ok: false, why: 'no master configured' }
    if (evt.pubkey !== MASTER_PK) return { ok: false, why: 'not the master key' }
    return { ok: true }
  } catch (e) { return { ok: false, why: 'malformed' } }
}

// ------------------------------------------------------------------- HTML
const shell = (title, body) => `<!doctype html><html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title}</title>
<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Crect x='1' y='1' width='30' height='30' rx='7' fill='%230b0906' stroke='%23c39a56' stroke-opacity='.5' stroke-width='1.2'/%3E%3Cg transform='translate(4 4)' fill='none' stroke='%23c39a56' stroke-width='1.6' stroke-linecap='round' stroke-linejoin='round'%3E%3Ccircle cx='12' cy='9' r='4'/%3E%3Cpath d='M5 20 Q12 14 19 20'/%3E%3C/g%3E%3C/svg%3E">
<style>
:root{--ink:#0b0906;--panel:#12100a;--line:#2a2317;--gold:#c39a56;--bright:#e2c079;--cream:#f4efe4;--dim:#9c927f;--mono:"Courier New",monospace;--serif:Georgia,serif}
*{box-sizing:border-box}body{margin:0;min-height:100vh;background:var(--ink);color:var(--cream);font-family:var(--serif);display:grid;place-items:center;padding:32px}
.card{width:min(560px,94vw);border:1px solid var(--line);border-radius:12px;background:var(--panel);padding:34px 34px 30px;box-shadow:0 30px 80px -40px #000}
.kick{font-family:var(--mono);font-size:11px;letter-spacing:.28em;text-transform:uppercase;color:var(--dim)}
h1{font-family:var(--mono);letter-spacing:.14em;font-size:34px;margin:8px 0 2px;color:var(--cream)}
.mandate{font-style:italic;color:var(--bright);margin:14px 0 22px}
.row{display:flex;justify-content:space-between;gap:16px;padding:11px 0;border-top:1px solid var(--line);font-size:14px}
.row .k{color:var(--dim);font-family:var(--mono);font-size:12px;letter-spacing:.06em;text-transform:uppercase}
.row .v{text-align:right;word-break:break-all}
.mono{font-family:var(--mono);font-size:12.5px;color:var(--gold)}
.badge{display:inline-block;font-family:var(--mono);font-size:11px;letter-spacing:.1em;color:var(--gold);border:1px solid color-mix(in srgb,var(--gold) 40%,var(--line));border-radius:999px;padding:4px 11px}
a.btn,button.btn{display:inline-block;margin-top:24px;font-family:var(--mono);font-size:13px;letter-spacing:.1em;padding:12px 22px;border-radius:4px;border:1px solid var(--gold);background:var(--gold);color:var(--ink);cursor:pointer;text-decoration:none}
a.btn:hover,button.btn:hover{background:var(--bright)}
.note{color:var(--dim);font-size:13px;margin-top:18px;line-height:1.6}
.err{color:#d98a6a;font-family:var(--mono);font-size:13px;margin-top:14px;min-height:18px}
</style></head><body><div class="card">${body}</div></body></html>`

const CARD = shell(`${NAME} — a delegated agent`, `
  <div class="kick">A delegated agent on the Nave</div>
  <h1>${NAME}</h1>
  <div class="mandate">${MANDATE}</div>
  <div class="row"><span class="k">Identity</span><span class="v mono">${LUKE_NPUB.slice(0, 20)}…</span></div>
  <div class="row"><span class="k">Answers to</span><span class="v mono">${MASTER_NPUB ? MASTER_NPUB.slice(0, 20) + '…' : '— (unset)'}</span></div>
  <div class="row"><span class="k">Delegation</span><span class="v"><span class="badge">revocable · key rotation</span></span></div>
  <div class="row"><span class="k">Cockpit</span><span class="v"><span class="badge">nostr-gated</span></span></div>
  <a class="btn" href="/cockpit">Enter the cockpit →</a>
  <div class="note">Luke's authority is a grant from his master, not a role on a server.
    The public face is read-only; the cockpit that can act opens only for the master's signed key.</div>`)

const LOGIN = shell(`${NAME} — prove your key`, `
  <div class="kick">The cockpit gate</div>
  <h1>Master?</h1>
  <div class="mandate">Sign with ${NAME}'s master key to enter.</div>
  <div class="note">This uses your NIP-07 browser extension (Alby, nos2x). Nothing is sent
    anywhere but a one-time signature proving you hold the master key.</div>
  <button class="btn" id="go">Sign &amp; enter →</button>
  <div class="err" id="err"></div>
  <script>
  const err = document.getElementById('err');
  document.getElementById('go').onclick = async () => {
    err.textContent = '';
    if (!window.nostr) { err.textContent = 'No NIP-07 extension found (install Alby or nos2x).'; return; }
    try {
      const u = location.origin + '/gate/auth';
      const evt = await window.nostr.signEvent({
        kind: 27235, created_at: Math.floor(Date.now()/1000),
        tags: [['u', u], ['method', 'POST']], content: ''
      });
      const r = await fetch('/gate/auth', { method: 'POST', headers: {'content-type':'application/json'}, body: JSON.stringify(evt) });
      if (r.ok) { location.href = '/'; }   // cockpit UI is at root on cockpit.nave.pub
      else { const j = await r.json().catch(()=>({})); err.textContent = 'Refused: ' + (j.why || r.status); }
    } catch (e) { err.textContent = 'Signing cancelled or failed.'; }
  };
  </script>`)

// ---------------------------------------------------------------- server
const json = (res, code, obj) => res.writeHead(code, { 'content-type': 'application/json' }).end(JSON.stringify(obj))
const html = (res, code, s) => res.writeHead(code, { 'content-type': 'text/html; charset=utf-8' }).end(s)
const cookieAttrs = `Path=/; HttpOnly; Secure; SameSite=Lax`
async function readBody(req, res, cap = 16384) {
  let raw = ''
  for await (const chunk of req) {
    raw += chunk
    if (raw.length > cap) { res.writeHead(413).end(); req.destroy(); return null }
  }
  return raw
}

const server = createServer(async (req, res) => {
  const url = (req.url || '/').split('?')[0]

  if (req.method === 'GET' && url === '/health') {
    return json(res, 200, {
      ok: true, luke: true, name: NAME, agent: LUKE_NPUB,
      master: MASTER_NPUB, mandate: MANDATE,
      delegation: { source: 'master grant', revocable: true },
      cockpit: 'nostr-gated',
      poster: posterStatus(),
    })
  }

  // --- The posting loop (see luke-poster.mjs) ---------------------------
  // The brain proposes; you approve on Telegram; we sign + broadcast.
  if (req.method === 'POST' && url === '/propose') {
    const raw = await readBody(req, res, 16384); if (raw === null) return
    return handlePropose(req, res, raw)
  }
  if (req.method === 'POST' && url === '/telegram/webhook') {
    const raw = await readBody(req, res, 65536); if (raw === null) return
    return handleTelegramWebhook(req, res, raw)
  }
  if (req.method === 'GET' && (url === '/' || url === '/card')) return html(res, 200, CARD)
  if (req.method === 'GET' && url === '/gate/login') return html(res, 200, LOGIN)

  if (req.method === 'GET' && url === '/gate/logout') {
    res.writeHead(302, { 'set-cookie': `luke_gate=; Max-Age=0; ${cookieAttrs}`, location: '/' }).end()
    return
  }

  // forward_auth target: 200 → Caddy proxies the cockpit; else redirect to login.
  if (req.method === 'GET' && url === '/gate/verify') {
    const rawCookie = parseCookies(req.headers.cookie).luke_gate
    const tok = verifyToken(rawCookie)
    if (tok && MASTER_PK && tok.pk === MASTER_PK) return res.writeHead(200).end('ok')
    // A present-but-invalid cookie (expired / tampered / wrong key) is worth an
    // audit line; a plain no-cookie request (logged out, or an asset fetch) is
    // the normal path to the login and stays quiet to avoid flooding.
    if (rawCookie) console.warn(`  ✗ gate/verify denied — cookie present but ${tok ? 'wrong key' : 'invalid/expired'} @ ${new Date().toISOString()}`)
    return res.writeHead(302, { location: '/gate/login' }).end()
  }

  // verify the signed challenge, mint the session cookie.
  if (req.method === 'POST' && url === '/gate/auth') {
    let raw = ''
    for await (const chunk of req) { raw += chunk; if (raw.length > 8192) { req.destroy(); return } }
    let evt
    try { evt = JSON.parse(raw) } catch { return json(res, 400, { why: 'bad json' }) }
    const proto = (req.headers['x-forwarded-proto'] || 'https')
    const host = req.headers['x-forwarded-host'] || req.headers.host
    const expectUrl = `${proto}://${host}/gate/auth`
    const v = verifyNip98(evt, expectUrl)
    if (!v.ok) {
      const who = evt?.pubkey ? ` (pubkey ${nip19.npubEncode(evt.pubkey).slice(0, 14)}…)` : ''
      console.warn(`  ✗ cockpit login DENIED — ${v.why}${who} @ ${new Date().toISOString()}`)
      return json(res, 403, { why: v.why })
    }
    const token = sign({ pk: evt.pubkey, exp: Math.floor(Date.now() / 1000) + TTL })
    console.log(`  ✓ cockpit login — ${nip19.npubEncode(evt.pubkey)} @ ${new Date().toISOString()}`)
    res.writeHead(204, { 'set-cookie': `luke_gate=${token}; Max-Age=${TTL}; ${cookieAttrs}` }).end()
    return
  }

  return json(res, 404, { error: 'not found' })
})

server.listen(PORT, () => {
  console.log(`\n  ${NAME} — delegated agent + cockpit gate`)
  console.log(`  agent : ${LUKE_NPUB}`)
  console.log(`  master: ${MASTER_NPUB ?? '(unset — gate refuses all)'}`)
  const ps = posterStatus()
  console.log(`  poster: ${ps.ready ? `ready — [${ps.identities.join(', ')}], ${ps.relays} relays` : 'idle (set TELEGRAM_BOT_TOKEN, TELEGRAM_APPROVER_ID, PROPOSE_TOKEN, role nsecs)'}`)
  console.log(`  listening on :${PORT}  (card /, health /health, gate /gate/*, propose /propose)\n`)
})
