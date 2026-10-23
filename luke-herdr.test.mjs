// herdr state test — the TUI's status line, as captured from a live pane on
// 2026-10-23, maps to the states herdr understands.
import assert from 'node:assert'
import { stateFromScreen } from './luke-herdr.mjs'

const screen = s => `are we calling it here?\n gateway ${s}\n agent main (Luke) | session main | gemini-3.1-pro-preview medium | tokens 20k/200k\n`

assert.equal(stateFromScreen(screen('connected | idle')), 'idle')
assert.equal(stateFromScreen(screen('connected | streaming')), 'working')
assert.equal(stateFromScreen(screen('connected | finishing context')), 'working')
assert.equal(stateFromScreen(screen('connected | aborted')), 'idle')
assert.equal(stateFromScreen(screen('disconnected | idle')), 'unknown', 'no gateway, no claim')
assert.equal(stateFromScreen(screen('connected | something new')), 'unknown')
assert.equal(stateFromScreen(''), 'unknown')
// Luke's own reply quoting the status words must not count — only the last status line does.
assert.equal(stateFromScreen(`gateway connected | streaming\n` + screen('connected | idle')), 'idle')

console.log('✓ the TUI status line maps to herdr idle/working, and anything unclear is unknown')
