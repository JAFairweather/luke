# Luke

A **nostr-delegated agent** at `luke.nave.pub`, and the **nostr-signed gate**
to a private OpenClaw cockpit. Part of the Nave family; its own service, its
own repo.

- **Public plane** (`/`) — Luke's card: his npub, his mandate, and his
  delegation status (a revocable grant from his master). Read-only.
- **Control plane** (`/cockpit*`) — the real OpenClaw Control UI, reachable
  only past a NIP-98 signature from the configured master npub.

Same author-mode idea as Noir — *prove you're the master with your key* —
applied to the one service that can act on the box. See **[LUKE.md](LUKE.md)**
for the architecture and runbook.

## Run

```
cp .env.example .env      # set LUKE_NSEC, LUKE_MASTER_NPUB (your npub), LUKE_MANDATE
npm install && npm start  # or build the Dockerfile
```

Depends only on `nostr-tools`. The shared Caddy front door (in the deploy
stack) proxies `luke.nave.pub` to this service and gates `/cockpit*`.
