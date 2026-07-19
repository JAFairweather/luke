// publish-warmcontact — publish warm.contact's kind-0 profile from the machine
// that HOLDS its key (James's Mac). Decrypt the nsec from SOPS into
// WARMCONTACT_NSEC first; the key never leaves the Mac and is never logged.
//
// Safety: aborts unless the key derives the expected npub, so a wrong SOPS
// decrypt can't broadcast under the wrong identity.
//
//   # in a dir with nostr-tools (this luke repo, or after `npm i nostr-tools`):
//   export WARMCONTACT_NSEC=$(sops -d --extract '["warmcontact_nsec"]' path/to/vault.enc.yaml)
//   node publish-warmcontact.mjs
//   unset WARMCONTACT_NSEC
import { finalizeEvent, getPublicKey, nip19 } from 'nostr-tools'
import { SimplePool } from 'nostr-tools/pool'

const EXPECT_HEX = 'f27075ff31ada8f433e5243622932424a42ef663cc6e321577413320746043d6'
const RELAYS = (process.env.NVOY_RELAYS || process.env.LUKE_RELAYS ||
  'wss://relay.damus.io,wss://nos.lol,wss://relay.primal.net')
  .split(',').map(s => s.trim()).filter(Boolean)

function loadNsec(raw) {
  raw = (raw || '').trim()
  if (!raw) { console.error('set WARMCONTACT_NSEC (decrypt it from SOPS first)'); process.exit(1) }
  if (raw.startsWith('nsec1')) return nip19.decode(raw).data
  if (/^[0-9a-f]{64}$/i.test(raw)) return Uint8Array.from(raw.match(/.{2}/g).map(b => parseInt(b, 16)))
  console.error('WARMCONTACT_NSEC must be nsec1… or 64-char hex'); process.exit(1)
}

const sk = loadNsec(process.env.WARMCONTACT_NSEC)
const pub = getPublicKey(sk)
if (pub !== EXPECT_HEX) {
  console.error(`refusing to publish: this key derives ${pub.slice(0, 12)}… but expected ` +
    `${EXPECT_HEX.slice(0, 12)}… — wrong key decrypted?`)
  process.exit(2)
}

// Edit freely before publishing — this is warm.contact's public profile.
const profile = {
  name: 'warm.contact',
  display_name: 'warm.contact',
  about: 'Private, encrypted address book — contacts that never go stale. A Nave-integrated app: ' +
    'holds its own key, reads its credentials as Director-signed grants (NIP-DA / Nscope), ' +
    'verb-scoped egress.',
  nip05: 'warm.contact@nave.pub',
  picture: 'https://nave.pub/assets/avatars/warmcontact.svg',
  website: 'https://warm.contact',
  bot: true,
}

const ev = finalizeEvent(
  { kind: 0, created_at: Math.floor(Date.now() / 1000), tags: [], content: JSON.stringify(profile) }, sk)
const pool = new SimplePool()
const results = await Promise.allSettled(pool.publish(RELAYS, ev))
const ok = results.filter(r => r.status === 'fulfilled').length
console.log(`published kind-0 for ${nip19.npubEncode(pub).slice(0, 18)}… (warm.contact) — ` +
  `${ok}/${RELAYS.length} relays; event ${ev.id.slice(0, 12)}…`)
console.log('verify: warm.contact@nave.pub should now show name + photo in any nostr client.')
try { pool.close(RELAYS) } catch {}
