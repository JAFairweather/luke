// relay-socket.mjs: the WebSocket every relay pool here uses (SimplePool({ websocketImplementation: RelaySocket })).
//
// One relay that will not connect must cost that relay, not the whole run. Two ways it used to kill the process:
//   • `ws`: nostr-tools closes a socket that is still connecting (its connect timeout); ws then emits 'error'
//     ("WebSocket was closed before the connection was established") after nostr-tools has let go of the socket,
//     and an 'error' with no listener is thrown. The brain died this way on a relay that never answered.
//   • Node's built-in WebSocket: nostr-tools' onerror handler calls close(), close() raises the error event
//     again, and the two call each other until "Maximum call stack size exceeded". The scribe died this way.
// So: always one 'error' listener, and close() does not re-enter itself.
import WebSocket from 'ws'

export class RelaySocket extends WebSocket {
  #closing = false
  constructor(...args) {
    super(...args)
    this.on('error', () => {})
  }
  close(...args) {
    if (this.#closing) return
    this.#closing = true
    try { super.close(...args) } catch { /* already closed or never opened */ } finally { this.#closing = false }
  }
}
