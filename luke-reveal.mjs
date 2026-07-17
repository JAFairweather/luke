// Luke Reveal — a one-time, nostr-gated secret handoff.
//
// Sometimes the owner must take custody of a box-side secret (the SOPS master
// age key, a recovery phrase) WITHOUT it ever touching a public CI log, git, or
// chat. This serves such a secret exactly once, behind the SAME nostr gate as
// the cockpit and console, then burns it.
//
// Flow:
//   1. ARM  (ops, box-side): reveal-arm.sh reads the secret and drops
//      /state/reveals/<id>.json = {id,label,value,expiresAt}. The value never
//      leaves the box and is never logged.
//   2. REVEAL (browser): the owner opens https://console.nave.pub/reveal/<id>,
//      Alby-signs the gate, clicks "Reveal", and the value renders once.
//   3. BURN: the claim deletes the record. A reload shows "used". A TTL sweep
//      removes anything left unclaimed.
//
// The <id> is an unguessable token, but the nostr gate is the real lock — only
// the master npub can claim. The value lives only in the box-local file (0600)
// until claimed, and only in memory for the length of one request. It is never
// written to a log line.

import { readFileSync, existsSync, unlinkSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

const REVEAL_DIR = process.env.REVEAL_DIR || '/state/reveals'

// The gate check, reusing luke-service's cookie machinery (passed via ctx) —
// identical to the Console's, so the reveal is never reachable unauthenticated
// even from inside the network.
function gated(req, ctx) {
  const raw = ctx.parseCookies(req.headers.cookie).luke_gate
  const tok = ctx.verifyToken(raw)
  return !!(tok && ctx.MASTER_PK && tok.pk === ctx.MASTER_PK)
}

const j = (res, code, obj) => res.writeHead(code, { 'content-type': 'application/json' }).end(JSON.stringify(obj))
const htmlRes = (res, code, s) => res.writeHead(code, { 'content-type': 'text/html; charset=utf-8' }).end(s)
const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))

// id is a bare hex token; never allow path traversal into the reveal dir.
const safeId = s => (typeof s === 'string' && /^[a-f0-9]{8,64}$/.test(s)) ? s : null

function loadReveal(id) {
  const p = join(REVEAL_DIR, id + '.json')
  if (!existsSync(p)) return null
  let rec
  try { rec = JSON.parse(readFileSync(p, 'utf8')) } catch { return null }
  if (!rec || typeof rec.value !== 'string') return null
  if (rec.expiresAt && rec.expiresAt * 1000 < Date.now()) { try { unlinkSync(p) } catch {} return null }
  return { rec, path: p }
}

// Best-effort housekeeping: delete expired reveal files on each hit.
function sweep() {
  try {
    if (!existsSync(REVEAL_DIR)) return
    for (const f of readdirSync(REVEAL_DIR)) {
      if (!f.endsWith('.json')) continue
      const p = join(REVEAL_DIR, f)
      try {
        const rec = JSON.parse(readFileSync(p, 'utf8'))
        if (rec.expiresAt && rec.expiresAt * 1000 < Date.now()) unlinkSync(p)
      } catch { /* leave malformed files for a human to notice */ }
    }
  } catch { /* ignore */ }
}

const SHELL = (title, body) => `<!doctype html><html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title}</title>
<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Crect x='1' y='1' width='30' height='30' rx='7' fill='%230b0906' stroke='%23c39a56' stroke-opacity='.5' stroke-width='1.2'/%3E%3C/svg%3E">
<style>
:root{--ink:#0b0906;--panel:#12100a;--line:#2a2317;--gold:#c39a56;--bright:#e2c079;--cream:#f4efe4;--dim:#9c927f;--danger:#c0705a;--ok:#8fae6a;--mono:"Courier New",monospace;--serif:Georgia,serif}
*{box-sizing:border-box}body{margin:0;min-height:100vh;background:var(--ink);color:var(--cream);font-family:var(--serif);display:grid;place-items:center;padding:32px}
.card{width:min(600px,94vw);border:1px solid var(--line);border-radius:12px;background:var(--panel);padding:32px 32px 28px;box-shadow:0 30px 80px -40px #000}
.kick{font-family:var(--mono);font-size:11px;letter-spacing:.28em;text-transform:uppercase;color:var(--dim)}
h1{font-family:var(--mono);letter-spacing:.1em;font-size:26px;margin:8px 0 4px;color:var(--cream)}
.label{font-style:italic;color:var(--bright);margin:10px 0 20px}
button.btn{font-family:var(--mono);font-size:13px;letter-spacing:.08em;padding:12px 22px;border-radius:4px;border:1px solid var(--gold);background:var(--gold);color:var(--ink);cursor:pointer}
button.btn:hover{background:var(--bright)}button.btn:disabled{opacity:.4;cursor:default}
.note{color:var(--dim);font-size:13px;margin-top:18px;line-height:1.6}
.warn{color:var(--danger);font-family:var(--mono);font-size:12px;letter-spacing:.04em;margin-top:14px}
.ttl{font-family:var(--mono);font-size:12px;color:var(--dim);margin-top:6px}
.secret{margin-top:18px;display:none}
textarea{width:100%;min-height:76px;background:var(--ink);color:var(--gold);border:1px solid var(--line);border-radius:6px;font-family:var(--mono);font-size:13px;padding:12px;resize:vertical}
.copy{margin-top:10px}
.err{color:var(--danger);font-family:var(--mono);font-size:13px;margin-top:12px;min-height:18px}
</style></head><body><div class="card">${body}</div></body></html>`

