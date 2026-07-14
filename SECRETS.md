# Luke's secrets — SOPS + age

Luke's secrets are **encrypted in the repo** with [SOPS](https://github.com/getsops/sops)
and [age](https://github.com/FiloSottile/age). The encrypted file
(`secrets.enc.env`) is committed; the plaintext never is. Only the box —
which holds the age private key — can decrypt it. This is strictly better
than a gitignored plaintext `.env`: the secrets are versioned, survive a
box rebuild, and can't be leaked by a stray `git add`.

## The custody boundary (read this first)

| Identity | Handle | Key custody |
|---|---|---|
| **You (sovereign)** | `jaf@dequalsf.com` | nsec in YOUR pocket — **never on the box.** Only the npub is published (NIP-05 on dequalsf.com). |
| **Nave** (project voice) | `nave@nave.pub` | `NAVE_NSEC` — custodial, encrypted on the box. |
| **Luke** (the agent) | `luke@nave.pub` | `LUKE_NSEC` — custodial, encrypted on the box. |

Role keys (Luke, Nave) live encrypted on the box so Luke can sign
Telegram-approved posts with one tap. Your sovereign key does not — it
signs only when *you* sign, in your own signer. Box compromise exposes the
role identities, never `jaf@`.

## One-time setup (on the box)

```bash
# 1. Install tools (Debian/Ubuntu)
apt-get update && apt-get install -y age
curl -Lo /usr/local/bin/sops \
  https://github.com/getsops/sops/releases/latest/download/sops-v3.9.0.linux.amd64
chmod +x /usr/local/bin/sops

# 2. Generate the age key (private stays here; public goes in .sops.yaml)
mkdir -p ~/.config/sops/age
age-keygen -o ~/.config/sops/age/keys.txt
#   → prints "Public key: age1…"  ← copy that

# 3. Put the public key in .sops.yaml (replace the placeholder), commit it.
```

## Filling in the secrets (on the box, once)

```bash
cd /root/<platform>/deploy/sites/luke      # the cloned luke repo on the box

cp .env.example secrets.env                # plaintext — gitignored

# Generate the two ROLE keys ON THE BOX (never in chat):
node -e 'import("nostr-tools").then(t=>{const sk=t.generateSecretKey();console.log("LUKE_NSEC",t.nip19.nsecEncode(sk),"npub",t.nip19.npubEncode(t.getPublicKey(sk)))})'
node -e 'import("nostr-tools").then(t=>{const sk=t.generateSecretKey();console.log("NAVE_NSEC",t.nip19.nsecEncode(sk),"npub",t.nip19.npubEncode(t.getPublicKey(sk)))})'
# paste each nsec into secrets.env; keep the npubs — they go in nostr.json.

# Fill in the rest: LUKE_MASTER_NPUB (your npub), TELEGRAM_BOT_TOKEN,
# TELEGRAM_APPROVER_ID, OPENCLAW_GATEWAY_TOKEN.

# Encrypt → commit the CIPHERTEXT, destroy the plaintext:
sops --input-type dotenv --output-type dotenv -e secrets.env > secrets.enc.env
git add secrets.enc.env && git commit -m "Add encrypted Luke secrets"
shred -u secrets.env
```

## Editing a secret later

```bash
sops secrets.enc.env        # opens decrypted in $EDITOR, re-encrypts on save
git add secrets.enc.env && git commit -m "Rotate <thing>"
```

## How the box decrypts at deploy time

`deploy/sites.sh` decrypts the committed ciphertext into the plaintext env
the compose reads (`../luke/.env`), using the box's age key. It's guarded —
if SOPS or the encrypted file isn't set up yet, it's a no-op and the rest
of the stack still comes up:

```bash
if [ -f sites/luke/secrets.enc.env ] && command -v sops >/dev/null; then
  sops --input-type dotenv --output-type dotenv -d sites/luke/secrets.enc.env > ../luke/.env
fi
```

The decrypted `../luke/.env` is gitignored and root-only; it's regenerated
on every deploy from the encrypted source of truth.

## Rotating a role key

Because these are custodial role keys, rotation = generate a new nsec,
update `secrets.enc.env`, and repoint the handle in `nostr.json`. (Your
sovereign `jaf@` key is never here, so it's never part of this.)
