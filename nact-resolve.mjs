// nact-resolve — AD-2 client half: address Nactor by IDENTITY, not a URL.
//
// The Nactor advertises its endpoint on boot under its own key (nact repo,
// endpoint-advert.mjs): a kind-31990 NIP-89 handler with `d=nactor` and a
// ['web', <endpoint>, 'nactor'] tag (endpoint also mirrored in content.web),
// plus a kind-10002 relay list. This resolves WHERE from WHO: given the
// Nactor's identity (npub or nactor@nave.pub), it reads that advert off the
// relays and returns the endpoint — so moving the box is a republish, not a
// client reconfig.
//
// Non-breaking by design: callers pass a `fallback` (their existing
// NACT_BROKER_URL). On-box callers keep using the fast internal URL; off-box
// callers that only know the identity discover the public endpoint here.
import { nip19 } from 'nostr-tools'
import { SimplePool } from 'nostr-tools/pool'

const DEFAULT_RELAYS = ['wss://relay.damus.io', 'wss://nos.lol', 'wss://relay.primal.net']
const TTL_MS = 10 * 60 * 1000
const cache = new Map()  // identity -> { endpoint, at }

export function _resetCache() { cache.clear() }

// Pull the advertised endpoint out of a kind-31990 handler event.
export function endpointFromEvent(ev) {
  if (!ev) return null
  const web = (ev.tags || []).find(t => t[0] === 'web' && t[1])
  if (web) return web[1]
  try { const c = JSON.parse(ev.content || '{}'); if (c.web) return c.web } catch {}
  return null
}

function toHex(identity) {
  if (/^[0-9a-f]{64}$/i.test(identity)) return identity.toLowerCase()
  if (identity.startsWith('npub1')) { try { return nip19.decode(identity).data } catch { return null } }
  return null
}

async function nip05ToHex(identity, fetchImpl) {
  const [name, domain] = identity.split('@')
  if (!name || !domain) return null
  const r = await fetchImpl(`https://${domain}/.well-known/nostr.json?name=${encodeURIComponent(name)}`)
  const j = await r.json().catch(() => ({}))
  return j?.names?.[name] || null
}

// Resolve the Nactor HTTP endpoint from its identity. Returns `fallback` if
// identity is unset, unresolvable, or not yet advertised — never throws.
export async function resolveNactEndpoint({
  identity, relays, fallback = null, timeoutMs = 6000, now = Date.now(),
  pool, fetchImpl = fetch,
} = {}) {
  if (!identity) return fallback
  const hit = cache.get(identity)
  if (hit && now - hit.at < TTL_MS) return hit.endpoint || fallback

  let hex = toHex(identity)
  if (!hex && identity.includes('@')) { try { hex = await nip05ToHex(identity, fetchImpl) } catch {} }
  if (!hex) return fallback

  const useRelays = relays?.length ? relays : DEFAULT_RELAYS
  const ownPool = pool || new SimplePool()
  let endpoint = null
  try {
    const ev = await Promise.race([
      ownPool.get(useRelays, { kinds: [31990], authors: [hex], '#d': ['nactor'] }),
      new Promise(res => setTimeout(() => res(null), timeoutMs)),
    ])
    endpoint = endpointFromEvent(ev)
  } catch { /* resolution is best-effort; fall back */ }
  finally { if (!pool) { try { ownPool.close(useRelays) } catch {} } }

  cache.set(identity, { endpoint, at: now })
  return endpoint || fallback
}
