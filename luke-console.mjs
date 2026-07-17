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
  { name: 'SOUL.md',       group: 'Identity',         editable: true,  loadWhen: 'Every session — read first ("who you are")' },
  { name: 'IDENTITY.md',   group: 'Identity',         editable: true,  loadWhen: 'Every session (bootstrap identity record)' },
  { name: 'USER.md',       group: 'Identity',         editable: true,  loadWhen: 'Every session ("who you’re helping")' },
  { name: 'AGENTS.md',     group: 'Operating manual', editable: true,  loadWhen: 'Every session — always injected (the SOP)' },
  { name: 'HEARTBEAT.md',  group: 'Rhythm',           editable: true,  loadWhen: 'Loaded every session; drives the two daily beats' },
  { name: 'TOOLS.md',      group: 'Capabilities',     editable: true,  loadWhen: 'Every session (local setup + what is NOT wired)' },
  { name: 'MEMORY.md',     group: 'Memory',           editable: true,  loadWhen: 'MAIN session only — curated long-term memory' },
  { name: 'punchlist.md',  group: 'Ledger',           editable: true,  loadWhen: 'Read by the morning beat; kept honest live' },
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
    return (j(res, 200, { files, chain: CHAIN, runtime: runtimeView() }), true)
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
<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Crect x='1' y='1' width='30' height='30' rx='7' fill='%230b0906' stroke='%23c39a56' stroke-opacity='.5' stroke-width='1.2'/%3E%3Ctext x='16' y='22' font-size='16' text-anchor='middle' fill='%23c39a56'%3E🧠%3C/text%3E%3C/svg%3E">
<style>
:root{
  --ground:#0b0906;--panel:#14100a;--panel-2:#1b1409;--line:#2a2317;--line-strong:#3a3020;--field:#0d0a06;
  --text:#f4efe4;--dim:#9c927f;--faint:#6f6555;--accent:#c39a56;--accent-bright:#e2c079;--accent-ink:#0b0906;
  --good:#8fae6a;--warn:#d9a648;--critical:#c0705a;
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
  --diff-user:#4f7a34;--diff-user-bg:#e9f0dd;--diff-template:#48607a;--diff-template-bg:#e6ecf3;
}
*{box-sizing:border-box}
html,body{margin:0;height:100%}
body{background:var(--ground);color:var(--text);font-family:var(--sans);font-size:15px;line-height:1.55;
  display:grid;grid-template-rows:auto 1fr;height:100vh;overflow:hidden}
.label{font-family:var(--mono);text-transform:uppercase;letter-spacing:.13em;font-size:10.5px;font-weight:600;color:var(--faint)}
.mono{font-family:var(--mono)}
/* header */
header{display:flex;align-items:center;gap:16px;padding:14px 22px;border-bottom:1px solid var(--line-strong);background:linear-gradient(180deg,var(--panel),var(--ground))}
.brand{display:flex;align-items:baseline;gap:10px}
.brand .mark{font-size:18px}
.brand h1{font-family:var(--mono);font-size:15px;font-weight:700;letter-spacing:.18em;text-transform:uppercase;margin:0;color:var(--text)}
.brand .sub{font-family:var(--display);font-style:italic;color:var(--dim);font-size:14px}
header .sp{flex:1}
.hbtn{font-family:var(--mono);font-size:11px;letter-spacing:.06em;color:var(--dim);background:transparent;border:1px solid var(--line-strong);border-radius:6px;padding:7px 11px;cursor:pointer;text-decoration:none}
.hbtn:hover{border-color:var(--accent);color:var(--accent-bright)}
/* layout */
main{display:grid;grid-template-columns:262px 1fr;min-height:0}
@media(max-width:820px){main{grid-template-columns:1fr}.tree{display:none}}
.tree{border-right:1px solid var(--line);overflow-y:auto;padding:16px 0}
.grp{padding:16px 20px 6px}.grp:first-child{padding-top:4px}
.grp .label{display:block;margin-bottom:8px}
.f{display:block;width:100%;text-align:left;background:transparent;border:0;border-left:2px solid transparent;
  color:var(--text);font-family:var(--sans);font-size:14px;padding:8px 20px;cursor:pointer}
