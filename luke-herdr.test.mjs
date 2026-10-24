// herdr state test — the TUI's status line, as rendered by OpenClaw 2026.10.6
// (tui setConnectionStatus / updateBusyStatusMessage), maps to herdr states.
import assert from 'node:assert'
import { stateFromScreen, reconnectDelay } from './luke-herdr.mjs'

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
