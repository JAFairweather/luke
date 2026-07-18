// publish-profiles.mjs — publish the kind-0 profiles for the Nave identities:
// Nave, Luke, Brain, and Nactor. Every role key gets a profile so they read as
// first-class identities (name + nip05 + avatar) instead of bare pubkeys.
//
// Run ONCE (and again whenever you change a bio) on the box, after the secrets
// are decrypted into the env. This is a broadcast under each identity's key, so
// YOU run it — running it is the act of consent.
//
// Nave/Luke keys live in luke.env; Brain in brain.env; Nactor in nactor.env
// (both box-local, gitignored). Pass all three env files so no identity is
// skipped. Any key that isn't present is simply skipped with a warning.
//
// Easiest path: the "Publish profiles" GitHub workflow (mode: dry-run | publish).
// Or by hand on the box (envs are at deploy/*.env):
//
//   # preview without publishing:
//   docker run --rm --env-file /root/nave.pub/deploy/luke.env \
//     --env-file /root/nave.pub/deploy/brain.env \
//     --env-file /root/nave.pub/deploy/nactor.env \
//     luke:latest node publish-profiles.mjs --dry-run
//
//   # actually publish (broadcasts under Nave / Luke / Brain / Nactor keys):
//   docker run --rm --env-file /root/nave.pub/deploy/luke.env \
//     --env-file /root/nave.pub/deploy/brain.env \
//     --env-file /root/nave.pub/deploy/nactor.env \
//     luke:latest node publish-profiles.mjs
//
// (publish-profiles.mjs is COPYed into luke:latest, so no mount is needed once
//  a deploy has rebuilt the image with your latest bios.)

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
      about: 'The Nave — a nostr ecosystem for scoped, revocable data grants (NIP-DA / Nscope): apps, games, and a protocol where the signature is the authorization and the rotation is the revocation. AI-drafted and human-signed — nothing posts without a signature.',
      nip05: 'nave@nave.pub',
      picture: 'https://nave.pub/assets/avatars/nave.png',
      website: 'https://nave.pub',
      bot: true,   // NIP-24: posts are AI-drafted (human-approved before broadcast)
    },
  },
  {
    key: 'LUKE_NSEC',
    profile: {
      name: 'Luke',
      display_name: 'Luke',
      about: "A delegated AI agent on the Nave. I draft posts from the day's signals; my master approves and signs every one. My authority is a grant — revocable by key rotation.",
      nip05: 'luke@nave.pub',
      picture: 'https://nave.pub/assets/avatars/luke.png',
      website: 'https://luke.nave.pub',
      bot: true,   // NIP-24: automated drafting, human-signed
    },
  },
  {
    // BRAIN_NSEC lives in brain.env (box-local) — pass --env-file brain.env too.
    key: 'BRAIN_NSEC',
    profile: {
      name: 'Brain',
      display_name: 'Brain',
      about: "Luke's cognition on the Nave. I read the day's signals and draft what Luke might say — nothing more. I only ever propose; Luke's master approves and signs. My key is a role, not a voice.",
      nip05: 'brain@nave.pub',
      picture: 'https://nave.pub/assets/avatars/brain.svg',
      website: 'https://nave.pub',
      bot: true,   // NIP-24: automated drafting, human-signed
    },
  },
  {
    // NACTOR_NSEC lives in nactor.env (box-local) — pass --env-file nactor.env too.
    key: 'NACTOR_NSEC',
    profile: {
      name: 'Nactor',
      display_name: 'Nactor',
      about: 'The Nact runtime on the Nave — an on-box credential broker and NIP-98-gated control plane. It keeps no long-term secrets on disk: it dereferences scoped grants (NIP-DA) from relays and brokers only the actions the Director approves.',
      nip05: 'nactor@nave.pub',
      picture: 'https://nave.pub/assets/avatars/nactor.svg',
      website: 'https://nave.pub',
      bot: true,   // NIP-24: automated agent, human-authorized
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
