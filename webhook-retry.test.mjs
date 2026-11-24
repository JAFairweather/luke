// node --test webhook-retry.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { WEBHOOK_RETRY_DELAYS_MS as D } from './webhook-retry.mjs'

const total = D.reduce((a, b) => a + b, 0)

test('keeps trying well past the broker\'s grant sweep (36 s seen on 24 Nov 2026)', () => {
  assert.ok(total >= 90_000, `retries cover only ${total / 1000} s`)
})

test('starts quickly and never waits long between attempts', () => {
  assert.ok(D[0] <= 2000, 'first retry within 2 s')
  assert.ok(Math.max(...D) <= 15_000, 'no wait longer than 15 s')
  assert.ok(D.every(ms => Number.isInteger(ms) && ms > 0))
})

test('the poster uses this schedule and the image ships it', () => {
  const poster = readFileSync(new URL('./luke-poster.mjs', import.meta.url), 'utf8')
  assert.match(poster, /import \{ WEBHOOK_RETRY_DELAYS_MS \} from '\.\/webhook-retry\.mjs'/)
  assert.match(poster, /WEBHOOK_RETRY_DELAYS_MS\[i\]/)
  const dockerfile = readFileSync(new URL('./Dockerfile', import.meta.url), 'utf8')
  assert.match(dockerfile, /^COPY webhook-retry\.mjs \.\/$/m)
})
