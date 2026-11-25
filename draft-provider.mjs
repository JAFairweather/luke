// draft-provider.mjs: which model provider writes the brain's drafts, and each provider's request and reply shape.
//
// DRAFT_PROVIDER picks it: anthropic (the default, as before) or openai. DRAFT_MODEL still overrides the model;
// unset, each provider has its own default. Both go through the Nact broker, which holds the key; openai has no
// direct-key path at all. The prompt is the same for both: a system text, one user text, a JSON array back.
//
// Kept apart from luke-brain.mjs so the shapes can be tested without relays, a broker or a key
// (draft-provider.test.mjs).
export const PROVIDERS = ['anthropic', 'openai']
// anthropic: the strongest model, as the brain always used. openai: the mid tier ("balance intelligence and
// cost" in OpenAI's model list, Nov 2026), because the credit it spends is shared with the Primer.
export const DEFAULT_MODEL = { anthropic: 'claude-opus-4-8', openai: 'gpt-6.2-sol' }

export function draftProvider(env = process.env) {
  const p = (env.DRAFT_PROVIDER || '').trim().toLowerCase() || 'anthropic'
  if (!PROVIDERS.includes(p)) throw new Error(`DRAFT_PROVIDER '${p}' is not one of: ${PROVIDERS.join(', ')}`)
  return p
}

// A DRAFT_MODEL left over from the other provider would be refused upstream with a vaguer message; say it here.
export function draftModel(provider, env = process.env) {
  const m = (env.DRAFT_MODEL || '').trim()
  if (!m) return DEFAULT_MODEL[provider]
  const claude = /^claude/i.test(m)
  if ((provider === 'openai') === claude) throw new Error(`DRAFT_MODEL '${m}' is not a ${provider} model (DRAFT_PROVIDER=${provider})`)
  return m
}

// What to hand the broker: { provider, path, payload }.
export function draftRequest(provider, model, system, user) {
  if (provider === 'openai') {
    // max_completion_tokens counts the model's reasoning as well as the visible reply, so it is set well above
    // the 4000 the reply itself may need. `developer` is the role OpenAI's current models take instructions in.
    return {
      provider, path: '/v1/chat/completions',
      payload: { model, max_completion_tokens: 16000, messages: [{ role: 'developer', content: system }, { role: 'user', content: user }] },
    }
  }
  return { provider: 'anthropic', path: '/v1/messages', payload: { model, max_tokens: 4000, system, messages: [{ role: 'user', content: user }] } }
}

// The reply text out of the provider's response JSON.
export function draftReplyText(provider, j) {
  if (provider === 'openai') {
    const choice = j?.choices?.[0]
    const c = choice?.message?.content
    const text = (typeof c === 'string' ? c : Array.isArray(c) ? c.map(p => p?.text || '').join('') : '').trim()
    if (!text) throw new Error(`openai returned no text (finish_reason: ${choice?.finish_reason ?? 'none'}${choice?.message?.refusal ? ', refusal' : ''})`)
    return text
  }
  return (j?.content || []).map(c => c.text || '').join('').trim()
}

// One line for the run log per model call: which model answered and what it used, so spend can be read back
// from the brain's log. Token counts only; never the prompt or the reply.
export function draftUsageLine(provider, model, j) {
  const u = j?.usage || {}
  const inTok = provider === 'openai' ? u.prompt_tokens : u.input_tokens
  const outTok = provider === 'openai' ? u.completion_tokens : u.output_tokens
  const n = v => Number.isFinite(v) ? v : '?'
  return `model call: ${provider} ${j?.model || model} · in ${n(inTok)} · out ${n(outTok)} tokens`
}
