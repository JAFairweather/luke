# brief/ — the steering files

One file per voice, plus one shared file. **Every one of these is published in a
public Docker image and a public repo — nothing private goes in here.**

| File | Whose voice | Read by | Where its posts go for approval |
|---|---|---|---|
| `shared.md` | nobody's — substance + house rules | every drafter | — |
| `nave.md` | the project | `luke-brain.mjs` | Nactor → Telegram |
| `luke.md` | Luke, the agent | `luke-brain.mjs` | Nactor → Telegram |
| `jaf.md` | the Director | `jaf-scribe.mjs` | Ngage — he signs in his own hand |

## The rule

**A drafting pass reads `shared.md` + its own voice file, and never another
voice's.** One LLM call per identity; the identity is fixed by the caller and
stamped on the result, so the model is never asked to choose a voice.

This replaced a single `voice.md` that described every voice at once and let the
model pick a hat per post — which is how two distinct voices quietly regress
toward one average voice. `voices.test.mjs` pins the isolation.

## Where each file comes from

Voice is derived from evidence, never inferred:

- **`jaf.md`** — twelve essays James wrote by hand, 2015–2025
  (jamesafairweather.com/writing), 4,054 words. Numbers in that file are measured.
- **`luke.md`** — `SOUL.md` and `IDENTITY.md`, the persona files Luke actually
  wakes up and reads on the box. Those files stay box-only; only the *public
  posting register* is carried over here.
- **`nave.md`** — the project's own creed and stated positions.
- **`shared.md`** — hand-edited. This is the fastest lever on relevance.

> **Never learn voice from our own generated output.** The essays in
> `nave.pub/library/articles` are AI-assisted; training the drafter on them is a
> feedback loop that amplifies whatever drift is already there.

## Editing

Edit freely — these are the steering wheel. `shared.md` is the one to reach for
most: focus areas go stale fastest. The Director's `jaf.md` can also be
overridden live over the wire by a `steer:draft` grant from Ngage, which takes
precedence over the file; the others are file-only until the Ngage voice-drafter
covers them too.

Adding a voice = adding `<name>.md` here and the name to `VOICES` in
`voices.mjs`. No prompt surgery.
