// Nave skin for the OpenClaw cockpit.
//
// The Control UI is a third-party SPA whose entire palette rides on ~141 named
// CSS custom properties (--bg, --panel, --text, --accent, --primary, --ring, …)
// keyed off a data-theme system. So we don't fight its selectors — we override
// the tokens. luke-service serves this stylesheet at cockpit.nave.pub/__nave-skin.css
// and injects a <link> to it into the SPA's document (see handleCockpitSkin),
// so it loads AFTER the app's own bundle and wins. Assets + the gateway
// WebSocket never pass through here — only the initial HTML navigation does.
//
// It re-tints the default "claw" theme (dark + light). Other built-in themes
// (openknot/dash) keep their own look; James uses the default.

const SKIN_CSS = `/* Nave skin — brass on warm brown-black. Overrides OpenClaw's theme tokens. */
:root, :root[data-theme="dark"], :root[data-theme="light"] {
  --bg:#0b0906; --bg-accent:#14100a; --bg-elevated:#14100a; --bg-hover:#1b1409; --bg-muted:#12100a;
  --card:#14100a; --card-foreground:#f4efe4; --card-highlight:#1b1409;
  --popover:#14100a; --popover-foreground:#f4efe4;
  --panel:#14100a; --panel-strong:#1b1409; --panel-hover:#1b1409;
  --chrome:#12100a; --chrome-strong:#0b0906;
  --text:#f4efe4; --text-strong:#fff8ec; --chat-text:#f4efe4;
  --muted:#9c927f; --muted-strong:#b7ac96; --muted-foreground:#9c927f;
  --border:#2a2317; --border-strong:#3a3020; --border-hover:#4a3d26;
  --input:#0d0a06; --ring:#c39a56;
  --accent:#c39a56; --accent-hover:#e2c079; --accent-muted:#8a6f3f; --accent-subtle:#241d10;
  --accent-foreground:#0b0906; --accent-glow:color-mix(in srgb,#c39a56 40%,transparent);
  --selection-bg:color-mix(in srgb,#c39a56 30%,transparent); --selection-fg:#fff8ec;
  --primary:#c39a56; --primary-foreground:#0b0906;
  --secondary:#1b1409; --secondary-foreground:#f4efe4;
  --accent-2:#8fae6a; --accent-2-muted:#5f7548; --accent-2-subtle:#18200f;
  --ok:#8fae6a; --ok-muted:#5f7548; --ok-subtle:#18200f;
  --info:#7f95ad;
  --warn:#d9a648; --warn-muted:#8a6a2c; --warn-subtle:#241d0c;
  --danger:#c0705a; --danger-muted:#7a4739; --danger-subtle:#241310;
  --destructive:#c0705a; --destructive-foreground:#fff8ec;
  --focus:#c39a56; --focus-ring:color-mix(in srgb,#c39a56 55%,transparent);
  --focus-glow:color-mix(in srgb,#c39a56 30%,transparent);
  --grid-line:#2a2317;
  --mono:ui-monospace,SFMono-Regular,"SF Mono",Menlo,Consolas,"Roboto Mono",monospace;
}
/* Light mode of the default theme — warm bone, brass darkened to stay legible. */
:root[data-theme-mode="light"] {
  --bg:#f5f0e4; --bg-accent:#fffdf7; --bg-elevated:#fffdf7; --bg-hover:#ece4d2; --bg-muted:#ece4d2;
  --card:#fffdf7; --card-foreground:#241d12; --card-highlight:#ece4d2;
  --popover:#fffdf7; --popover-foreground:#241d12;
  --panel:#fffdf7; --panel-strong:#ece4d2; --panel-hover:#ece4d2;
  --chrome:#ece4d2; --chrome-strong:#f5f0e4;
  --text:#241d12; --text-strong:#120d06; --chat-text:#241d12;
  --muted:#6f6553; --muted-strong:#4f4636; --muted-foreground:#6f6553;
  --border:#ddd2ba; --border-strong:#c8b89a; --border-hover:#b0a17f;
  --input:#fffdf7; --ring:#8f6a2c;
  --accent:#8f6a2c; --accent-hover:#b0863c; --accent-muted:#b0a17f; --accent-subtle:#efe6d2;
  --accent-foreground:#fffdf7; --accent-glow:color-mix(in srgb,#8f6a2c 30%,transparent);
  --primary:#8f6a2c; --primary-foreground:#fffdf7;
  --secondary:#ece4d2; --secondary-foreground:#241d12;
  --ok:#4f7a34; --warn:#9a6a12; --danger:#a2482f; --destructive:#a2482f;
  --focus:#8f6a2c; --info:#48607a;
}
/* A couple of nudges the tokens don't reach: the seal glow on the brand + a
   slightly warmer scrollbar. Kept minimal — the tokens do the real work. */
::selection{background:color-mix(in srgb,#c39a56 30%,transparent)}
* { scrollbar-color: #3a3020 transparent; }
`

// Inject the skin <link> into the SPA document, just before </head> so it loads
// after the app's own stylesheet and wins.
function inject(htmlText) {
  const tag = '<link rel="stylesheet" href="/__nave-skin.css">'
  return htmlText.includes('</head>') ? htmlText.replace('</head>', tag + '</head>') : htmlText + tag
}

const OC_ORIGIN = process.env.OPENCLAW_ORIGIN?.trim() || 'http://openclaw:57419'

// Handles cockpit.nave.pub requests that Caddy routes to luke: the skin
// stylesheet, and the SPA document (which we fetch from OpenClaw + inject).
// Returns true if handled. Anything under /gate/* returns false so luke's gate
// routes run instead.
export async function handleCockpitSkin(req, res, url) {
  if (url === '/__nave-skin.css') {
    res.writeHead(200, { 'content-type': 'text/css; charset=utf-8', 'cache-control': 'public, max-age=300' }).end(SKIN_CSS)
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