.f:hover{background:color-mix(in srgb,var(--accent) 7%,transparent)}
.f.on{background:color-mix(in srgb,var(--accent) 12%,transparent);border-left-color:var(--accent);color:var(--accent-bright)}
.f .fn{font-family:var(--mono);font-size:13px}
.f .fw{display:block;color:var(--faint);font-size:11px;margin-top:2px;line-height:1.35}
/* pane */
.pane{min-width:0;overflow-y:auto;padding:22px 26px 60px}
.crumbs{display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin-bottom:4px}
.crumbs h2{font-family:var(--mono);font-size:19px;letter-spacing:.02em;margin:0;color:var(--text)}
.tag{font-family:var(--mono);font-size:10.5px;letter-spacing:.06em;text-transform:uppercase;color:var(--dim);border:1px solid var(--line-strong);border-radius:999px;padding:3px 9px}
.when{color:var(--dim);font-size:13.5px;margin:2px 0 16px}
.toolbar{display:flex;align-items:center;gap:8px;margin-bottom:12px;flex-wrap:wrap}
.seg{display:inline-flex;border:1px solid var(--line-strong);border-radius:7px;overflow:hidden}
.seg button{font-family:var(--mono);font-size:11px;letter-spacing:.05em;background:transparent;color:var(--dim);border:0;padding:7px 13px;cursor:pointer}
.seg button.on{background:var(--accent);color:var(--accent-ink)}
.btn{font-family:var(--mono);font-size:11.5px;letter-spacing:.06em;background:var(--accent);color:var(--accent-ink);border:0;border-radius:7px;padding:8px 15px;cursor:pointer;font-weight:600}
.btn:hover{background:var(--accent-bright)}.btn:disabled{opacity:.4;cursor:default}
.btn.ghost{background:transparent;border:1px solid var(--line-strong);color:var(--dim)}
.btn.ghost:hover{border-color:var(--accent);color:var(--accent-bright)}
.legend{display:flex;gap:14px;align-items:center;margin-left:auto;font-size:11.5px;color:var(--dim)}
.legend b{font-weight:600}.sw{display:inline-block;width:11px;height:11px;border-radius:3px;vertical-align:-1px;margin-right:5px}
.swu{background:var(--diff-user-bg);border:1px solid var(--diff-user)}
.swt{background:var(--diff-template-bg);border:1px solid var(--diff-template)}
/* doc render */
.doc,.edit{border:1px solid var(--line);border-radius:10px;background:var(--field);font-family:var(--mono);font-size:13px;line-height:1.7}
.doc{padding:4px 0;overflow-x:auto}
.doc .ln{display:block;padding:1px 16px;white-space:pre-wrap;word-break:break-word;border-left:2px solid transparent}
.doc .ln.u{background:var(--diff-user-bg);border-left-color:var(--diff-user)}
.doc .ln.t{background:var(--diff-template-bg);border-left-color:var(--diff-template)}
.doc .ln .g{color:var(--faint);user-select:none;display:inline-block;width:2.2em;text-align:right;margin-right:14px}
.edit{width:100%;min-height:58vh;color:var(--text);padding:14px 16px;resize:vertical;border-color:var(--line-strong);outline:none}
.edit:focus{border-color:var(--accent)}
.status{font-family:var(--mono);font-size:11.5px;color:var(--dim);margin-left:10px}
.status.ok{color:var(--good)}.status.err{color:var(--critical)}
/* chain */
.chain{display:grid;gap:12px;margin-top:6px}
.node{border:1px solid var(--line);border-radius:10px;background:linear-gradient(180deg,color-mix(in srgb,var(--panel) 70%,var(--ground)),var(--ground));padding:16px 18px}
.node h3{font-family:var(--mono);font-size:13px;letter-spacing:.05em;text-transform:uppercase;margin:0 0 2px;color:var(--accent-bright)}
.node .nw{color:var(--faint);font-size:11.5px;font-family:var(--mono);margin-bottom:10px}
.chips{display:flex;flex-wrap:wrap;gap:6px;margin-bottom:10px}
.chip{font-family:var(--mono);font-size:11px;color:var(--text);background:color-mix(in srgb,var(--accent) 9%,transparent);border:1px solid color-mix(in srgb,var(--accent) 32%,transparent);border-radius:6px;padding:3px 8px;cursor:pointer}
.chip:hover{border-color:var(--accent)}
.node .eff{color:var(--dim);font-size:13.5px}
.arrow{text-align:center;color:var(--faint);font-size:15px;line-height:1}
/* runtime */
.rt{display:grid;grid-template-columns:repeat(auto-fill,minmax(200px,1fr));gap:12px;margin-top:6px}
.kv{border:1px solid var(--line);border-radius:9px;background:var(--panel);padding:13px 15px}
.kv .k{display:block;margin-bottom:6px}
.kv .v{font-family:var(--mono);font-size:13px;color:var(--text);word-break:break-word}
.kv .v .pill{display:inline-block;font-size:11px;background:color-mix(in srgb,var(--accent) 10%,transparent);border:1px solid color-mix(in srgb,var(--accent) 30%,transparent);border-radius:5px;padding:1px 7px;margin:2px 3px 0 0}
.ro{display:inline-block;font-family:var(--mono);font-size:10px;letter-spacing:.05em;color:var(--warn);border:1px solid color-mix(in srgb,var(--warn) 45%,transparent);border-radius:999px;padding:2px 8px}
.hint{color:var(--faint);font-size:12.5px;margin-top:14px;line-height:1.6;max-width:70ch}
.spinner{color:var(--dim);font-family:var(--mono);font-size:13px;padding:40px 0}
</style></head><body>
<header>
  <div class="brand"><span class="mark">🧠</span><h1>Luke Console</h1><span class="sub">his total configuration, made legible</span></div>
  <span class="sp"></span>
  <button class="hbtn" id="theme">theme</button>
  <a class="hbtn" href="/gate/logout">sign out</a>
