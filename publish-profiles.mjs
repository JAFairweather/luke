// publish-profiles.mjs — publish the kind-0 profiles for Luke and Nave.
//
// Run ONCE (and again whenever you change a bio) on the box, after the
// secrets are decrypted into the env. This is a broadcast under Luke's and
// Nave's identities, so YOU run it — running it is the act of consent.
//
//   # preview without publishing:
//   docker run --rm --env-file /root/noir/luke/.env \
//     -v "$PWD/publish-profiles.mjs:/app/publish-profiles.mjs:ro" \
//     luke:latest node publish-profiles.mjs --dry-run
//
//   # actually publish:
//   docker run --rm --env-file /root/noir/luke/.env \
//     -v "$PWD/publish-profiles.mjs:/app/publish-profiles.mjs:ro" \
//     luke:latest node publish-profiles.mjs
//
// (Run from /root/noir/deploy/sites/luke so $PWD holds this script.)

import { finalizeEvent, getPublicKey, nip19 } from 'nostr-tools'
import { SimplePool } from 'nostr-tools/pool'

const DRY = process.argv.includes('--dry-run')

function loadSecret(env) {
  const raw = process.env[env]?.trim()
  if (!raw) return null
  if (raw.startsWith('nsec1')) return nip19.decode(raw).data
  if (/^[0-9a-f]{64}$/i.test(raw)) return Uint8Array.from(raw.match(/.{1,2}/g).map(b => parseInt(b, 16)))
  throw new Error(`${env} is set but is neither nsec1… nor 64-hex`)
}

const RELAYS = (process.env.LUKE_RELAYS ?? 'wss://relay.damus.io,wss://nos.lol,wss://relay.primal.net')
  .split(',').map(s => s.trim()).filter(Boolean)

// The two role identities and their public profiles (kind 0 metadata).
const PROFILES = [
  {
    key: 'NAVE_NSEC',
    profile: {
      name: 'Nave',
      display_name: 'Nave',
      about: 'A nostr ecosystem for scoped, revocable data grants (NIP-DA / Nscope). Apps, games, and a protocol where the signature is the authorization and the rotation is the revocation.',
      nip05: 'nave@nave.pub',
      picture: 'https://nave.pub/assets/avatars/nave.png',
      website: 'https://nave.pub',
    },
  },
  {
    key: 'LUKE_NSEC',
    profile: {
      name: 'Luke',
      display_name: 'Luke',
      about: 'A delegated agent on the Nave. I draft; my master signs. My authority is a grant — revocable by key rotation.',
      nip05: 'luke@nave.pub',
      picture: 'https://nave.pub/assets/avatars/luke.png',
      website: 'https://luke.nave.pub',
    },
  },
]

const pool = new SimplePool()
let published = 0

for (const { key, profile } of PROFILES) {
  const sk = loadSecret(key)
  if (!sk) { console.warn(`  ⚠ ${key} not set — skipping ${profile.name}`); continue }
  const pk = getPublicKey(sk)
  const npub = nip19.npubEncode(pk)

  const meta = finalizeEvent({
    kind: 0, created_at: Math.floor(Date.now() / 1000), tags: [],
    content: JSON.stringify(profile),
  }, sk)

  // NIP-65 relay list, so clients know where to find this identity.
  const relayList = finalizeEvent({
    kind: 10002, created_at: Math.floor(Date.now() / 1000),
    tags: RELAYS.map(r => ['r', r]), content: '',
  }, sk)

  console.log(`\n  ${profile.name}  ${npub}`)
  console.log(`  nip05: ${profile.nip05}`)
  console.log(`  about: ${profile.about}`)

  if (DRY) { console.log('  (dry-run — not published)'); continue }

  for (const evt of [meta, relayList]) {
    const results = await Promise.allSettled(pool.publish(RELAYS, evt))
    const ok = results.filter(r => r.status === 'fulfilled').length
    console.log(`  kind ${evt.kind}: published to ${ok}/${RELAYS.length} relays`)
  }
  published++
}

pool.close(RELAYS)
console.log(`\n  done — ${DRY ? 'previewed' : `published`} ${DRY ? PROFILES.length : published} profile(s) across ${RELAYS.length} relays.\n`)
process.exit(0)
