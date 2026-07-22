# Luke's posting loop — draft → approve → post

Luke proposes posts (twice a day, from the day's signals); **you approve each
one with a Telegram tap**; the box then signs with the role key and
broadcasts. Keys never leave the box; nothing is posted without your tap.

```
  BRAIN  (scheduled Claude routine)         HANDS  (luke box service)        YOU
  ─────────────────────────────────         ────────────────────────        ───
  gather signals:                                                    
   • your themes/voice corpus                                        
   • ecosystem shipping (GitHub)                                     
   • Substack RSS                                                    
   • nostr engagement                                                
        │ draft 1–3 candidates                                        
        ▼                                                             
   POST /propose  ───────────────────────▶  store draft, send        
   (Bearer PROPOSE_TOKEN)                    Telegram card ──────────▶ 📱 Approve? 
                                                    ▲                        │
                                             /telegram/webhook  ◀───────────┘ tap
                                             verify it's you →
                                             sign w/ role key →
                                             broadcast to relays →
                                             edit card: ✅ Posted
```

- **The brain never holds a key.** It can only *propose*. Your tap is the
  authorization; the box does the signing.
- **What the tap approves is what the feed shows.** A draft that carries a
  card graphic arrives in Telegram as a photo card (the caption is the post);
  on approve, the note publishes with the image URL on its last line, a
  NIP-92 `imeta` tag, and a lowercase `t` tag per hashtag so hashtag feeds
  surface it. Replies fetch the parent note first and thread properly
  (NIP-10 root/reply markers + a `p` tag on its author, so the person
  actually gets notified). The poster only ever attaches images hosted at
  `https://nave.pub/` — foreign URLs from a compromised proposer are dropped.
- **Only you can approve.** The webhook checks the tapper's Telegram ID
  against `TELEGRAM_APPROVER_ID`.
- **Nvoy** is the data broker that grants the brain scoped access to your
  private signals — it feeds the flow; it is not the flow.

## One-time setup (on the box)

### 1. Create the Telegram bot
- In Telegram, message **@BotFather** → `/newbot` → name it (e.g. "Luke") →
  copy the **bot token** → that's `TELEGRAM_BOT_TOKEN`.
- Message **@userinfobot** → it replies with your numeric ID → that's
  `TELEGRAM_APPROVER_ID`.
- Send your new bot any message once (so it can DM you back).

### 2. Generate the two bridge secrets
```bash
openssl rand -hex 24     # → PROPOSE_TOKEN
openssl rand -hex 24     # → TELEGRAM_WEBHOOK_SECRET
```

### 3. Add all four to the encrypted env, re-deploy
```bash
cd /root/noir/deploy/sites/luke
sops secrets.enc.env     # opens decrypted in $EDITOR; fill:
                         #   TELEGRAM_BOT_TOKEN, TELEGRAM_APPROVER_ID,
                         #   PROPOSE_TOKEN, TELEGRAM_WEBHOOK_SECRET
git add secrets.enc.env && git commit -m "Add posting-loop secrets" && git push
```
Then deploy (the button, or `cd /root/noir/deploy && bash sites.sh && docker compose up -d --build luke`).
Check the container log — it should say `poster: ready — [luke, nave], N relays`.

### 4. Register the Telegram webhook (point Telegram at the box)
```bash
source <(sops -d --output-type dotenv secrets.enc.env | grep -E '^(TELEGRAM_BOT_TOKEN|TELEGRAM_WEBHOOK_SECRET)=')
curl -s "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/setWebhook" \
  -d "url=https://luke.nave.pub/telegram/webhook" \
  -d "secret_token=${TELEGRAM_WEBHOOK_SECRET}"
```

## Smoke test (prove the loop before the brain exists)
```bash
# from anywhere that has PROPOSE_TOKEN:
curl -s https://luke.nave.pub/propose \
  -H "authorization: Bearer $PROPOSE_TOKEN" \
  -H "content-type: application/json" \
  -d '{"identity":"luke","text":"Testing the loop — first words from Luke.","rationale":"smoke test"}'
```
You should get a Telegram card. Tap **✅ Approve & post** → it publishes and
the card updates to “✅ Posted · note1… · N relays.” Reject discards it.

## The brain
A scheduled Claude routine, twice daily, that gathers the four signals,
drafts 1–3 candidates, and POSTs each to `/propose`. It runs **one drafting pass
per identity** — each reading `brief/shared.md` plus its own voice file and never
another's — so Nave sounds like the project, Luke sounds like Luke, and neither
sounds like a changelog. See [`brief/README.md`](brief/README.md) and
[`BRAIN.md`](BRAIN.md).

## `/propose` contract
`POST /propose`  ·  `Authorization: Bearer <PROPOSE_TOKEN>`
```json
{ "identity": "luke" | "nave", "text": "the post", "rationale": "why (shown to you, not posted)", "replyTo": "<event-id, optional, for follow-ups>" }
```
`identity` selects which role key signs. `replyTo` makes it a reply (for
following up on engagement). `rationale` is context for your decision only.
