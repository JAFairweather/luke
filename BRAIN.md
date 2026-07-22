# Luke's brain — scheduled proposer

`luke-brain.mjs` runs twice a day, gathers the day's **public** signals,
drafts 1–3 candidate posts in our voice, and POSTs each to `/propose` — which
sends them to your Telegram to approve. It holds **no signing key**; it can
only propose.

```
  cron (2×/day)
     │
     ▼
  luke-brain.mjs
     ├─ read brief/voice.md               (voice & themes — your steering wheel)
     ├─ GitHub commits across nave repos   (what shipped)
     ├─ Substack RSS                       (new blog posts)
     ├─ nostr engagement on Luke & Nave    (replies to follow up on)
     ├─ Anthropic API → draft ≤3 posts as JSON
     └─ POST each → https://luke.nave.pub/propose  → 📱 your Telegram
```

Everything it reads is public — no calendar, no inbox. The "personal signal"
is **`brief/voice.md`**, which you edit by hand (themes, tidbits, focus). That
file is the fastest lever on what Luke sounds like and talks about.

## Prereqs
The brain needs these in the encrypted env (`secrets.enc.env`):
- `ANTHROPIC_API_KEY` — to draft (same key the Director uses).
- `PROPOSE_TOKEN` — to call `/propose` (shared with the box service).
- `LUKE_NSEC`, `NAVE_NSEC` — read-only here, only to derive the pubkeys it
  queries engagement for. (It never signs.)

## Try it once (dry run — drafts, doesn't propose)
```bash
cd /root/noir/deploy/sites/luke
docker run --rm --env-file /root/noir/luke/.env \
  -v "$PWD/luke-brain.mjs:/app/luke-brain.mjs:ro" \
  -v "$PWD/brief:/app/brief:ro" \
  luke:latest node luke-brain.mjs --dry-run
```
Drop `--dry-run` to actually send the drafts to your Telegram. (After a
rebuild the script + brief are baked into the image, so the `-v` mounts
become optional.)

## Schedule it twice a day (cron on the box)
`crontab -e`, then add — 08:00 and 17:00 box-local:
```cron
0 8,17 * * * docker run --rm --env-file /root/noir/luke/.env noir-luke:latest node luke-brain.mjs >> /var/log/luke-brain.log 2>&1
```
Use the image name your compose built (`docker images | grep luke`). Adjust
the hours to your timezone. Each firing drafts from the last `SINCE_HOURS`
(default 14h) so the two runs overlap slightly and nothing slips through.

> After the platform flip, swap `/root/noir/...` for `/root/nave.pub/...`.

## House rules (every post)
Three things ride on every draft, asked of the model AND enforced in code
after it (`post-format.mjs`):
1. **A nave.pub link** — the most specific public destination (deep links to
   public app subdomains count; gated hosts are never offered).
2. **A card graphic** — picked by slug from the site's card menu, fetched at
   `CARDS_MANIFEST_URL` (default `https://nave.pub/assets/cards/manifest.json`,
   rendered by `nave.pub/scripts/render-cards.mjs`). Manifest unreachable →
   the built-in default card, so "always a graphic" never blocks.
3. **Hashtags** — 1–3 lowercase topical tags in the text; never `#nostr`
   (never tag the platform you're on); `#nave` appended if the model offers none.

Replies follow the same rules by default; set `BRAIN_REPLY_PROMO=light` to
put conversation first on replies (no forced link/graphic — the model still
may include them where natural).

## Tuning
- **Voice/topics:** edit `brief/voice.md` (no redeploy needed if you mount it;
  otherwise it ships in the image on next deploy).
- **Cadence/volume:** `MAX_POSTS`, `SINCE_HOURS` in the env.
- **Model:** `DRAFT_MODEL` (default `claude-sonnet-5`).
- **Cards/promo:** `CARDS_MANIFEST_URL`, `BRAIN_REPLY_PROMO` (above).

Nothing the brain proposes is ever posted without your Telegram tap.
