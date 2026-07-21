# Vendored login-page modules

Single-file ESM bundles for the gate's login page (`/gate/login`), served
same-origin at `/gate/vendor/*` by luke-service. The login page is the most
security-critical page on the box, so it loads **no CDN scripts** — these ride
in the image instead (same pattern as noir's `lib/vendor`).

Currently bundled from nostr-tools 2.24.1. Regenerate after bumping it:

```bash
npx esbuild node_modules/nostr-tools/lib/esm/index.js --bundle --format=esm --minify --outfile=gate-vendor/nostr-tools.mjs
npx esbuild node_modules/nostr-tools/lib/esm/nip46.js --bundle --format=esm --minify --outfile=gate-vendor/nostr-tools-nip46.mjs
```

The login page's importmap maps the bare `nostr-tools` / `nostr-tools/nip46`
specifiers to these files. `nave-connect.mjs` is NOT copied here — the gate
serves the canonical module from the repo root at `/gate/vendor/nave-connect.mjs`,
so it can never drift from source.
