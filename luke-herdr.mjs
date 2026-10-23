#!/usr/bin/env node
// Luke as a herdr agent. Run inside a herdr pane: the pane shows OpenClaw's own
// terminal UI (`openclaw tui`, over ssh to the fleet), and this process reads
// the TUI's status line ("gateway connected | idle") and reports idle/working
// to herdr, so Luke shows under Agents and `herdr agent prompt luke …` works.
// Holds no keys — the only credential in play is your ssh login.
import { spawn, execFileSync } from 'node:child_process'
import { connect } from 'node:net'
import { fileURLToPath } from 'node:url'

// The TUI's activity words (OpenClaw 2026.10 setActivityStatus) → herdr states.
const IDLE = ['idle', 'aborted', 'error', 'abort failed']
const WORKING = ['sending', 'running', 'streaming', 'waiting', 'finishing context', 'starting up']

export function stateFromScreen(text) {
  const lines = String(text).split('\n').filter(l => /\bgateway \w+ \| /.test(l))
  const m = lines.at(-1)?.match(/\bgateway (\w+) \| ([a-z ]+?)\s*$/)
  if (!m || m[1] !== 'connected') return 'unknown'
  if (IDLE.includes(m[2])) return 'idle'
  if (WORKING.includes(m[2])) return 'working'
  return 'unknown'
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

  let last = null, named = false
  const tick = async () => {
    let screen = ''
    try { screen = execFileSync('herdr', ['pane', 'read', pane, '--source', 'detection', '--lines', '8'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }) } catch {}
    const state = stateFromScreen(screen)
    if (state === last) return
    last = state
    await herdrCall(sock, 'pane.report_agent', { ...id, state, seq: Date.now() })
    if (!named) { try { execFileSync('herdr', ['agent', 'rename', pane, name], { stdio: 'ignore' }); named = true } catch {} }
  }
  const iv = setInterval(tick, 1000)

  const tui = spawn('ssh', ['-t', host, 'docker exec -it -u 1000 deploy-openclaw-1 openclaw tui'], { stdio: 'inherit' })
  tui.on('exit', async code => {
    clearInterval(iv)
    await herdrCall(sock, 'pane.release_agent', id)
    process.exit(code ?? 0)
  })
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main()
