// Gate tests — the REAL service over HTTP, no browser, no relay, no mocks of
// the verification path. Boots luke-service.mjs on a loopback port with a
// throwaway master key, then drives /gate/* exactly as the login page does.
// Two jobs:
//   1. prove verifyNip98's behavior is UNCHANGED (kind, sig, skew, url,
//      method, replay, master-key check) now that the login page has three
//      transports;
//   2. prove the new `via` transport tag rides the token + audit line as
//      display-only data — it never affects authorization.
import assert from 'node:assert'
import { spawn } from 'node:child_process'
import { generateSecretKey, getPublicKey, finalizeEvent, nip19 } from 'nostr-tools'

const PORT = 18944
const BASE = `http://127.0.0.1:${PORT}`
const MASTER_SK = generateSecretKey()
const MASTER_PK = getPublicKey(MASTER_SK)
const OTHER_SK = generateSecretKey()

let n = 0, pass = 0
const t = async (name, fn) => { n++; try { await fn(); pass++; console.log(`ok - ${name}`) } catch (e) { console.error(`FAIL - ${name}\n   ${e.stack || e.message}`) } }

// Sign the same kind-27235 challenge the login page produces. Distinct
// created_at per call (the replay guard dedupes by event id).
let tick = 0
const challenge = (sk, { u = `${BASE}/gate/auth`, method = 'POST', kind = 27235, age = 0 } = {}) =>
  finalizeEvent({ kind, created_at: Math.floor(Date.now() / 1000) - age - (tick++ % 50), tags: [['u', u], ['method', method]], content: '' }, sk)