const usedBody = () => `
  <div class="kick">One-time reveal</div>
  <h1>Already used or expired</h1>
  <div class="note">This reveal has been claimed or its time window lapsed — nothing is stored.
  If you still need the secret, re-arm a fresh reveal from the box (ops → <span style="font-family:var(--mono)">reveal-arm.sh</span>).</div>`

const page = (id, label, secsLeft) => SHELL('Reveal a secret — one time', `
  <div class="kick">One-time reveal · nostr-gated</div>
  <h1>Reveal a secret</h1>
  <div class="label">${esc(label)}</div>
  <div class="note">This value is shown <strong>exactly once</strong>. The moment you reveal it, it's
    deleted from the box. Have your password manager open, then click below.</div>
  ${secsLeft != null ? `<div class="ttl">Expires in ~${Math.ceil(secsLeft / 60)} min if unclaimed.</div>` : ''}
  <p><button class="btn" id="go">Reveal &amp; copy →</button></p>
  <div class="warn" id="warn"></div>
  <div class="secret" id="secret">
    <textarea id="val" readonly spellcheck="false"></textarea>
    <button class="btn copy" id="copy">Copy to clipboard</button>
    <div class="note">Paste this into your password manager now (e.g. "Nave — SOPS master recovery key").
      It will not be shown again.</div>
  </div>
  <div class="err" id="err"></div>
  <script>
  const $ = id => document.getElementById(id);
  $('go').onclick = async () => {
    $('err').textContent = '';
    $('go').disabled = true;
    try {
      const r = await fetch(location.pathname.replace(/\\/$/, '') + '/claim', { method: 'POST' });
      if (r.status === 410) { $('err').textContent = 'This reveal was already used or has expired.'; return; }
      if (!r.ok) { $('err').textContent = 'Refused (' + r.status + ').'; $('go').disabled = false; return; }
      const jd = await r.json();
      $('val').value = jd.value;
      $('secret').style.display = 'block';
      $('warn').textContent = 'Revealed — this is the only time. Copy it now.';
      $('go').textContent = 'Revealed';
    } catch (e) { $('err').textContent = 'Network error — nothing revealed. Try again.'; $('go').disabled = false; }
  };
  $('copy').onclick = async () => { try { await navigator.clipboard.writeText($('val').value); $('copy').textContent = 'Copied ✓'; } catch { $('val').select(); } };
  </script>`)

// Handles console.nave.pub/reveal* — the one-time secret handoff. Returns true
// if handled. Everything else (the Console, the gate) falls through.
export async function handleReveal(req, res, url, ctx) {
  if (!url.startsWith('/reveal')) return false
  sweep()

  const m = url.match(/^\/reveal\/([^/]+?)(\/claim)?\/?$/)

  // Re-check the gate in-process (Caddy already forward_auth'd, but defense in
  // depth — the reveal must never be reachable unauthenticated).
  if (!gated(req, ctx)) {
    if (req.method === 'GET' && !(m && m[2])) { res.writeHead(302, { location: '/gate/login' }).end(); return true }
    return (j(res, 401, { why: 'gate' }), true)
  }

  if (!m) { htmlRes(res, 404, SHELL('Not found', '<div class="kick">Reveal</div><h1>No such reveal</h1>')); return true }
  const id = safeId(m[1])
  if (!id) { htmlRes(res, 404, SHELL('Not found', '<div class="kick">Reveal</div><h1>No such reveal</h1>')); return true }

  // POST /reveal/<id>/claim → burn + return the value once.
  if (req.method === 'POST' && m[2] === '/claim') {
    const hit = loadReveal(id)
    if (!hit) return (j(res, 410, { why: 'used-or-expired' }), true)
    // Burn FIRST: delete before returning, so a crash mid-response can't leave
    // it claimable twice. The value goes out in this one response and nowhere
    // else — never a log line.
    try { unlinkSync(hit.path) } catch {}
    console.log(`  ✓ reveal claimed — id=${id} label=${JSON.stringify(hit.rec.label || 'secret')} @ ${new Date().toISOString()}`)
    return (j(res, 200, { label: hit.rec.label || 'secret', value: hit.rec.value }), true)
  }

  // GET /reveal/<id> → the reveal page (or "used" if already gone).
  if (req.method === 'GET' && !m[2]) {
    const hit = loadReveal(id)
    if (!hit) { htmlRes(res, 200, SHELL('Reveal used', usedBody())); return true }
    const secsLeft = hit.rec.expiresAt ? Math.max(0, hit.rec.expiresAt - Math.floor(Date.now() / 1000)) : null
    htmlRes(res, 200, page(id, hit.rec.label || 'secret', secsLeft))
    return true
  }

  return (j(res, 404, { why: 'not found' }), true)
}
