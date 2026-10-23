// Skin proxy test — a stand-in OpenClaw on loopback records what Luke's
// cockpit-document fetch sends it. OpenClaw 2026.10 answers 403
// proxy_attribution_required unless the proxy names the client, so the
// forwarding headers Caddy set must reach it.
import assert from 'node:assert'
import { createServer } from 'node:http'

let seen
const oc = createServer((req, res) => { seen = req.headers; res.writeHead(200, { 'content-type': 'text/html' }).end('<html><head></head><body></body></html>') })
await new Promise(r => oc.listen(0, '127.0.0.1', r))
process.env.OPENCLAW_ORIGIN = `http://127.0.0.1:${oc.address().port}`
const { handleCockpitSkin } = await import('./luke-skin.mjs')

const fakeRes = () => { const r = { status: 0, body: '', writeHead(s) { r.status = s; return r }, end(b) { r.body = b; return r } }; return r }

let res = fakeRes()
await handleCockpitSkin({ url: '/', headers: { 'x-forwarded-for': '203.0.113.9', 'x-forwarded-proto': 'https', 'x-forwarded-host': 'cockpit.nave.pub', cookie: 'nave_gate=x' } }, res, '/')
assert.equal(res.status, 200)
assert.equal(seen['x-forwarded-for'], '203.0.113.9')
assert.equal(seen['x-forwarded-proto'], 'https')
assert.equal(seen['x-forwarded-host'], 'cockpit.nave.pub')
assert.equal(seen.cookie, undefined, 'the gate cookie must not leak to OpenClaw')
assert.equal(seen['x-forwarded-user'], undefined, 'Luke never asserts an operator identity')
assert.match(res.body, /__nave-skin\.css/)

res = fakeRes()
await handleCockpitSkin({ url: '/', headers: {} }, res, '/')
assert.equal(seen['x-forwarded-for'], undefined)

oc.close()
console.log('✓ skin proxy passes the client attribution headers, and nothing else')