</header>
<main>
  <nav class="tree" id="tree"><div class="spinner" style="padding:20px">loading…</div></nav>
  <section class="pane" id="pane"><div class="spinner">loading Luke’s configuration…</div></section>
</main>
<script>
const $ = s => document.querySelector(s)
const el = (t, c, h) => { const e = document.createElement(t); if(c) e.className=c; if(h!=null) e.innerHTML=h; return e }
const esc = s => String(s).replace(/[&<>]/g, m => ({'&':'&amp;','<':'&lt;','>':'&gt;'}[m]))
let MANIFEST = null, CUR = null, MODE = 'read'

// theme toggle (persisted)
const root = document.documentElement
const savedTheme = localStorage.getItem('nave-theme')
if (savedTheme) root.setAttribute('data-theme', savedTheme)
$('#theme').onclick = () => {
  const cur = root.getAttribute('data-theme') || (matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark')
  const next = cur === 'dark' ? 'light' : 'dark'
  root.setAttribute('data-theme', next); localStorage.setItem('nave-theme', next)
}

// simple line-level diff: mark content lines not in the baseline as "yours".
function diffLines(content, baseline) {
  const cl = content.split('\\n')
  if (baseline == null) return cl.map(t => ({ t, cls: 'u' }))  // no baseline → all authored
  const bl = new Set(baseline.split('\\n').map(s => s.trim()))
  return cl.map(t => ({ t, cls: bl.has(t.trim()) || t.trim()==='' ? 't' : 'u' }))
}

async function boot() {
  MANIFEST = await (await fetch('/console/api/manifest')).json()
  renderTree(); renderChain()
}
function renderTree() {
  const tree = $('#tree'); tree.innerHTML = ''
  const groups = [...new Set(MANIFEST.files.map(f => f.group))]
  // pinned: the behavior chain + runtime views
  const nav = el('div', 'grp')
  nav.append(el('span','label','Overview'))
  for (const [id,label] of [['chain','⚯ Behavior chain'],['runtime','⚙ Engine config']]) {
    const b = el('button','f'); b.dataset.view=id; b.innerHTML='<span class="fn">'+label+'</span>'
    b.onclick=()=>openView(id); nav.append(b)
  }
  tree.append(nav)
  for (const g of groups) {
    const box = el('div','grp'); box.append(el('span','label',g))
    for (const f of MANIFEST.files.filter(x=>x.group===g)) {
      const b = el('button','f'); b.dataset.file=f.name
      b.innerHTML='<span class="fn">'+esc(f.name)+'</span><span class="fw">'+esc(f.loadWhen)+'</span>'
      b.onclick=()=>openFile(f.name); box.append(b)
    }
    tree.append(box)
  }
}
function markActive(sel){ document.querySelectorAll('.f').forEach(b=>b.classList.remove('on')); const a=document.querySelector(sel); if(a)a.classList.add('on') }

function renderChain(){ /* chain view is rendered on demand in openView */ }

async function openFile(name) {
  markActive('.f[data-file="'+CSS.escape(name)+'"]')
  CUR = name; MODE = 'read'
  const pane = $('#pane'); pane.innerHTML = '<div class="spinner">opening '+esc(name)+'…</div>'
  const d = await (await fetch('/console/api/file?name='+encodeURIComponent(name))).json()
  const meta = d.meta || {}
  pane.innerHTML = ''
  const head = el('div')
  const cr = el('div','crumbs'); cr.append(el('h2',null,esc(name)), el('span','tag',esc(meta.group||'')))
  head.append(cr, el('div','when',esc(meta.loadWhen||'')))
  pane.append(head)

  const tb = el('div','toolbar')
  const seg = el('div','seg')
  const rb = el('button',null,'Read'); rb.classList.add('on')
  const eb = el('button',null,'Edit')
  seg.append(rb, eb); tb.append(seg)
  const save = el('button','btn','Save + commit'); save.disabled = true
  const revert = el('button','btn ghost','Revert')
  tb.append(save, revert)
  const status = el('span','status')
  tb.append(status)
  const legend = el('div','legend','<span><span class="sw swu"></span><b>yours</b></span><span><span class="sw swt"></span>template / prior</span>')
  tb.append(legend)
  pane.append(tb)

  const view = el('div'); pane.append(view)
  const renderRead = () => {
    view.innerHTML = ''
    const doc = el('div','doc')
    diffLines(d.content||'', d.baseline).forEach((r,i)=>{
      const ln = el('div','ln'+(r.cls==='u'?' u':(d.baseline!=null?' t':'')))
      ln.innerHTML='<span class="g">'+(i+1)+'</span>'+esc(r.t)
      doc.append(ln)
    })
    view.append(doc)
    if (d.baseline == null) view.append(el('div','hint','No baseline on file for this one — everything here is authored for Luke.'))
  }
  const renderEdit = () => {
    view.innerHTML = ''
    const ta = el('textarea','edit'); ta.value = d.content||''; ta.spellcheck=false
    ta.oninput = () => { save.disabled = (ta.value === d.content) }
    view.append(ta); view._ta = ta; ta.focus()
  }
  const setMode = m => {
    MODE = m; rb.classList.toggle('on', m==='read'); eb.classList.toggle('on', m==='edit')
    save.style.display = m==='edit'?'':'none'; revert.style.display = m==='edit'?'':'none'
    legend.style.display = m==='read'?'':'none'
    status.textContent=''; status.className='status'
    m==='read'?renderRead():renderEdit()
  }
  rb.onclick=()=>setMode('read'); eb.onclick=()=>{ if(meta.editable) setMode('edit') }
  revert.onclick=()=>{ if(view._ta){ view._ta.value=d.content; save.disabled=true } }
  save.onclick=async()=>{
    const ta = view._ta; if(!ta) return
    save.disabled=true; status.className='status'; status.textContent='saving…'
    try{
      const r = await (await fetch('/console/api/save',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({name,content:ta.value})})).json()
      if(r.ok){ d.content=ta.value; status.className='status ok'; status.textContent=r.committed?'saved + committed':'saved (not committed)'; }
      else { status.className='status err'; status.textContent='refused: '+(r.why||'error') }
    }catch(e){ status.className='status err'; status.textContent='save failed' }
  }
  if(!meta.editable){ eb.disabled=true; eb.title='read-only' }
  setMode('read')
}

