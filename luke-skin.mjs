// Nave skin for the OpenClaw cockpit.
//
// The Control UI is a third-party SPA whose palette + type + shape ride on ~120
// named CSS custom properties (probed live from its bundle — see ops/oc-skin-probe.sh).
// We don't fight its selectors — we override the tokens, comprehensively:
//   • every SURFACE token → warm brown-black (so nothing stays neutral gray)
//   • every ACCENT/interactive token → brass
//   • --font-display → serif, --mono → a real mono, + mono-uppercase button labels
//     (the actual Nave signature, not just a recolor)
//   • --radius* / --shadow* → Nave's geometry
//
// luke-service serves this at cockpit.nave.pub/__nave-skin.css and injects a
// <link> to it just before </head> of the SPA document (see handleCockpitSkin),
// so it loads AFTER the app's own bundle and wins on equal specificity. The
// theme system is :root (dark, default) and :root[data-theme-mode="light"]
// (light) — we match both exactly.

const SKIN_CSS = `/* ============ Nave skin — brass on warm brown-black. Dark (default). ============ */
:root {
  /* surfaces — layered warm brown-black; NOTHING left neutral */
  --bg:#0b0906; --bg-accent:#151009; --bg-content:#0d0a07; --bg-elevated:#171109;
  --bg-hover:#1c1409; --bg-muted:#13100a;
  --chrome:#100c07; --chrome-strong:#0a0805;
  --card:#151009; --card-foreground:#f4efe4; --card-highlight:#1f1710;
  --panel:#151009; --panel-strong:#1c1510; --panel-hover:#1c1409;
  --popover:#151009; --popover-foreground:#f4efe4;
  --secondary:#1c1510; --secondary-foreground:#f4efe4;
  --input:#0d0a06; --tool-shell:#100c07;
  /* text */
  --text:#f4efe4; --text-strong:#fff8ec; --chat-text:#ece4d2;
  --muted:#9c927f; --muted-strong:#b7ac96; --muted-foreground:#9c927f;
  /* borders + grid */
  --border:#2a2317; --border-strong:#3a3020; --border-hover:#4a3d26; --grid-line:#211b12;
  /* accent — brass, the signature */
  --accent:#c39a56; --accent-hover:#e2c079; --accent-muted:#8a6f3f; --accent-subtle:#241d10;
  --accent-foreground:#0b0906; --accent-glow:color-mix(in srgb,#c39a56 40%,transparent);
  --primary:#c39a56; --primary-foreground:#0b0906;
  --ring:#c39a56; --focus:#c39a56;
  --focus-ring:color-mix(in srgb,#c39a56 55%,transparent);
  --focus-glow:color-mix(in srgb,#c39a56 30%,transparent);
  --selection-bg:color-mix(in srgb,#c39a56 30%,transparent); --selection-fg:#fff8ec;
  /* interactive-state tokens (were left stock → the "patchy" look) */
  --action:#c39a56; --active:#c39a56; --clickable:#c39a56; --openable:#c39a56;
  --expandable:#c39a56; --tweak:#c39a56; --more:#c9b48c; --icon:#c9b48c;
  /* secondary accent — muted sage, for variety + the ok/success family */
  --accent-2:#8fae6a; --accent-2-muted:#5f7548; --accent-2-subtle:#18200f;
  /* status */
  --ok:#8fae6a; --ok-muted:#5f7548; --ok-subtle:#18200f; --done:#8fae6a; --combined:#8fae6a;
  --info:#7f95ad;
  --warn:#d9a648; --warn-muted:#8a6a2c; --warn-subtle:#241d0c; --running:#d9a648;
  --danger:#c0705a; --danger-muted:#7a4739; --danger-subtle:#241310;
  --destructive:#c0705a; --destructive-foreground:#fff8ec; --error:#c0705a; --stop:#c0705a;
  --skip:#9c927f; --empty:#6b6353;
  --health-highlight:color-mix(in srgb,#c39a56 22%,transparent);
  /* code mirror */
  --cm-bg:#0d0a07; --cm-border:#2a2317; --cm-code-bg:#12100a; --cm-inline-code-bg:#1c1510;
  --cm-link:#c39a56; --cm-success:#8fae6a; --cm-warning:#d9a648; --cm-danger:#c0705a; --cm-info:#7f95ad;
  --cm-mono:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;
  /* markdown preview */
  --md-preview-document-bg:#0d0a07; --md-preview-serif:Georgia,"Times New Roman",serif;
  /* workboard controls */
  --workboard-control-bg:#151009; --workboard-control-border:#2a2317;
  --workboard-control-border-hover:#4a3d26;
  --workboard-health-color:#c39a56;
  --workboard-health-highlight-color:color-mix(in srgb,#c39a56 22%,transparent);
  /* TYPE — the Nave feel: serif display, real mono */
  --font-display:Georgia,"Times New Roman",serif;
  --mono:ui-monospace,SFMono-Regular,"SF Mono",Menlo,Consolas,"Liberation Mono",monospace;
  --luke-av:var(--luke-av);
  /* geometry */
  --radius:8px; --radius-sm:4px; --radius-md:8px; --radius-lg:12px; --radius-xl:16px; --radius-full:999px;
  /* shadows — deep + warm, with a brass glow */
  --shadow-sm:0 1px 2px -1px #000; --shadow-md:0 6px 20px -10px #000;
  --shadow-lg:0 18px 45px -22px #000; --shadow-xl:0 30px 80px -40px #000;
  --shadow-glow:0 0 0 1px color-mix(in srgb,#c39a56 30%,transparent),0 0 24px -6px color-mix(in srgb,#c39a56 35%,transparent);
}
/* ============ Light mode — warm bone, brass darkened to stay legible. ============ */
:root[data-theme-mode="light"] {
  --bg:#f5f0e4; --bg-accent:#fffdf7; --bg-content:#fffdf7; --bg-elevated:#fffdf7;
  --bg-hover:#ece4d2; --bg-muted:#ece4d2;
  --chrome:#efe7d6; --chrome-strong:#f5f0e4;
  --card:#fffdf7; --card-foreground:#241d12; --card-highlight:#ece4d2;
  --panel:#fffdf7; --panel-strong:#efe7d6; --panel-hover:#ece4d2;
  --popover:#fffdf7; --popover-foreground:#241d12;
  --secondary:#ece4d2; --secondary-foreground:#241d12;
  --input:#fffdf7; --tool-shell:#efe7d6;
  --text:#241d12; --text-strong:#120d06; --chat-text:#2c2416;
  --muted:#6f6553; --muted-strong:#4f4636; --muted-foreground:#6f6553;
  --border:#ddd2ba; --border-strong:#c8b89a; --border-hover:#b0a17f; --grid-line:#e4dac4;
  --accent:#8f6a2c; --accent-hover:#b0863c; --accent-muted:#b0a17f; --accent-subtle:#efe6d2;
  --accent-foreground:#fffdf7; --accent-glow:color-mix(in srgb,#8f6a2c 30%,transparent);
  --primary:#8f6a2c; --primary-foreground:#fffdf7; --ring:#8f6a2c; --focus:#8f6a2c;
  --action:#8f6a2c; --active:#8f6a2c; --clickable:#8f6a2c; --openable:#8f6a2c;
  --expandable:#8f6a2c; --tweak:#8f6a2c; --more:#8f6a2c; --icon:#8f6a2c;
  --accent-2:#4f7a34; --accent-2-muted:#7d9a5c; --accent-2-subtle:#e6eed6;
  --ok:#4f7a34; --done:#4f7a34; --combined:#4f7a34; --info:#48607a;
  --warn:#9a6a12; --running:#9a6a12; --danger:#a2482f; --destructive:#a2482f; --error:#a2482f; --stop:#a2482f;
  --md-preview-document-bg:#fffdf7;
  --cm-bg:#fffdf7; --cm-border:#ddd2ba; --cm-code-bg:#f2ead9; --cm-inline-code-bg:#ece4d2; --cm-link:#8f6a2c;
  --workboard-control-bg:#fffdf7; --workboard-control-border:#ddd2ba; --workboard-health-color:#8f6a2c;
}
/* ============ Character the tokens can't reach ============ */
/* Nave signature: text buttons in tracked, uppercase mono. (Icon-only buttons keep their glyph.) */
.btn:not(.btn--icon):not(.btn-kbd){font-family:var(--mono);text-transform:uppercase;letter-spacing:.06em}
::selection{background:color-mix(in srgb,#c39a56 30%,transparent);color:#fff8ec}
*{scrollbar-color:#3a3020 transparent}

/* ============ Rebrand — Luke, on the Nave (not OpenClaw) ============ */
/* Kill OpenClaw's own update-nag banner. */
.update-banner{display:none!important}
/* Sidebar brand block → a brass Luke seal + NAVE / Luke wordmark. The seal is a
   ::before over a hidden original; the eyebrow/title text is replaced via ::after. */
.sidebar-brand__logo{content:var(--luke-av)!important;object-fit:cover!important;border-radius:9px!important;overflow:hidden}
.sidebar-brand__eyebrow{font-size:0!important}
.sidebar-brand__eyebrow::after{content:"NAVE";font-family:var(--mono);font-size:11px;letter-spacing:.26em;color:var(--accent)}
.sidebar-brand__title{font-size:0!important;line-height:1.15!important}
.sidebar-brand__title::after{content:"Luke";font-family:Georgia,"Times New Roman",serif;font-size:19px;letter-spacing:.02em;color:var(--text-strong)}
/* Luke's chat avatar → the same brass seal instead of the pig mascot. */
.agent-chat__avatar--logo,.chat-avatar--logo,.assistant-avatar{content:var(--luke-av)!important;background:#0b0906 center/cover no-repeat var(--luke-av)!important;object-fit:cover!important;overflow:hidden}
.agent-chat__avatar--logo svg,.chat-avatar--logo svg,.assistant-avatar svg{opacity:0!important}
/* The stock device-login logo (OpenClaw device auth is off, but tidy it). */
.login-gate__logo{opacity:0}
`

