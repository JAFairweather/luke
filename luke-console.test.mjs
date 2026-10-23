// Console tests — a throwaway git workspace stands in for Luke's. Proves the
// manifest reports drift (changes made outside the console), that a save
// commits, that the retired TOOLS.md is gone from every session, and that the
// page's own script still parses.
import assert from 'node:assert'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { Readable } from 'node:stream'

const dir = mkdtempSync(join(tmpdir(), 'luke-console-'))
const sh = (...a) => execFileSync('git', ['-C', dir, ...a], { stdio: 'ignore' })
sh('init', '-q'); writeFileSync(join(dir, 'SOUL.md'), 'soul\n'); writeFileSync(join(dir, 'AGENTS.md'), 'agents\n')
sh('add', '.'); sh('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', 'seed')
writeFileSync(join(dir, 'AGENTS.md'), 'agents, edited by Luke\n')
writeFileSync(join(dir, 'BEATS.md.bak'), 'x\n')
writeFileSync(join(dir, 'SOUL.md.pre-console'), 'baseline\n')
const oc = mkdtempSync(join(tmpdir(), 'luke-oc-'))
writeFileSync(join(oc, 'openclaw.json'), JSON.stringify({ gateway: { bind: 'lan', auth: { trustedProxy: { deviceAutoApprove: { enabled: true } } } } }))
process.env.BRAIN_DIR = dir; process.env.OC_JSON = join(oc, 'openclaw.json')
const { handleConsole } = await import('./luke-console.mjs')

const ctx = { parseCookies: () => ({ luke_gate: 'ok' }), verifyToken: () => ({ pk: 'me' }), MASTER_PK: 'me' }
const call = async (method, url, body) => {
  const req = Readable.from(body ? [JSON.stringify(body)] : []); Object.assign(req, { method, url, headers: {} })
  const r = { code: 0, out: '', writeHead(c) { r.code = c; return r }, end(b) { r.out = b; return r } }
  await handleConsole(req, r, url, ctx); return r
}

let m = JSON.parse((await call('GET', '/console/api/manifest')).out)
assert.ok(m.drift.available)
assert.match(m.drift.last, /seed$/)
assert.deepEqual(m.drift.changes.map(c => c.path).sort(), ['AGENTS.md', 'BEATS.md.bak'], 'drift lists outside changes, not the .pre-console baseline')
assert.ok(!m.files.some(f => f.name === 'TOOLS.md'), 'TOOLS.md was folded into AGENTS.md in 10.x')
assert.ok(m.sessions.every(s => !s.base.includes('TOOLS.md')))
assert.ok(m.files.some(f => f.name === 'DREAMS.md' && !f.editable))
assert.equal(m.runtime.gateway.pairing, 'auto-approved at the gate')

const saved = JSON.parse((await call('POST', '/console/api/save', { name: 'SOUL.md', content: 'soul, edited\n' })).out)
assert.equal(saved.committed, true, 'a console save commits')
const { statSync: st } = await import('node:fs')
const ref = execFileSync('git', ['-C', dir, 'symbolic-ref', 'HEAD'], { encoding: 'utf8' }).trim()
assert.equal(st(join(dir, '.git', ref)).uid, st(dir).uid, 'the commit is written as the workspace owner')
assert.equal((await call('POST', '/console/api/save', { name: 'DREAMS.md', content: 'x' })).code, 400, 'DREAMS.md is read-only')

const html = (await call('GET', '/')).out
const script = html.match(/<script>([\s\S]*?)<\/script>/)[1]
assert.doesNotThrow(() => new Function(script), 'the page script parses')
assert.match(html, /id="drift"/)

rmSync(dir, { recursive: true, force: true }); rmSync(oc, { recursive: true, force: true })
console.log('✓ console: drift shown, saves commit, TOOLS.md retired, DREAMS.md read-only, page script parses')
