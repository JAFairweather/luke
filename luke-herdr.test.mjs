// herdr state test — the TUI's status line, as rendered by OpenClaw 2026.10.6
// (tui setConnectionStatus / updateBusyStatusMessage), maps to herdr states.
import assert from 'node:assert'
import { stateFromScreen, activityFromScreen, moshiAlert, turnTracker, reconnectDelay } from './luke-herdr.mjs'

const screen = s => `are we calling it here?\n ${s}\n agent main (Luke) | session main | gemini-3.1-pro-preview medium | tokens 20k/200k\n`

assert.equal(stateFromScreen(screen('connected | idle')), 'idle')
assert.equal(stateFromScreen(screen('connected | streaming')), 'working')
assert.equal(stateFromScreen(screen('connected | finishing context')), 'working')
assert.equal(stateFromScreen(screen('connected | aborted')), 'idle')
assert.equal(stateFromScreen(screen('disconnected | idle')), 'unknown', 'no gateway, no claim')
assert.equal(stateFromScreen(screen('connected | something new')), 'unknown')
assert.equal(stateFromScreen(''), 'unknown')
// For 4s after (re)connecting the word carries a "gateway" prefix.
assert.equal(stateFromScreen(screen('gateway connected | idle')), 'idle')
assert.equal(stateFromScreen(screen('gateway reconnected | idle')), 'idle')
assert.equal(stateFromScreen(screen('⠋ sending • 0s | gateway connected')), 'working')
// While busy the TUI swaps to a spinner line with the connection after the pipe.
const busy = s => `are we calling it here?\n ${s}\n agent main (Luke) | session main | gemini-3.1-pro-preview medium | tokens 20k/200k\n`
assert.equal(stateFromScreen(busy('⠋ streaming • 4s | connected')), 'working')
assert.equal(stateFromScreen(busy('⠙ running • 1m 12s | connected')), 'working')
assert.equal(stateFromScreen(busy('⠹ pondering… • 12s | connected')), 'working', 'waiting shows a phrase')
assert.equal(stateFromScreen(busy('⠋ streaming • 4s | disconnected')), 'unknown')
assert.equal(stateFromScreen(busy('⠋ streaming • 4s | connected') + screen('connected | idle')), 'idle')
// Luke's own reply quoting the status words must not count — only the last status line does.
assert.equal(stateFromScreen(` connected | streaming\n` + screen('connected | idle')), 'idle')

// A dropped link reconnects with backoff; a clean quit or Ctrl-C ends the pane.
assert.equal(reconnectDelay(0, 5000), null)
assert.equal(reconnectDelay(130, 5000), null)
assert.equal(reconnectDelay(255, 5000), 2000, 'ssh: closed by remote host')
assert.equal(reconnectDelay(255, 5000, 2000), 4000)
assert.equal(reconnectDelay(255, 5000, 60000), 60000, 'capped at a minute')
assert.equal(reconnectDelay(255, 3600000, 32000), 2000, 'a long session resets the backoff')

console.log('✓ the TUI status line maps to herdr idle/working, and anything unclear is unknown')

// The activity word rides along, so a turn's end can be told apart.
assert.deepEqual(activityFromScreen(screen('connected | error')), { state: 'idle', word: 'error' })
assert.deepEqual(activityFromScreen(busy('⠋ streaming • 4s | connected')), { state: 'working', word: '' })

// Moshi alerts only at the end of a turn: an error always, a finished turn once it ran 10s, an abort never.
const end = (word, workedMs) => moshiAlert({ from: 'working', to: 'idle', word, workedMs, name: 'lukedog' })
assert.deepEqual(end('idle', 75000), { title: 'lukedog finished', message: 'worked for 1m 15s', error: false })
assert.equal(end('idle', 4000), null, 'a short turn is not worth a push')
assert.deepEqual(end('error', 3000), { title: 'lukedog hit an error', message: 'after 3s (error)', error: true })
assert.equal(end('aborted', 60000), null, 'the owner stopped it; no alert')
assert.equal(moshiAlert({ from: null, to: 'idle', word: 'idle', workedMs: 0 }), null, 'first sight is not an ending')
assert.equal(moshiAlert({ from: 'idle', to: 'working', word: '', workedMs: 0 }), null)
assert.equal(moshiAlert({ from: 'working', to: 'unknown', word: '', workedMs: 60000 }), null, 'a dropped link is not a finish')
console.log('✓ a turn that ends alerts Moshi: finished after 10s or more, errors always, aborts never')

// Across a session's life: only a turn that began after this session showed idle can alert.
let clock = 0
const tracked = () => turnTracker({ name: 'lukedog', now: () => clock })
const see = (tr, text) => { const { state, word } = activityFromScreen(text); return tr.observe(state, word) }
const STALE = busy('⠋ streaming • 20s | connected'), IDLE_LINE = screen('connected | idle')
{
  const tr = tracked()
  clock = 0; assert.equal(see(tr, IDLE_LINE), null)
  clock = 1000; assert.equal(see(tr, STALE), null)
  clock = 61000; assert.deepEqual(see(tr, IDLE_LINE), { title: 'lukedog finished', message: 'worked for 1m 0s', error: false }, 'a real turn alerts')
}
{
  // The link drops mid-turn; during backoff and after reconnecting the old busy line is still on screen.
  const tr = tracked()
  clock = 0; see(tr, IDLE_LINE); clock = 1000; see(tr, STALE)
  tr.reset()
  clock = 30000; assert.equal(see(tr, STALE), null, 'stale busy line after the drop')
  clock = 45000; assert.equal(see(tr, IDLE_LINE), null, 'the reconnected TUI showing idle is not a finished turn')
  clock = 50000; see(tr, STALE)
  clock = 80000; assert.deepEqual(see(tr, IDLE_LINE), { title: 'lukedog finished', message: 'worked for 30s', error: false }, 'the next real turn alerts again')
}
{
  // Started mid-turn (luke-herdr launched while Luke works): that turn is not counted.
  const tr = tracked()
  clock = 0; assert.equal(see(tr, STALE), null)
  clock = 60000; assert.equal(see(tr, IDLE_LINE), null)
}
console.log('✓ a dropped link or a fresh start never reports a finished turn it did not see begin')
