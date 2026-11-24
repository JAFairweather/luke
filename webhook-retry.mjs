// How long luke keeps trying to register the Telegram webhook at boot: the wait after each failed attempt.
//
// On a deploy luke and the broker (nactor) start together, and the broker answers 503 "credential
// 'telegram-nactjaf' not imported" until its grant sweep has loaded the credentials. That sweep took 36 s
// on 24 Nov 2026 (twice), and the old schedule gave up after 30 s, so every deploy left approval taps
// dead until someone restarted luke. Two minutes covers the sweep with room; no wait is longer than 15 s,
// so the webhook is registered soon after the credentials arrive. Checked by webhook-retry.test.mjs.
export const WEBHOOK_RETRY_DELAYS_MS = [2, 4, 6, 8, 10, 15, 15, 15, 15, 15, 15].map(s => s * 1000)
