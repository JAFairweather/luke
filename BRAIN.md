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
     ├─ read brief/shared.md              (substance + house rules — every voice)
     ├─ GitHub commits + key-doc excerpts  (what shipped, and what it means)
     ├─ Substack RSS — titles AND bodies    (the essays, not just headlines)
     ├─ nostr engagement, split by which identity it landed on
     │
     ├─ pass 1 ─ as nave ─ shared.md + brief/nave.md ─┐
     ├─ pass 2 ─ as luke ─ shared.md + brief/luke.md ─┤
     │                                                ▼
     │                        interleave, cap at MAX_POSTS
     └─ POST each → https://luke.nave.pub/propose  → 📱 your Telegram
```

**One pass per identity, and a pass never sees another identity's steering.**
The identity is fixed by the caller and stamped on the result, so the model is
never asked to pick a voice. (It used to be a single call over one combined
corpus — which is how two distinct voices quietly average into one.) Each pass
also gets only the engagement that landed on *it*, and only its own approval
history.

A voice returning **zero** posts is a valid run, not a failure.

Everything it reads is public — no calendar, no inbox. The "personal signal" is
**`brief/`**, which you edit by hand. See [`brief/README.md`](brief/README.md)
for what each file is and where its voice was derived from.

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
- **Topics/substance:** edit `brief/shared.md` — themes, focus areas, house
  rules, fed to every voice. This is the fastest lever on relevance.
- **How one identity sounds:** edit `brief/nave.md` or `brief/luke.md`. Only
  that identity's pass reads it. Both are fed whole and treated as *substance to
  reason with*, not just a style sheet.
- Either way: no redeploy needed if you mount `brief/`; otherwise it ships in the
  image on the next deploy.
- **Cadence/volume:** `MAX_POSTS`, `SINCE_HOURS` in the env. `MAX_POSTS` is the
  run total; each voice gets `ceil(MAX_POSTS / voices)` and a quiet voice yields
  its share to a talkative one.
- **Model:** `DRAFT_MODEL` (default `claude-opus-4-8`). Depth is the goal and
  drafting runs only twice a day, so the strongest model is the default; set
  `DRAFT_MODEL` to a cheaper model for lower-cost or A/B runs.
- **Signal depth:** the brain feeds the model real material, not headlines — the
  **body** of recent Substack posts (`<content:encoded>`, ~1200-char excerpts),
  plus a short **key-doc excerpt** (README) for the significant repos that
  shipped in-window. Both are best-effort and never block drafting. The prompt
  asks for at least one genuinely *developed* thought per run, not just
  one-liners. Same knobs: `SUBSTACK_FEED`, `NAVE_REPOS`.
- **Cards/promo:** `CARDS_MANIFEST_URL`, `BRAIN_REPLY_PROMO` (above).

Nothing the brain proposes is ever posted without your Telegram tap.