// In production Caddy sets x-forwarded-proto; without it the service assumes
// https (and our signed u tag is http://…), so the tests supply it like the
// proxy would.
const auth = (body) => fetch(`${BASE}/gate/auth`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-forwarded-proto': 'http' }, body: JSON.stringify(body) })
const cookieOf = (r) => (r.headers.get('set-cookie') || '').match(/luke_gate=([^;]+)/)?.[1]
const payloadOf = (tok) => JSON.parse(Buffer.from(tok.split('.')[0], 'base64url').toString())
const verify = (cookie) => fetch(`${BASE}/gate/verify`, { redirect: 'manual', headers: cookie ? { cookie: `luke_gate=${cookie}` } : {} })

// --- boot the real service ------------------------------------------------
const child = spawn(process.execPath, ['luke-service.mjs'], {
  cwd: new URL('.', import.meta.url).pathname,
  env: {
    ...process.env,
    LUKE_PORT: String(PORT),
    LUKE_NSEC: Buffer.from(generateSecretKey()).toString('hex'),
    LUKE_MASTER_NPUB: nip19.npubEncode(MASTER_PK),
    GATE_SECRET: 'gate-test-secret',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
})
let logs = ''
child.stdout.on('data', d => { logs += d })
child.stderr.on('data', d => { logs += d })
for (let i = 0; ; i++) {
  try { if ((await fetch(`${BASE}/health`)).ok) break } catch { /* not up yet */ }
  if (i > 100) { console.error('service never came up\n' + logs); process.exit(1) }
  await new Promise(r => setTimeout(r, 100))
}

try {
  // --- the login page + its same-origin modules ---------------------------
  await t('login page offers all three transports, modules same-origin', async () => {
    const html = await (await fetch(`${BASE}/gate/login`)).text()
    for (const bit of ['window.nostr', 'bunker://', 'Advanced: sign directly with a local key',
      '/gate/vendor/nave-connect.mjs', '"nostr-tools":"/gate/vendor/nostr-tools.mjs"',
      '"nostr-tools/nip46":"/gate/vendor/nostr-tools-nip46.mjs"']) {
      assert.ok(html.includes(bit), `login page must include ${bit}`)
    }
    assert.ok(!/https?:\/\/(cdn|unpkg|jsdelivr|esm\.sh)/.test(html), 'no CDN scripts on the login page')
  })

  await t('vendor route serves the allowlisted modules as JS', async () => {
    for (const f of ['nostr-tools.mjs', 'nostr-tools-nip46.mjs', 'nave-connect.mjs']) {
      const r = await fetch(`${BASE}/gate/vendor/${f}`)
      assert.equal(r.status, 200, `${f} serves`)
      assert.match(r.headers.get('content-type'), /text\/javascript/)
      assert.ok((await r.text()).length > 100)
    }
  })

  await t('vendor route refuses anything off the allowlist', async () => {
    for (const f of ['luke-service.mjs', 'secrets.enc.env', '..%2Fluke-service.mjs', '../luke-service.mjs', '']) {
      assert.equal((await fetch(`${BASE}/gate/vendor/${f}`)).status, 404, `${f || '(empty)'} must 404`)
    }
  })

  // --- the happy path, as each transport POSTs it -------------------------
  await t('master key admits; token records via; /gate/verify honors cookie', async () => {
    for (const via of ['nip07', 'nip46', 'local']) {
      const r = await auth({ event: challenge(MASTER_SK), via })
      assert.equal(r.status, 204, `via ${via} admits`)
      const tok = cookieOf(r)
      assert.ok(tok, 'cookie minted')
      const p = payloadOf(tok)
      assert.equal(p.pk, MASTER_PK)
      assert.equal(p.via, via, 'token carries the transport')
      assert.ok(p.exp > Math.floor(Date.now() / 1000), 'expiry in the future')
      assert.equal((await verify(tok)).status, 200, 'forward_auth passes')
    }
  })

  await t('legacy bare-event body still admits (via recorded as unknown)', async () => {
    const r = await auth(challenge(MASTER_SK))
    assert.equal(r.status, 204)
    assert.equal(payloadOf(cookieOf(r)).via, 'unknown')
  })

  await t('junk via value is sanitized, not trusted', async () => {
    const r = await auth({ event: challenge(MASTER_SK), via: 'root' })
    assert.equal(r.status, 204)
    assert.equal(payloadOf(cookieOf(r)).via, 'unknown')
  })

  await t('audit log line includes the transport', async () => {
    assert.match(logs, /✓ cockpit login — npub1\S+ via nip46/)
  })

  // --- verifyNip98: unchanged refusals, whatever the claimed via ----------
  await t('non-master key is refused — via never widens the admit set', async () => {
    for (const via of ['nip07', 'nip46', 'local']) {
      const r = await auth({ event: challenge(OTHER_SK), via })
      assert.equal(r.status, 403)
      assert.equal((await r.json()).why, 'not the master key')
    }
  })

  await t('stale timestamp refused', async () => {
    const r = await auth({ event: challenge(MASTER_SK, { age: 120 }), via: 'nip07' })
    assert.equal(r.status, 403)
    assert.equal((await r.json()).why, 'stale timestamp')
  })

  await t('url mismatch refused', async () => {
    const r = await auth({ event: challenge(MASTER_SK, { u: 'https://evil.example/gate/auth' }), via: 'nip07' })
    assert.equal(r.status, 403)
    assert.equal((await r.json()).why, 'url mismatch')
  })

  await t('method mismatch refused', async () => {
    const r = await auth({ event: challenge(MASTER_SK, { method: 'GET' }), via: 'nip07' })
    assert.equal(r.status, 403)
    assert.equal((await r.json()).why, 'method mismatch')
  })

  await t('wrong kind refused', async () => {
    const r = await auth({ event: challenge(MASTER_SK, { kind: 1 }), via: 'nip07' })
    assert.equal(r.status, 403)
    assert.equal((await r.json()).why, 'not a NIP-98 auth event')
  })

  await t('tampered signature refused', async () => {
    const evt = challenge(MASTER_SK)
    const r = await auth({ event: { ...evt, content: 'tampered' }, via: 'nip07' })
    assert.equal(r.status, 403)
    assert.equal((await r.json()).why, 'bad signature')
  })

  await t('replay refused', async () => {
    const evt = challenge(MASTER_SK)
    assert.equal((await auth({ event: evt, via: 'nip07' })).status, 204)
    const r = await auth({ event: evt, via: 'nip07' })
    assert.equal(r.status, 403)
    assert.equal((await r.json()).why, 'replay')
  })

  await t('bad json refused', async () => {
    const r = await fetch(`${BASE}/gate/auth`, { method: 'POST', body: 'not json' })
    assert.equal(r.status, 400)
  })

  // --- /gate/verify semantics untouched -----------------------------------
  await t('verify without cookie 302s to login', async () => {
    const r = await verify(null)
    assert.equal(r.status, 302)
    assert.equal(r.headers.get('location'), '/gate/login')
  })

  await t('verify with tampered cookie 302s to login', async () => {
    const good = cookieOf(await auth({ event: challenge(MASTER_SK), via: 'nip07' }))
    const [body] = good.split('.')
    const r = await verify(`${body}.AAAA`)
    assert.equal(r.status, 302)
  })
} finally {
  child.kill()
}

console.log(`\n${pass}/${n} passed`)
process.exit(pass === n ? 0 : 1)