// Inject the skin <link> into the SPA document, just before </head> so it loads
// after the app's own stylesheet and wins.
function inject(htmlText) {
  // Skin + Luke's favicon, added after the app's own <head>. Drop OpenClaw's
  // own icon links first so the tab shows Luke's face, not the pig.
  const head = '<link rel="stylesheet" href="/__nave-skin.css">'
    + '<link rel="icon" href="https://nave.pub/assets/avatars/luke.png">'
  let out = htmlText.replace(/<link[^>]+rel=["']?[^"'>]*icon[^"'>]*["']?[^>]*>/ig, '')
  out = out.includes('</head>') ? out.replace('</head>', head + '</head>') : out + head
  // Rebrand the browser-tab title too (the shell ships "OpenClaw Control").
  out = out.replace(/<title>[^<]*<\/title>/i, '<title>Luke · Nave</title>')
  return out
}

const OC_ORIGIN = process.env.OPENCLAW_ORIGIN?.trim() || 'http://openclaw:57419'

// Handles cockpit.nave.pub requests that Caddy routes to luke: the skin
// stylesheet, and the SPA document (which we fetch from OpenClaw + inject).
// Returns true if handled. Anything under /gate/* returns false so luke's gate
// routes run instead.
export async function handleCockpitSkin(req, res, url) {
  if (url === '/__nave-skin.css') {
    res.writeHead(200, { 'content-type': 'text/css; charset=utf-8', 'cache-control': 'public, max-age=60' }).end(SKIN_CSS)
    return true
  }
  if (url.startsWith('/gate')) return false           // let luke's gate handlers run
  // The SPA document — fetch the shell from OpenClaw and inject the skin.
  try {
    const upstream = await fetch(OC_ORIGIN + req.url, { headers: { accept: 'text/html' } })
    const body = await upstream.text()
    const ct = upstream.headers.get('content-type') || 'text/html; charset=utf-8'
    const out = ct.includes('html') ? inject(body) : body
    res.writeHead(upstream.status, { 'content-type': ct }).end(out)
  } catch (e) {
    res.writeHead(502, { 'content-type': 'text/plain' }).end('cockpit upstream unavailable')
  }
  return true
}
