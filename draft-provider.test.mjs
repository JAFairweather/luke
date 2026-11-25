// node --test draft-provider.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { draftProvider, draftModel, draftRequest, draftReplyText, draftUsageLine, DEFAULT_MODEL } from './draft-provider.mjs'

test('provider: anthropic unless DRAFT_PROVIDER says openai; anything else is refused', () => {
  assert.equal(draftProvider({}), 'anthropic')
  assert.equal(draftProvider({ DRAFT_PROVIDER: '' }), 'anthropic')
  assert.equal(draftProvider({ DRAFT_PROVIDER: ' OpenAI ' }), 'openai')
  assert.throws(() => draftProvider({ DRAFT_PROVIDER: 'gemini' }), /not one of/)
})

test('model: each provider has its own default; DRAFT_MODEL overrides; the other provider\'s model is refused', () => {
  assert.equal(draftModel('anthropic', {}), DEFAULT_MODEL.anthropic)
  assert.equal(draftModel('openai', {}), DEFAULT_MODEL.openai)
  assert.equal(draftModel('openai', { DRAFT_MODEL: 'gpt-6-luna' }), 'gpt-6-luna')
  assert.equal(draftModel('anthropic', { DRAFT_MODEL: 'claude-haiku-4-5' }), 'claude-haiku-4-5')
  assert.throws(() => draftModel('openai', { DRAFT_MODEL: 'claude-opus-4-8' }), /not a openai model/)
  assert.throws(() => draftModel('anthropic', { DRAFT_MODEL: 'gpt-6.2-sol' }), /not a anthropic model/)
})

test('anthropic request is the one the brain always sent', () => {
  assert.deepEqual(draftRequest('anthropic', 'claude-opus-4-8', 'SYS', 'USER'), {
    provider: 'anthropic', path: '/v1/messages',
    payload: { model: 'claude-opus-4-8', max_tokens: 4000, system: 'SYS', messages: [{ role: 'user', content: 'USER' }] },
  })
})

test('openai request: chat completions, instructions as developer, no anthropic-only fields', () => {
  const r = draftRequest('openai', 'gpt-6.2-sol', 'SYS', 'USER')
  assert.equal(r.provider, 'openai')
  assert.equal(r.path, '/v1/chat/completions')
  assert.deepEqual(r.payload.messages, [{ role: 'developer', content: 'SYS' }, { role: 'user', content: 'USER' }])
  assert.equal(r.payload.model, 'gpt-6.2-sol')
  assert.ok(r.payload.max_completion_tokens >= 8000, 'room for reasoning as well as the reply')
  assert.equal('max_tokens' in r.payload, false)
  assert.equal('system' in r.payload, false)
})

test('reply text: anthropic content blocks; openai choices[0].message.content as a string or as parts', () => {
  assert.equal(draftReplyText('anthropic', { content: [{ type: 'text', text: ' [1' }, { type: 'text', text: ',2] ' }] }), '[1,2]')
  assert.equal(draftReplyText('anthropic', {}), '')
  assert.equal(draftReplyText('openai', { choices: [{ message: { content: ' [{"text":"x"}] ' } }] }), '[{"text":"x"}]')
  assert.equal(draftReplyText('openai', { choices: [{ message: { content: [{ type: 'text', text: '[' }, { type: 'text', text: ']' }] } }] }), '[]')
})

test('openai reply with no text says why instead of failing later as "did not return JSON"', () => {
  assert.throws(() => draftReplyText('openai', { choices: [{ finish_reason: 'length', message: { content: '' } }] }), /no text \(finish_reason: length\)/)
  assert.throws(() => draftReplyText('openai', { choices: [{ finish_reason: 'stop', message: { content: null, refusal: 'no' } }] }), /refusal/)
  assert.throws(() => draftReplyText('openai', {}), /finish_reason: none/)
})

test('usage line: model and token counts for either provider, and nothing of the prompt or reply', () => {
  assert.equal(draftUsageLine('openai', 'gpt-6.2-sol', { model: 'gpt-6.2-sol-2026-10-01', usage: { prompt_tokens: 1200, completion_tokens: 340 }, choices: [{ message: { content: 'SECRET-REPLY' } }] }),
    'model call: openai gpt-6.2-sol-2026-10-01 · in 1200 · out 340 tokens')
  assert.equal(draftUsageLine('anthropic', 'claude-opus-4-8', { usage: { input_tokens: 9, output_tokens: 8 } }), 'model call: anthropic claude-opus-4-8 · in 9 · out 8 tokens')
  assert.equal(draftUsageLine('openai', 'm', {}), 'model call: openai m · in ? · out ? tokens')
})

test('the brain drafts through this module and the image ships it', () => {
  const brain = readFileSync(new URL('./luke-brain.mjs', import.meta.url), 'utf8')
  assert.match(brain, /from '\.\/draft-provider\.mjs'/)
  assert.match(brain, /callModel\(draftRequest\(DRAFT_PROVIDER, DRAFT_MODEL, system, user\)\)/)
  assert.match(brain, /draftReplyText\(DRAFT_PROVIDER, j\)/)
  assert.match(brain, /log\('  ' \+ draftUsageLine\(DRAFT_PROVIDER, DRAFT_MODEL, j\)\)/)
  assert.match(readFileSync(new URL('./Dockerfile', import.meta.url), 'utf8'), /^COPY draft-provider\.mjs \.\/$/m)
})
