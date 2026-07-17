# Luke's calendar beat — your private daily agenda

`luke-calendar.mjs` reads the day's events from **your Google Calendar** through
Nactor's `gcal` broker and sends you a compact briefing on Telegram. It is a
*private* beat: the agenda is **never** proposed or posted — it only ever goes to
`TELEGRAM_APPROVER_ID` (you).

```
  cron (each morning)
     │
     ▼
  luke-calendar.mjs
     ├─ NIP-98 sign as `brain`
     ├─ POST nactor/api/broker  { provider:gcal, GET /calendar/v3/…/events?timeMin…timeMax }
     │     └─ Nactor mints a short-lived Google token from the stored refresh
     │        bundle and calls Calendar — the script never sees a credential
     ├─ format "🗓 Your day — …"
     └─ POST nactor/api/broker  { provider:telegram, sendMessage } → 📱 you
```

The credential never leaves Nactor: this script holds no Google secret and no
bot token — only its `brain` signing key, which the broker authorizes.

## Prereqs (already in place)
- The **OAuth2 broker** in Nactor with the `gworkspace` credential imported
  (`GOOGLE_OAUTH_*` in `nactor.env`) — see `nact/nactor/GOOGLE-WORKSPACE.md`.
  Verify it end to end with `Ops → run-script → gcal-verify.sh`.
- `brain.env` on the box provides `BRAIN_NSEC` + `NACT_BROKER_URL`.
- `luke.env` on the box provides `TELEGRAM_APPROVER_ID` (your chat id).

## Try it (dry run — fetch + print, no send)
```
Ops → run-script → gcal-brief.sh
```
That runs `luke-calendar.mjs --dry-run` on the box through the broker and prints
the briefing. To actually send it once, set `SEND=1` for that run.

Locally against a running stack:
```bash
docker run --rm --network nave \
  --env-file ./luke.env --env-file ./brain.env \
  luke:latest node luke-calendar.mjs --dry-run
```

## Schedule it (cron on the box)
`crontab -e`, then add — 07:15 box-local, once each morning:
```cron
15 7 * * * docker run --rm --network nave --env-file /root/nave.pub/deploy/luke.env --env-file /root/nave.pub/deploy/brain.env luke:latest node luke-calendar.mjs >> /var/log/luke-calendar.log 2>&1
```

## Tuning (env)
- `CAL_TZ` — timezone for day boundaries + times (default `America/New_York`).
- `CAL_DAYS` — `1` = today only (default); `2` = today + tomorrow.
- `CAL_ID` — which calendar (default `primary`).
- `CAL_MAX` — max events to list (default 25).

Nothing here is ever public. It reads your calendar and messages only you.
