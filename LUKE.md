# Luke — a delegated agent, not an exposed cockpit

Luke is your OpenClaw instance. The naïve move is to reverse-proxy the
OpenClaw Control UI straight onto `luke.nave.pub`. We don't, because that
UI is an **operator cockpit** for an agent that can act on your box —
publishing it at a public, brand-named, indexed address maximizes attack
surface on the most dangerous service you run. Instead we split Luke into
two planes, the same way the rest of the Nave separates public identity
from private authority.

```
                         luke.nave.pub
                              │
        ┌─────────────────────┴──────────────────────┐
        │                                             │
   PUBLIC PLANE                                 CONTROL PLANE
   Luke's card (/)                              the cockpit (/cockpit*)
   • his npub (identity)                        • the real OpenClaw UI
   • his mandate                                • can act on the box
   • delegation status (revocable)              • nostr-signed gate in front
   • /health JSON                               • only Luke's MASTER key passes
   read-only, safe to index                     then OpenClaw's own auth
        │                                             │
   luke-service.mjs  ◀── forward_auth /gate/verify ──▶ Caddy ──▶ OpenClaw :57419
```

## The two planes

### 1. The public plane — Luke as a delegated agent

`luke.nave.pub/` is Luke's **card**: his nostr identity (`npub`), his
mandate, and his delegation status — held under a **revocable grant** from
you (his master), exactly like the Noir Director holds its house. The
authority is a signature; the revocation is a key rotation. Nothing here
can *do* anything; it only *declares* what Luke is and who he answers to.
Safe to be public, safe to be indexed.

`GET /health` returns the same story as JSON (npub, master npub, mandate,
`delegation.revocable: true`, `cockpit: "nostr-gated"`).

### 2. The control plane — the cockpit, behind a nostr-signed gate

`luke.nave.pub/cockpit*` is the actual OpenClaw Control UI, reachable
**only after you prove you hold Luke's master key.** The flow:

1. Caddy guards `/cockpit*` with `forward_auth` to `luke-service`'s
   `/gate/verify`.
2. No valid session → the gate 302s you to `/gate/login`, which asks your
   **NIP-07 browser extension** (Alby, nos2x) to sign a NIP-98 challenge.
3. The gate verifies the signature, checks the pubkey **equals your
   configured master npub**, and — only then — sets a short-lived,
   HttpOnly, Secure session cookie.
4. With the cookie, `forward_auth` passes and Caddy proxies to OpenClaw on
   `host.docker.internal:57419`. OpenClaw's **own** gateway auth is the
   second, inner lock (defense in depth).

This is the same author-mode idea as Noir — *prove you're the master with
your key* — applied to the one service that can drive your machine. No
password to phish, no basic-auth to brute; the gate opens only for a
signature from one specific key.

## Why this is best practice

- **Control plane ≠ product plane.** The thing that can act on your box is
  never the thing a stranger can reach.
- **Least privilege in public.** The public address exposes a read-only
  identity card, not capabilities.
- **Revocable by design.** Luke's authority is a grant you can rotate away,
  not a role baked into a server.
- **On-brand.** Identity is a keypair; authorization is a signature;
  revocation is a key rotation — Luke obeys the same three sentences as
  every other room in the Nave.

## Configure and run

See `luke/.env.example`. The essentials:

- `LUKE_NSEC` — Luke's own key (his identity; gitignored, box-only).
- `LUKE_MASTER_NPUB` — **your** npub. The *only* key the gate lets in.
  This is the hard security boundary; set it explicitly.
- `LUKE_MANDATE` — one line describing what you've delegated to Luke.
- `GATE_SECRET` — HMAC secret for session cookies (or it's derived from
  `LUKE_NSEC` so sessions survive restarts).

Then, on the box:

```bash
cd /root/noir/deploy
docker compose up -d --build luke      # brings up luke-service
# uncomment the luke.nave.pub block in Caddyfile, then:
docker compose up -d caddy
```

OpenClaw keeps running on host port `57419` as it does today; the gate
never touches its config. Set OpenClaw's own `gateway.controlUi
.allowedOrigins` to include `https://luke.nave.pub` so the cockpit UI
accepts its new address (see DEPLOY.md §8).

Verify:
- `https://luke.nave.pub/health` → Luke's card as JSON.
- `https://luke.nave.pub/` → the card.
- `https://luke.nave.pub/cockpit` → the gate; sign with your master key →
  the OpenClaw UI, then its own auth.
