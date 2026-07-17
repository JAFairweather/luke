// Luke Console — the nostr-gated "total configuration" surface.
//
// One page to see every file that drives Luke, chained so you can read how the
// config becomes behavior, with the parts authored for Luke highlighted apart
// from the stock OpenClaw template. The instruction files (.md) are editable and
// each save commits to Luke's workspace git; the engine config (openclaw.json)
// is shown sanitized and read-only (a bad comma there would brick the gateway —
// guarded runtime editing is a later step).
//
// Mounted into the luke container (see docker-compose): the workspace at
// BRAIN_DIR (rw) and openclaw.json at OC_JSON (ro). Gated behind the same nostr
// gate as the cockpit — every /console* request also re-checks the luke_gate
// cookie here, so it's never reachable unauthenticated even from inside the net.

import { readFileSync, writeFileSync, existsSync, statSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { join, basename } from 'node:path'

const BRAIN_DIR = process.env.BRAIN_DIR?.trim() || '/brain/workspace'
const OC_JSON = process.env.OC_JSON?.trim() || '/brain/openclaw.json'

// The config registry — every file the Console shows, with how/when it drives Luke.
// group orders the tree; loadWhen is the human answer to "when does this matter?".
const FILES = [
  { name: 'SOUL.md',       group: 'Identity',         editable: true,  origin: 'yours', role: 'Who he is — voice, ethos, the dequalsf stance. Read first.',        loadWhen: 'Every session — read first ("who you are")' },
  { name: 'IDENTITY.md',   group: 'Identity',         editable: true,  origin: 'stock', role: 'The bootstrap identity record OpenClaw expects.',                    loadWhen: 'Every session (bootstrap identity record)' },
  { name: 'USER.md',       group: 'Identity',         editable: true,  origin: 'yours', role: 'Who he’s helping — you. The context he leads with.',                 loadWhen: 'Every session ("who you’re helping")' },
  { name: 'AGENTS.md',     group: 'Operating manual', editable: true,  origin: 'yours', role: 'The standing operating manual — how he acts, closes the loop.',       loadWhen: 'Every session — always injected (the SOP)' },
  { name: 'HEARTBEAT.md',  group: 'Rhythm',           editable: true,  origin: 'yours', role: 'The content of the two daily beats.',                                loadWhen: 'Loaded every session; drives the two daily beats' },
  { name: 'TOOLS.md',      group: 'Capabilities',     editable: true,  origin: 'stock', role: 'Capabilities available locally, and what is NOT wired.',             loadWhen: 'Every session (local setup + what is NOT wired)' },
  { name: 'MEMORY.md',     group: 'Memory',           editable: true,  origin: 'yours', role: 'Curated long-term memory. Main session only.',                       loadWhen: 'MAIN session only — curated long-term memory' },
  { name: 'punchlist.md',  group: 'Ledger',           editable: true,  origin: 'yours', role: 'The live ledger — 🔨 Renovation and 📋 Commitments.',                loadWhen: 'Read by the morning beat; kept honest live' },
]

// The sessions Luke runs. Each inherits a shared BASE (loaded every session) and
// adds its own — so a beat loads MORE than a chat, never less. This is the
// Console's primary axis: pick a session, see exactly what it loads.
const SESSIONS = [
  { id: 'main', name: 'Main session', when: 'on demand · direct chat with you',
    base: ['SOUL.md', 'IDENTITY.md', 'USER.md', 'AGENTS.md', 'TOOLS.md', 'HEARTBEAT.md', 'MEMORY.md'], adds: [],
    note: 'MEMORY.md loads here because this is a main/direct session — the one place his long-term memory comes in.',
    effect: 'Interactive. He reads the base, leads with your context, and works the conversation with you.' },
  { id: 'am', name: 'Morning beat', when: '07:00 America/New_York · isolated cron', active: 'HEARTBEAT.md → Morning beat',
    base: ['SOUL.md', 'IDENTITY.md', 'USER.md', 'AGENTS.md', 'TOOLS.md', 'HEARTBEAT.md'], adds: ['punchlist.md'], reads: ['nostr-check.js (read-only script)'],
    note: 'Same base as every session — MEMORY.md is absent because a cron beat isn’t a main session.',
    effect: 'Runs the discipline check, flags the single most important stale commitment, scans nostr, offers at most one post — to Telegram.' },
  { id: 'pm', name: 'Evening beat', when: '22:00 America/New_York · isolated cron', active: 'HEARTBEAT.md → Evening beat',
    base: ['SOUL.md', 'IDENTITY.md', 'USER.md', 'AGENTS.md', 'TOOLS.md', 'HEARTBEAT.md'], adds: ['MEMORY.md'], reads: ['memory/YYYY-MM-DD.md (daily log)'],
    note: 'Same base — plus it opens MEMORY.md and the daily log to WRITE the day’s signal, not just read.',
    effect: 'One close-the-loop prompt, then writes the day’s signal to the daily log and promotes durable facts into long-term memory.' },
]

// The behavior chain — how the files become behavior, as triggers → what loads → effect.
const CHAIN = [
  {
    trigger: 'Session start', when: 'every session',
    loads: ['SOUL.md', 'USER.md', 'AGENTS.md', 'TOOLS.md', 'IDENTITY.md', 'HEARTBEAT.md', 'MEMORY.md*'],
    effect: 'OpenClaw injects these into the system prompt. They ARE Luke’s standing knowledge and rules for the turn. (*MEMORY.md only in a main/direct session.)',
  },
  {
    trigger: 'Morning beat', when: '07:00 America/New_York · isolated cron session',
    loads: ['AGENTS.md → Timers, Closing the loop', 'HEARTBEAT.md → Morning beat', 'punchlist.md', 'nostr-check.js'],
    effect: 'Luke runs the discipline check, flags the single most important stale punchlist item, scans nostr, and offers at most one post — delivered to Telegram.',
  },
  {
    trigger: 'Evening beat', when: '22:00 America/New_York · isolated cron session',
    loads: ['HEARTBEAT.md → Evening beat', 'memory/YYYY-MM-DD.md', 'MEMORY.md'],
    effect: 'One close-the-loop prompt, then Luke writes the day’s signal to the daily log and promotes durable facts into MEMORY.md.',
  },
  {
    trigger: 'Engine', when: 'openclaw.json · the gateway runtime',
    loads: ['model + fallbacks', 'plugins', 'the two cron beats', 'memory search'],
    effect: 'Chooses the model that reads all of the above, which channels are live, and the schedule the beats fire on. Config, not prompt.',
  },
]

const ALLOWED = new Set(FILES.map(f => f.name))
const safeName = n => (typeof n === 'string' && ALLOWED.has(n)) ? n : null
const readIf = p => { try { return existsSync(p) ? readFileSync(p, 'utf8') : null } catch { return null } }

// A sanitized, display-only view of the engine config: the shape that matters
// (model, plugins, cron, memory, gateway posture) with any secret-ish value
// masked. Never returns raw tokens/keys.
function runtimeView() {
  const raw = readIf(OC_JSON)
  if (!raw) return { available: false }
  let c; try { c = JSON.parse(raw) } catch { return { available: false, error: 'openclaw.json unparseable' } }
  const a = c.agents?.defaults || {}
  const pluginsOn = Object.entries(c.plugins?.entries || {})
    .filter(([, v]) => v && v.enabled).map(([k]) => k)
  return {
    available: true,
    version: c.meta?.lastTouchedVersion || null,
    model: { primary: a.model?.primary || null, fallbacks: a.model?.fallbacks || [] },
    thinkingDefault: a.thinkingDefault || null,
    memorySearch: a.memorySearch ? `${a.memorySearch.provider}/${a.memorySearch.model}` : null,
    heartbeat: a.heartbeat ? { every: a.heartbeat.every, isolated: !!a.heartbeat.isolatedSession } : null,
    plugins: pluginsOn,
    gateway: {
      bind: c.gateway?.bind || null,
      deviceAuth: c.gateway?.controlUi?.dangerouslyDisableDeviceAuth ? 'off' : 'on',
      allowedOrigins: c.gateway?.controlUi?.allowedOrigins || [],
    },
    channels: Object.entries(c.channels || {}).filter(([, v]) => v && v.enabled).map(([k]) => k),
  }
}

function commitFile(name) {
  // Commit as Luke, tolerating the container-vs-mount ownership split.
  try {
    execFileSync('git', ['-C', BRAIN_DIR, 'config', '--global', '--add', 'safe.directory', BRAIN_DIR], { stdio: 'ignore' })
  } catch {}
  try {
    execFileSync('git', ['-C', BRAIN_DIR, 'add', name], { stdio: 'ignore' })
    execFileSync('git', ['-C', BRAIN_DIR,
      '-c', 'user.email=luke@nave.pub', '-c', 'user.name=Luke',
      'commit', '-q', '-m', `console: edit ${name}`], { stdio: 'ignore' })
    return true
  } catch { return false }
}

// The gate check, reusing luke-service's cookie machinery (passed via ctx).
function gated(req, ctx) {
  const raw = ctx.parseCookies(req.headers.cookie).luke_gate
  const tok = ctx.verifyToken(raw)
  return !!(tok && ctx.MASTER_PK && tok.pk === ctx.MASTER_PK)
}

const j = (res, code, obj) => res.writeHead(code, { 'content-type': 'application/json' }).end(JSON.stringify(obj))

export async function handleConsole(req, res, url, ctx) {
  // Serve the page (Caddy has already gated console.nave.pub; the page itself is
  // harmless static shell, the API below is what's re-checked).
  if (req.method === 'GET' && (url === '/' || url === '/console' || url === '/console/')) {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(CONSOLE_HTML)
    return true
  }
  if (!url.startsWith('/console/api/')) return false

  if (!gated(req, ctx)) return (j(res, 401, { why: 'gate' }), true)

  if (req.method === 'GET' && url.startsWith('/console/api/manifest')) {
    const files = FILES.map(f => {
      const p = join(BRAIN_DIR, f.name)
      const st = existsSync(p) ? statSync(p) : null
      return { ...f, exists: !!st, bytes: st ? st.size : 0,
               hasBaseline: existsSync(join(BRAIN_DIR, f.name + '.pre-review')) }
    })
    return (j(res, 200, { files, sessions: SESSIONS, chain: CHAIN, runtime: runtimeView() }), true)
  }

  if (req.method === 'GET' && url.startsWith('/console/api/file')) {
    const name = safeName(new URL(req.url, 'http://x').searchParams.get('name'))
    if (!name) return (j(res, 400, { why: 'unknown file' }), true)
    const content = readIf(join(BRAIN_DIR, name))
    const baseline = readIf(join(BRAIN_DIR, name + '.pre-review'))
    const meta = FILES.find(f => f.name === name)
    return (j(res, 200, { name, content: content ?? '', baseline, meta }), true)
  }

  if (req.method === 'POST' && url.startsWith('/console/api/save')) {
    let raw = ''
    for await (const chunk of req) { raw += chunk; if (raw.length > 512 * 1024) { req.destroy(); return true } }
    let body; try { body = JSON.parse(raw) } catch { return (j(res, 400, { why: 'bad json' }), true) }
    const name = safeName(body.name)
    const meta = FILES.find(f => f.name === name)
    if (!name || !meta?.editable) return (j(res, 400, { why: 'not editable' }), true)
    if (typeof body.content !== 'string') return (j(res, 400, { why: 'no content' }), true)
    try {
      // keep a pre-console backup the first time, then write.
      const p = join(BRAIN_DIR, name)
      const bak = p + '.pre-console'
      if (existsSync(p) && !existsSync(bak)) { try { writeFileSync(bak, readFileSync(p)) } catch {} }
      writeFileSync(p, body.content)
    } catch (e) { return (j(res, 500, { why: 'write failed: ' + e.message }), true) }
    const committed = commitFile(name)
    console.log(`  ✎ console edit — ${name} (${body.content.length}b)${committed ? ' + committed' : ''} @ ${new Date().toISOString()}`)
    return (j(res, 200, { ok: true, committed }), true)
  }

  return (j(res, 404, { why: 'not found' }), true)
}

// ------------------------------------------------------------------ the page
const CONSOLE_HTML = /* html */ `<!doctype html><html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Luke Console</title>
<link rel="icon" href="https://nave.pub/assets/avatars/luke.png">
<style>
:root{
  --ground:#0b0906;--panel:#14100a;--panel-2:#1b1409;--line:#2a2317;--line-strong:#3a3020;--field:#0d0a06;
  --text:#f4efe4;--dim:#9c927f;--faint:#6f6555;--accent:#c39a56;--accent-bright:#e2c079;--accent-ink:#0b0906;
  --good:#8fae6a;--warn:#d9a648;--critical:#c0705a;
  --yours:#c39a56;--yours-bg:color-mix(in srgb,#c39a56 14%,transparent);--yours-line:#8a6f3f;
  --stock:#8897a8;--stock-bg:color-mix(in srgb,#8897a8 13%,transparent);--stock-line:#5b6675;
  --diff-user:#8fae6a;--diff-user-bg:color-mix(in srgb,#8fae6a 15%,transparent);
  --diff-template:#7f95ad;--diff-template-bg:color-mix(in srgb,#7f95ad 13%,transparent);
  --sans:-apple-system,BlinkMacSystemFont,"Segoe UI","Inter",Roboto,"Helvetica Neue",Arial,sans-serif;
  --mono:ui-monospace,SFMono-Regular,"SF Mono",Menlo,Consolas,"Roboto Mono",monospace;
  --display:"Iowan Old Style","Palatino Linotype",Palatino,Georgia,serif;
}
:root[data-theme="light"]{
  --ground:#f5f0e4;--panel:#fffdf7;--panel-2:#ece4d2;--line:#ddd2ba;--line-strong:#c8b89a;--field:#fffdf7;
  --text:#241d12;--dim:#6f6553;--faint:#8a7f66;--accent:#8f6a2c;--accent-bright:#b0863c;--accent-ink:#fffdf7;
  --good:#4f7a34;--warn:#9a6a12;--critical:#a2482f;
  --yours:#8f6a2c;--yours-bg:#efe6d2;--yours-line:#b0a17f;--stock:#5a6f86;--stock-bg:#e6ecf2;--stock-line:#93a1b3;
  --diff-user:#4f7a34;--diff-user-bg:#e9f0dd;--diff-template:#48607a;--diff-template-bg:#e6ecf3;
}
*{box-sizing:border-box}
html,body{margin:0;min-height:100%}
body{background:var(--ground);color:var(--text);font-family:var(--sans);font-size:15px;line-height:1.55}
.label{font-family:var(--mono);text-transform:uppercase;letter-spacing:.13em;font-size:10.5px;font-weight:600;color:var(--faint)}
.mono{font-family:var(--mono)}
header{display:flex;align-items:center;gap:14px;padding:14px 24px;border-bottom:1px solid var(--line-strong);background:linear-gradient(180deg,var(--panel),var(--ground));position:sticky;top:0;z-index:10}
.brand{display:flex;align-items:center;gap:12px}
.brand .mk{width:30px;height:30px;border-radius:8px;background:#0b0906 center/cover no-repeat url("https://nave.pub/assets/avatars/luke.png");border:1px solid var(--yours-line)}
.brand h1{font-family:var(--mono);font-size:15px;font-weight:700;letter-spacing:.18em;text-transform:uppercase;margin:0;color:var(--text)}
.brand .sub{font-family:var(--display);font-style:italic;color:var(--dim);font-size:14px}
header .sp{flex:1}
.hbtn{font-family:var(--mono);font-size:11px;letter-spacing:.06em;color:var(--dim);background:transparent;border:1px solid var(--line-strong);border-radius:6px;padding:7px 11px;cursor:pointer;text-decoration:none}
.hbtn:hover{border-color:var(--accent);color:var(--accent-bright)}
/* tabs */
.tabs{display:flex;gap:6px;flex-wrap:wrap;padding:16px 24px 0;border-bottom:1px solid var(--line);position:sticky;top:59px;background:var(--ground);z-index:9}
.tab{position:relative;top:1px;font-family:var(--mono);font-size:12px;letter-spacing:.08em;text-transform:uppercase;color:var(--dim);background:none;border:1px solid transparent;border-bottom:none;border-radius:8px 8px 0 0;padding:11px 16px;cursor:pointer}
.tab:hover{color:var(--text)}
.tab[aria-selected="true"]{color:var(--accent);background:var(--panel);border-color:var(--line);border-bottom:1px solid var(--panel)}
.tab .tw{display:block;font-size:9px;letter-spacing:.05em;color:var(--faint);text-transform:none;margin-top:3px}
.tab.aux{color:var(--faint)}
.tab.new{border:1px dashed var(--line-strong);border-bottom:none;color:var(--accent)}
main{padding:26px 24px 80px;max-width:1080px}
.meta{font-family:var(--mono);font-size:12px;color:var(--dim);margin:0 0 20px}
.meta b{color:var(--accent)}
.sec{margin:0 0 22px}
.sec-h{display:flex;align-items:baseline;gap:12px;margin-bottom:5px}
.sec-h h3{font-family:var(--mono);font-size:11px;letter-spacing:.2em;text-transform:uppercase;color:var(--text);margin:0}
.sec-h .cap{color:var(--dim);font-size:12.5px}
.sec-note{color:var(--dim);font-size:12.5px;margin:0 0 13px;max-width:80ch;font-style:italic;font-family:var(--display)}
.strip{display:flex;flex-wrap:wrap;gap:12px}
.fc{position:relative;text-align:left;background:var(--panel);border:1px solid var(--line);border-radius:11px;padding:12px 14px;cursor:pointer;color:inherit;font:inherit;min-width:180px;flex:1 1 200px;max-width:270px;transition:transform .15s,border-color .15s,box-shadow .15s}
.fc:hover{transform:translateY(-2px);border-color:var(--line-strong);box-shadow:0 12px 26px -20px #000}
.fc:focus-visible{outline:none;border-color:var(--accent)}
.fc .nm{font-family:var(--mono);font-size:13px;color:var(--text);display:flex;align-items:center;gap:8px}
.fc .tg{margin-left:auto;font-size:9px;letter-spacing:.1em;text-transform:uppercase;padding:2px 6px;border-radius:5px}
.fc .rl{color:var(--dim);font-size:12px;margin-top:6px;line-height:1.4}
.fc[data-o="yours"]{border-left:3px solid var(--yours)}
.fc[data-o="yours"] .tg{color:var(--yours);background:var(--yours-bg)}
.fc[data-o="stock"]{border-left:3px solid var(--stock-line)}
.fc[data-o="stock"] .tg{color:var(--stock);background:var(--stock-bg)}
.fc .ord{position:absolute;top:-8px;left:-8px;width:20px;height:20px;border-radius:50%;background:var(--ground);border:1px solid var(--line-strong);color:var(--faint);font-family:var(--mono);font-size:10px;display:grid;place-items:center}
.fc.add{border:1px dashed var(--line-strong);background:transparent;color:var(--dim);display:flex;align-items:center;justify-content:center;min-height:72px;font-family:var(--mono);font-size:12px;letter-spacing:.05em}
.fc.add:hover{border-color:var(--accent);color:var(--accent)}
.eff{background:var(--field);border:1px solid var(--line-strong);border-left:3px solid var(--accent);border-radius:11px;padding:14px 16px;color:var(--dim);font-size:14px;line-height:1.55;max-width:82ch}
.eff .el{font-family:var(--mono);font-size:10px;letter-spacing:.18em;text-transform:uppercase;color:var(--accent);margin-bottom:6px}
.legend{display:flex;gap:16px;align-items:center;margin:0 0 16px;font-size:11.5px;color:var(--dim);font-family:var(--mono)}
.sw{display:inline-block;width:11px;height:11px;border-radius:3px;vertical-align:-1px;margin-right:5px}
.swu{background:var(--yours-bg);border:1px solid var(--yours)}.swt{background:var(--stock-bg);border:1px solid var(--stock-line)}
/* chain + engine */
.chain{display:grid;gap:12px;margin-top:6px;max-width:820px}
.node{border:1px solid var(--line);border-radius:10px;background:linear-gradient(180deg,color-mix(in srgb,var(--panel) 70%,var(--ground)),var(--ground));padding:16px 18px}
.node h4{font-family:var(--mono);font-size:13px;letter-spacing:.05em;text-transform:uppercase;margin:0 0 2px;color:var(--accent-bright)}
.node .nw{color:var(--faint);font-size:11.5px;font-family:var(--mono);margin-bottom:10px}
.chips{display:flex;flex-wrap:wrap;gap:6px;margin-bottom:10px}
.chip{font-family:var(--mono);font-size:11px;color:var(--text);background:color-mix(in srgb,var(--accent) 9%,transparent);border:1px solid color-mix(in srgb,var(--accent) 32%,transparent);border-radius:6px;padding:3px 8px;cursor:pointer}
.chip:hover{border-color:var(--accent)}.node .ef{color:var(--dim);font-size:13.5px}
.arrow{text-align:center;color:var(--faint);font-size:15px}
.rt{display:grid;grid-template-columns:repeat(auto-fill,minmax(200px,1fr));gap:12px;margin-top:6px;max-width:900px}
.kv{border:1px solid var(--line);border-radius:9px;background:var(--panel);padding:13px 15px}
.kv .k{display:block;margin-bottom:6px}.kv .v{font-family:var(--mono);font-size:13px;color:var(--text);word-break:break-word}
.kv .v .pill{display:inline-block;font-size:11px;background:color-mix(in srgb,var(--accent) 10%,transparent);border:1px solid color-mix(in srgb,var(--accent) 30%,transparent);border-radius:5px;padding:1px 7px;margin:2px 3px 0 0}
.ro{display:inline-block;font-family:var(--mono);font-size:10px;letter-spacing:.05em;color:var(--warn);border:1px solid color-mix(in srgb,var(--warn) 45%,transparent);border-radius:999px;padding:2px 8px;margin-left:10px}
.pane-h{display:flex;align-items:center;gap:12px;margin-bottom:4px}
.pane-h h2{font-family:var(--mono);font-size:19px;margin:0}
.when{color:var(--dim);font-size:13.5px;margin:2px 0 16px;max-width:80ch}
.hint{color:var(--faint);font-size:12.5px;margin-top:14px;line-height:1.6;max-width:72ch}
.spinner{color:var(--dim);font-family:var(--mono);font-size:13px;padding:40px 0}
/* editor drawer */
.scrim{position:fixed;inset:0;background:rgba(0,0,0,.5);opacity:0;pointer-events:none;transition:opacity .2s;z-index:40}
.scrim.open{opacity:1;pointer-events:auto}
.drawer{position:fixed;top:0;right:0;height:100%;width:min(760px,96vw);background:var(--ground);border-left:1px solid var(--line-strong);box-shadow:-30px 0 80px -40px #000;transform:translateX(100%);transition:transform .24s cubic-bezier(.4,0,.2,1);z-index:50;display:flex;flex-direction:column}
.drawer.open{transform:none}
.dh{display:flex;align-items:center;gap:12px;padding:16px 20px;border-bottom:1px solid var(--line)}
.dh h2{font-family:var(--mono);font-size:16px;margin:0}
.dh .tg{font-size:9px;letter-spacing:.1em;text-transform:uppercase;padding:2px 7px;border-radius:5px;font-family:var(--mono)}
.dh .sp{flex:1}
.dclose{background:none;border:1px solid var(--line-strong);color:var(--dim);border-radius:7px;width:32px;height:32px;cursor:pointer}
.dclose:hover{color:var(--text);border-color:var(--accent)}
.dbar{display:flex;align-items:center;gap:8px;padding:12px 20px;flex-wrap:wrap}
.seg{display:inline-flex;border:1px solid var(--line-strong);border-radius:7px;overflow:hidden}
.seg button{font-family:var(--mono);font-size:11px;background:transparent;color:var(--dim);border:0;padding:7px 13px;cursor:pointer}
.seg button.on{background:var(--accent);color:var(--accent-ink)}
.btn{font-family:var(--mono);font-size:11.5px;letter-spacing:.05em;background:var(--accent);color:var(--accent-ink);border:0;border-radius:7px;padding:8px 14px;cursor:pointer;font-weight:600}
.btn:hover{background:var(--accent-bright)}.btn:disabled{opacity:.4;cursor:default}
.btn.ghost{background:transparent;border:1px solid var(--line-strong);color:var(--dim)}
.btn.ghost:hover{border-color:var(--accent);color:var(--accent-bright)}
.status{font-family:var(--mono);font-size:11.5px;color:var(--dim);margin-left:6px}
.status.ok{color:var(--good)}.status.err{color:var(--critical)}
.dbody{flex:1;overflow-y:auto;padding:0 20px 26px}
.doc,.edit{border:1px solid var(--line);border-radius:10px;background:var(--field);font-family:var(--mono);font-size:13px;line-height:1.7}
.doc{padding:4px 0;overflow-x:auto}
.doc .ln{display:block;padding:1px 16px;white-space:pre-wrap;word-break:break-word;border-left:2px solid transparent}
.doc .ln.u{background:var(--diff-user-bg);border-left-color:var(--diff-user)}
.doc .ln.t{background:var(--diff-template-bg);border-left-color:var(--diff-template)}
.doc .ln .g{color:var(--faint);user-select:none;display:inline-block;width:2.2em;text-align:right;margin-right:14px}
.edit{width:100%;min-height:60vh;color:var(--text);padding:14px 16px;resize:vertical;border-color:var(--line-strong);outline:none}
.edit:focus{border-color:var(--accent)}
@media(max-width:560px){.strip .fc{max-width:none}}
</style></head><body>
<header>
  <div class="brand"><span class="mk"></span><h1>Luke Console</h1><span class="sub">his total configuration, made legible</span></div>
  <span class="sp"></span>
  <button class="hbtn" id="theme">theme</button>
  <a class="hbtn" href="/gate/logout">sign out</a>
</header>
<div class="tabs" id="tabs"></div>
<main id="main"><div class="spinner">loading Luke’s configuration…</div></main>

<div class="scrim" id="scrim"></div>
<aside class="drawer" id="drawer" aria-hidden="true"></aside>

<script>
const $ = s => document.querySelector(s)
const el = (t,c,h) => { const e=document.createElement(t); if(c)e.className=c; if(h!=null)e.innerHTML=h; return e }
const esc = s => String(s).replace(/[&<>]/g, m => ({'&':'&amp;','<':'&lt;','>':'&gt;'}[m]))
let MANIFEST=null, TAB='main'

const root=document.documentElement
const savedTheme=localStorage.getItem('nave-theme')
if(savedTheme)root.setAttribute('data-theme',savedTheme)
$('#theme').onclick=()=>{ const c=root.getAttribute('data-theme')||(matchMedia('(prefers-color-scheme: light)').matches?'light':'dark'); const n=c==='dark'?'light':'dark'; root.setAttribute('data-theme',n); localStorage.setItem('nave-theme',n) }

function fileByName(n){ return (MANIFEST.files||[]).find(f=>f.name===n) }

async function boot(){
  MANIFEST = await (await fetch('/console/api/manifest')).json()
  renderTabs(); selectTab('main')
}
function renderTabs(){
  const tabs=$('#tabs'); tabs.innerHTML=''
  MANIFEST.sessions.forEach(s=>{
    const t=el('button','tab'); t.dataset.tab=s.id
    t.innerHTML=esc(s.name)+'<span class="tw">'+esc(s.when.split(' · ')[0])+'</span>'
    t.onclick=()=>selectTab(s.id); tabs.append(t)
  })
  const nw=el('button','tab new'); nw.dataset.tab='new'; nw.innerHTML='＋ New session<span class="tw">author a beat</span>'
  nw.onclick=()=>selectTab('new'); tabs.append(nw)
  for(const [id,lbl,sub] of [['chain','Behavior chain','the whole map'],['engine','Engine config','openclaw.json']]){
    const t=el('button','tab aux'); t.dataset.tab=id; t.innerHTML=esc(lbl)+'<span class="tw">'+esc(sub)+'</span>'
    t.onclick=()=>selectTab(id); tabs.append(t)
  }
}
function selectTab(id){
  TAB=id
  document.querySelectorAll('.tab').forEach(t=>t.setAttribute('aria-selected', t.dataset.tab===id))
  if(id==='chain') return renderChain()
  if(id==='engine') return renderEngine()
  if(id==='new') return renderAuthor()
  renderSession(MANIFEST.sessions.find(s=>s.id===id))
}

function fcard(name,ord){
  const f=fileByName(name)
  if(!f){ const b=el('div','fc'); b.dataset.o='stock'; b.innerHTML='<div class="nm">'+esc(name)+'</div><div class="rl">not an editable config file</div>'; return b }
  const b=el('button','fc'); b.dataset.o=f.origin||'yours'
  const ord_h = ord!=null?'<span class="ord">'+(ord+1)+'</span>':''
  b.innerHTML=ord_h+'<div class="nm">'+esc(f.name)+'<span class="tg">'+(f.origin==='stock'?'stock':'yours')+'</span></div><div class="rl">'+esc(f.role||f.loadWhen||'')+'</div>'
  b.onclick=()=>openEditor(f.name)
  return b
}
function renderSession(s){
  const m=$('#main'); m.innerHTML=''
  m.append(el('div','meta','Runs: <b>'+esc(s.when)+'</b>'+(s.active?' · active instruction: <b>'+esc(s.active)+'</b>':'')))
  m.append(el('div','legend','<span><span class="sw swu"></span>authored for Luke</span><span><span class="sw swt"></span>stock template</span><span style="color:var(--faint)">click a file to edit</span>'))
  const base=el('div','sec')
  base.append(el('div','sec-h','<h3>Base context</h3><span class="cap">every session inherits this</span>'))
  base.append(el('div','sec-note',esc(s.note||'')))
  const bs=el('div','strip'); s.base.forEach((n,i)=>bs.append(fcard(n,i))); base.append(bs)
  m.append(base)
  const add=el('div','sec')
  add.append(el('div','sec-h','<h3>This session also loads</h3><span class="cap">on top of the base</span>'))
  const as=el('div','strip')
  ;(s.adds||[]).forEach(n=>as.append(fcard(n,null)))
  ;(s.reads||[]).forEach(r=>{ const c=el('div','fc'); c.dataset.o='stock'; c.style.cursor='default'; c.innerHTML='<div class="nm">'+esc(r)+'</div><div class="rl">read/written by this beat</div>'; as.append(c) })
  const addb=el('button','fc add','＋ add a file'); addb.onclick=addFileFlow; as.append(addb)
  add.append(as); m.append(add)
  m.append(el('div','sec').appendChild(el('div','eff','<div class="el">What happens</div>'+esc(s.effect||''))).parentElement)
}
function addFileFlow(){
  alert('Adding a file to a session\\'s load path — pick an existing file or create a new one — arrives with session authoring (the ＋ New session tab, landing next). For now, edit any file from its card.')
}
function renderAuthor(){
  const m=$('#main'); m.innerHTML=''
  m.append(el('div','pane-h','<h2>New session</h2><span class="ro">authoring — coming next</span>'))
  m.append(el('div','when','Define a new beat Luke runs on your schedule: a name, a trigger (cron), the files it adds on top of the base, an instruction, and where the result goes. It writes a validated, backed-up cron entry that auto-rolls-back if the gateway doesn’t return healthy. Building this is the next pass.'))
  m.append(el('div','hint','Preview of the flow is in the design mockup. This tab goes live with the authoring build.'))
}
function renderChain(){
  const m=$('#main'); m.innerHTML=''
  m.append(el('div','pane-h','<h2>Behavior chain</h2>'))
  m.append(el('div','when','Every trigger, what it loads, and the effect. Click a file chip to edit it.'))
  const wrap=el('div','chain')
  MANIFEST.chain.forEach((n,i)=>{
    const node=el('div','node'); node.append(el('h4',null,esc(n.trigger)),el('div','nw',esc(n.when)))
    const chips=el('div','chips')
    n.loads.forEach(l=>{ const base=l.split(' ')[0].replace('*',''); const c=el('button','chip',esc(l)); if(fileByName(base))c.onclick=()=>openEditor(base); else c.style.cursor='default'; chips.append(c) })
    node.append(chips,el('div','ef',esc(n.effect))); wrap.append(node)
    if(i<MANIFEST.chain.length-1)wrap.append(el('div','arrow','↓'))
  })
  m.append(wrap)
}
function renderEngine(){
  const m=$('#main'); m.innerHTML=''
  const rt=MANIFEST.runtime||{}
  m.append(el('div','pane-h','<h2>Engine config</h2><span class="ro">view-only</span>'))
  m.append(el('div','when','The gateway runtime from openclaw.json — the model that reads the brain, live channels, how the beats fire. Secrets never shown. Guarded editing lands with authoring.'))
  if(!rt.available){ m.append(el('div','hint','Engine config not readable from here yet.')); return }
  const grid=el('div','rt')
  const card=(k,v)=>{ const c=el('div','kv'); c.append(el('span','k label',k)); c.append(el('div','v',v)); return c }
  const pills=a=>(a&&a.length)?a.map(x=>'<span class="pill">'+esc(x)+'</span>').join(''):'<span style="color:var(--faint)">—</span>'
  grid.append(card('Version',esc(rt.version||'—')))
  grid.append(card('Model · primary',esc(rt.model&&rt.model.primary||'—')))
  grid.append(card('Model · fallbacks',pills(rt.model&&rt.model.fallbacks)))
  grid.append(card('Thinking default',esc(rt.thinkingDefault||'—')))
  grid.append(card('Memory search',esc(rt.memorySearch||'—')))
  grid.append(card('Plugins on',pills(rt.plugins)))
  grid.append(card('Channels',pills(rt.channels)))
  grid.append(card('Heartbeat',rt.heartbeat?esc((rt.heartbeat.every==='0m'?'off':rt.heartbeat.every)+(rt.heartbeat.isolated?' · isolated':'')):'—'))
  grid.append(card('Gateway','<span class="pill">bind: '+esc(rt.gateway&&rt.gateway.bind||'?')+'</span><span class="pill">device-auth: '+esc(rt.gateway&&rt.gateway.deviceAuth||'?')+'</span>'))
  grid.append(card('Cockpit origins',pills(rt.gateway&&rt.gateway.allowedOrigins)))
  m.append(grid)
}

// ---- editor drawer ----
function diffLines(content,baseline){
  const cl=content.split('\\n')
  if(baseline==null)return cl.map(t=>({t,cls:'u'}))
  const bl=new Set(baseline.split('\\n').map(s=>s.trim()))
  return cl.map(t=>({t,cls:(bl.has(t.trim())||t.trim()==='')?'t':'u'}))
}
const scrim=$('#scrim'), drawer=$('#drawer')
function closeDrawer(){ scrim.classList.remove('open'); drawer.classList.remove('open'); drawer.setAttribute('aria-hidden','true') }
scrim.onclick=closeDrawer
document.addEventListener('keydown',e=>{ if(e.key==='Escape')closeDrawer() })
async function openEditor(name){
  scrim.classList.add('open'); drawer.classList.add('open'); drawer.setAttribute('aria-hidden','false')
  drawer.innerHTML='<div class="spinner" style="padding:40px 24px">opening '+esc(name)+'…</div>'
  const d=await (await fetch('/console/api/file?name='+encodeURIComponent(name))).json()
  const meta=d.meta||{}
  drawer.innerHTML=''
  const yours=(meta.origin!=='stock')
  const dh=el('div','dh')
  dh.innerHTML='<h2>'+esc(name)+'</h2><span class="tg" style="color:'+(yours?'var(--yours)':'var(--stock)')+';background:'+(yours?'var(--yours-bg)':'var(--stock-bg)')+'">'+(yours?'yours':'stock')+'</span><span class="sp"></span><button class="dclose" id="dx" aria-label="Close">✕</button>'
  drawer.append(dh)
  const bar=el('div','dbar')
  const seg=el('div','seg'); const rb=el('button',null,'Read'); rb.classList.add('on'); const eb=el('button',null,'Edit'); seg.append(rb,eb); bar.append(seg)
  const save=el('button','btn','Save + commit'); save.disabled=true; save.style.display='none'
  const revert=el('button','btn ghost','Revert'); revert.style.display='none'
  const status=el('span','status')
  bar.append(save,revert,status); drawer.append(bar)
  const body=el('div','dbody'); drawer.append(body)
  $('#dx').onclick=closeDrawer
  let MODE='read'
  const renderRead=()=>{ body.innerHTML=''; const doc=el('div','doc'); diffLines(d.content||'',d.baseline).forEach((r,i)=>{ const ln=el('div','ln'+(r.cls==='u'?' u':(d.baseline!=null?' t':''))); ln.innerHTML='<span class="g">'+(i+1)+'</span>'+esc(r.t); doc.append(ln) }); body.append(doc); if(d.baseline==null)body.append(el('div','hint','No baseline on file — everything here is authored for Luke.')) }
  const renderEdit=()=>{ body.innerHTML=''; const ta=el('textarea','edit'); ta.value=d.content||''; ta.spellcheck=false; ta.oninput=()=>{ save.disabled=(ta.value===d.content) }; body.append(ta); body._ta=ta; ta.focus() }
  const setMode=m=>{ MODE=m; rb.classList.toggle('on',m==='read'); eb.classList.toggle('on',m==='edit'); save.style.display=m==='edit'?'':'none'; revert.style.display=m==='edit'?'':'none'; status.textContent=''; status.className='status'; m==='read'?renderRead():renderEdit() }
  rb.onclick=()=>setMode('read'); eb.onclick=()=>{ if(meta.editable)setMode('edit') }
  if(!meta.editable){ eb.disabled=true; eb.title='read-only' }
  revert.onclick=()=>{ if(body._ta){ body._ta.value=d.content; save.disabled=true } }
  save.onclick=async()=>{ const ta=body._ta; if(!ta)return; save.disabled=true; status.className='status'; status.textContent='saving…'; try{ const r=await (await fetch('/console/api/save',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({name,content:ta.value})})).json(); if(r.ok){ d.content=ta.value; status.className='status ok'; status.textContent=r.committed?'saved + committed':'saved (not committed)' } else { status.className='status err'; status.textContent='refused: '+(r.why||'error') } }catch(e){ status.className='status err'; status.textContent='save failed' } }
  setMode('read')
}
boot().catch(e=>{ $('#main').innerHTML='<div class="hint" style="color:var(--critical)">Could not load configuration. '+esc(e.message)+'</div>' })
</script></body></html>`
