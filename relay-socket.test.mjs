// node relay-socket.test.mjs — a relay that refuses, and one that accepts the connection and never answers,
// must each cost only that relay. Real nostr-tools pool, real sockets on 127.0.0.1, no outside network.
// Each case runs in a child process, because the failure being tested is the process dying.
import assert from 'node:assert'
import net from 'node:net'
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const here = fileURLToPath(new URL('.', import.meta.url))
const child = (impl, target) => spawnSync(process.execPath, ['--input-type=module', '-e', `
  import { SimplePool } from 'nostr-tools/pool'
  import WS from 'ws'
  import { RelaySocket } from './relay-socket.mjs'
  const impl = { plain: WS, builtin: globalThis.WebSocket, safe: RelaySocket }[${JSON.stringify(impl)}]
  const pool = new SimplePool({ websocketImplementation: impl })
  pool.subscribeMany([${JSON.stringify(target)}], { kinds: [1], limit: 1 }, { onevent() {} })
  const r = await Promise.allSettled(pool.publish([${JSON.stringify(target)}], { id: 'x' }))
  const q = await pool.querySync([${JSON.stringify(target)}], { kinds: [1], limit: 1 }, { maxWait: 800 })
  await new Promise(r => setTimeout(r, 1500))            // let late socket errors land
  console.log('SURVIVED ' + r[0].status + ' ' + q.length)
  process.exit(0)
`], { cwd: here, encoding: 'utf8', timeout: 60000 })

// a relay that accepts TCP and never speaks: the connect times out inside nostr-tools
const silent = net.createServer(() => {})
await new Promise(r => silent.listen(0, '127.0.0.1', r))
const SILENT = `ws://127.0.0.1:${silent.address().port}`
// a relay that refuses: a port nothing listens on
const probe = net.createServer(); await new Promise(r => probe.listen(0, '127.0.0.1', r))
const REFUSED = `ws://127.0.0.1:${probe.address().port}`; await new Promise(r => probe.close(r))

let n = 0
for (const [name, target] of [['refused', REFUSED], ['silent', SILENT]]) {
  const r = child('safe', target)
  assert.equal(r.status, 0, `RelaySocket, ${name} relay: the process must survive\n${(r.stderr || '').slice(-400)}`)
  assert.match(r.stdout, /SURVIVED (rejected|fulfilled) 0/, `${name}: publish settles, query returns nothing`)
  console.log(`ok - RelaySocket survives a ${name} relay`); n++
}
// The faults this guards against are real with the library in use; if a nostr-tools or Node update fixes one,
// that line is reported, not failed. (The guard stays: nostr-tools is not pinned and the image rebuilds.)
for (const [impl, target, what] of [['plain', SILENT, 'ws + silent relay'], ['builtin', REFUSED, 'built-in WebSocket + refused relay']]) {
  const r = child(impl, target)
  console.log(`${r.status === 0 ? 'note' : 'ok'} - without the guard, ${what}: ${r.status === 0 ? 'survived (this nostr-tools or Node does not have the fault)' : 'the process dies'}`)
}
silent.close()

// every pool the image runs uses it
for (const f of ['luke-brain.mjs', 'jaf-scribe.mjs', 'nact-resolve.mjs', 'luke-poster.mjs', 'publish-profiles.mjs']) {
  const src = readFileSync(new URL('./' + f, import.meta.url), 'utf8')
  const pools = src.match(/new SimplePool\([^)]*\)/g) || []
  assert.ok(pools.length > 0, `${f} opens a pool`)
  for (const p of pools) assert.equal(p, 'new SimplePool({ websocketImplementation: RelaySocket })', `${f}: ${p}`)
  assert.match(src, /import \{ RelaySocket \} from '\.\/relay-socket\.mjs'/, `${f} imports RelaySocket`)
  n++
}
assert.match(readFileSync(new URL('./Dockerfile', import.meta.url), 'utf8'), /^COPY relay-socket\.mjs \.\/$/m, 'the image ships it')
console.log(`relay-socket.test.mjs: ${n + 1} checks pass`)