function openView(id){
  markActive('.f[data-view="'+id+'"]')
  CUR=null; const pane=$('#pane'); pane.innerHTML=''
  if(id==='chain'){
    pane.append(el('div','crumbs','<h2>Behavior chain</h2>'))
    pane.append(el('div','when','How the files above become what Luke does — trigger → what loads → the effect. Click a file chip to open it.'))
    const wrap=el('div','chain')
    MANIFEST.chain.forEach((n,i)=>{
      const node=el('div','node')
      node.append(el('h3',null,esc(n.trigger)), el('div','nw',esc(n.when)))
      const chips=el('div','chips')
      n.loads.forEach(l=>{
        const base=l.split(' ')[0].replace('*','')
        const c=el('button','chip',esc(l))
        if(MANIFEST.files.some(f=>f.name===base)) c.onclick=()=>openFile(base); else c.style.cursor='default'
        chips.append(c)
      })
      node.append(chips, el('div','eff',esc(n.effect)))
      wrap.append(node)
      if(i<MANIFEST.chain.length-1) wrap.append(el('div','arrow','↓'))
    })
    pane.append(wrap)
    return
  }
  // runtime
  const rt = MANIFEST.runtime||{}
  pane.append(el('div','crumbs','<h2>Engine config</h2><span class="ro">view-only</span>'))
  pane.append(el('div','when','The gateway runtime from openclaw.json — what model reads the brain, which channels are live, how the beats fire. Secrets are never shown. Editing here is guarded for a later step (a bad edit would brick the gateway).'))
  if(!rt.available){ pane.append(el('div','hint','Engine config not readable from here yet.')); return }
  const grid=el('div','rt')
  const card=(k,vHtml)=>{ const c=el('div','kv'); c.append(el('span','k label',k)); c.append(el('div','v',vHtml)); return c }
  const pills=a=>(a&&a.length)?a.map(x=>'<span class="pill">'+esc(x)+'</span>').join(''):'<span style="color:var(--faint)">—</span>'
  grid.append(card('Version', esc(rt.version||'—')))
  grid.append(card('Model · primary', esc(rt.model?.primary||'—')))
  grid.append(card('Model · fallbacks', pills(rt.model?.fallbacks)))
  grid.append(card('Thinking default', esc(rt.thinkingDefault||'—')))
  grid.append(card('Memory search', esc(rt.memorySearch||'—')))
  grid.append(card('Plugins on', pills(rt.plugins)))
  grid.append(card('Channels', pills(rt.channels)))
  grid.append(card('Heartbeat', rt.heartbeat?esc((rt.heartbeat.every==='0m'?'off':rt.heartbeat.every)+(rt.heartbeat.isolated?' · isolated':'')):'—'))
  grid.append(card('Gateway', '<span class="pill">bind: '+esc(rt.gateway?.bind||'?')+'</span><span class="pill">device-auth: '+esc(rt.gateway?.deviceAuth||'?')+'</span>'))
  grid.append(card('Cockpit origins', pills(rt.gateway?.allowedOrigins)))
  pane.append(grid)
}
boot().catch(e=>{ $('#pane').innerHTML='<div class="hint" style="color:var(--critical)">Could not load configuration. '+esc(e.message)+'</div>' })
</script></body></html>`
