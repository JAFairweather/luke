#!/usr/bin/env node
// Luke as a herdr agent. Run inside a herdr pane: the pane shows OpenClaw's own
// terminal UI (`openclaw tui`, over ssh to the fleet), and this process reads
// the TUI's status line ("connected | idle") and reports idle/working
// to herdr, so Luke shows under Agents and `herdr agent prompt luke …` works.
// When a turn ends it also alerts the Moshi inbox (`moshi-hook notify`), since
// Moshi has no OpenClaw hook of its own: "finished" after a turn of at least
// LUKE_MOSHI_MIN_S seconds (default 10), "hit an error" always. LUKE_MOSHI=0 turns it off.
// Holds no keys — the only credential in play is your ssh login. A dropped link
// (the fleet closing ssh, a network blip) reconnects; quitting the TUI ends the pane.
import { spawn, execFile, execFileSync } from 'node:child_process'
import { connect } from 'node:net'
import { fileURLToPath } from 'node:url'

// The TUI's activity words (OpenClaw 2026.10 setActivityStatus) → herdr states.
const IDLE = ['idle', 'aborted', 'error', 'abort failed']
const WORKING = ['sending', 'running', 'streaming', 'waiting', 'finishing context', 'starting up']

// At rest the line is "connected | idle" ("gateway connected" for the first 4s);
// while busy it is a spinner line "⠋ streaming • 4s | connected", or a shimmer
// phrase in place of the word when waiting.
const CONN = '(?:gateway )?(?:re)?connected|disconnected'
const REST = new RegExp(`^\\s*(${CONN}) \\| ([a-z ]+?)\\s*$`)
const BUSY = new RegExp(`• \\d+(?:m \\d+)?s \\| (${CONN})\\s*$`)
const isConnected = c => c !== 'disconnected'

// The herdr state and the TUI's activity word ('' on the busy spinner line).
export function activityFromScreen(text) {
  const lines = String(text).split('\n').filter(l => REST.test(l) || BUSY.test(l))
  const last = lines.at(-1) ?? ''
  const busy = last.match(BUSY)
  if (busy) return { state: isConnected(busy[1]) ? 'working' : 'unknown', word: '' }
  const m = last.match(REST)
  if (!m || !isConnected(m[1])) return { state: 'unknown', word: '' }
  const word = m[2]
  return { state: IDLE.includes(word) ? 'idle' : WORKING.includes(word) ? 'working' : 'unknown', word }
}

export const stateFromScreen = text => activityFromScreen(text).state

const duration = ms => { const s = Math.round(ms / 1000); return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s` }

// The Moshi alert for a change of state, or null. Only the end of a turn alerts: an error always, a
// finished turn once it ran minMs, and never a turn the owner aborted.
export function moshiAlert({ from, to, word, workedMs, minMs = 10000, name = 'Luke' }) {
  if (from !== 'working' || to !== 'idle' || word === 'aborted') return null
  if (word === 'error' || word === 'abort failed') return { title: `${name} hit an error`, message: `after ${duration(workedMs)} (${word})`, error: true }
  if (workedMs < minMs) return null
  return { title: `${name} finished`, message: `worked for ${duration(workedMs)}`, error: false }
}

// After the TUI's ssh exits: null to stop (a clean quit, or Ctrl-C), else ms to wait before reconnecting —
// 2s doubling to a minute, back to 2s once a session has lasted a minute.
export function reconnectDelay(code, ranMs, prev = 0) {
  if (code === 0 || code === 130) return null
  return ranMs >= 60000 || !prev ? 2000 : Math.min(prev * 2, 60000)
}

function herdrCall(sock, method, params) {
  return new Promise(resolve => {
    const c = connect(sock, () => c.end(JSON.stringify({ id: `luke-herdr:${Date.now()}`, method, params }) + '\n'))
    c.on('data', () => c.destroy()).on('error', () => resolve(false)).on('close', () => resolve(true))
    c.setTimeout(1000, () => c.destroy())
  })
}

async function main() {
  const pane = process.env.HERDR_PANE_ID, sock = process.env.HERDR_SOCKET_PATH
  if (!pane || !sock) { console.error('luke-herdr: run this inside a herdr pane'); process.exit(2) }
  const host = process.env.LUKE_HOST || 'nvoy-fleet'
  const name = process.env.LUKE_HERDR_NAME || 'luke'
  const id = { pane_id: pane, source: 'luke-herdr', agent: 'openclaw' }

  const moshi = process.env.LUKE_MOSHI !== '0'
  const minMs = 1000 * Number(process.env.LUKE_MOSHI_MIN_S || 10)
  // Best effort, never blocking the loop: no moshi-hook, or Moshi unreachable, just means no alert.
  const alert = ({ title, message, error }) => execFile('moshi-hook',
    ['notify', '--source', name.toLowerCase().replace(/[^a-z0-9._-]/g, '-'), '--label', name, '--title', title, ...(error ? ['--error'] : []), message],
    { timeout: 15000 }, () => {})

  let last = null, named = false, workingSince = 0
  const tick = async () => {
    let screen = ''
    try { screen = execFileSync('herdr', ['pane', 'read', pane, '--source', 'detection', '--lines', '8'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }) } catch {}
    const { state, word } = activityFromScreen(screen)
    if (state === last) return
    if (state === 'working') workingSince = Date.now()
    const note = moshi && moshiAlert({ from: last, to: state, word, workedMs: Date.now() - workingSince, minMs, name })
    if (note) alert(note)
    last = state
    await herdrCall(sock, 'pane.report_agent', { ...id, state, seq: Date.now() })
    if (!named) { try { execFileSync('herdr', ['agent', 'rename', pane, name], { stdio: 'ignore' }); named = true } catch {} }
  }
  const iv = setInterval(tick, 1000)

  let wait = 0
  const run = () => {
    const began = Date.now()
    const tui = spawn('ssh', ['-t', '-o', 'ServerAliveInterval=30', '-o', 'ServerAliveCountMax=3', host,
      'docker exec -it -u 1000 deploy-openclaw-1 openclaw tui'], { stdio: 'inherit' })
    tui.on('exit', async code => {
      wait = reconnectDelay(code, Date.now() - began, wait)
      if (wait !== null) {
        console.error(`\nluke-herdr: the link to ${host} dropped (exit ${code}); reconnecting in ${wait / 1000}s — Ctrl-C to stop`)
        return setTimeout(run, wait)
      }
      clearInterval(iv)
      await herdrCall(sock, 'pane.release_agent', id)
      process.exit(code ?? 0)
    })
  }
  run()
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main()
