// node --test post-format.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  hasSiteLink, ensureSiteLink, extractHashtags, ensureHashtags,
  composeContent, imetaTag, buildTags, SITE_URL, mentionedApps, ensureLinks, hasApexLink,
} from './post-format.mjs'

test('hasSiteLink: root, subdomain, deep path — but not lookalikes', () => {
  assert.equal(hasSiteLink('read https://nave.pub'), true)
  assert.equal(hasSiteLink('console at https://nvoy.nave.pub/console'), true)
  assert.equal(hasSiteLink('http://notegate.nave.pub'), true)
  assert.equal(hasSiteLink('bare nave.pub is not a link'), false)
  assert.equal(hasSiteLink('https://nave.pubx.com'), false)
  assert.equal(hasSiteLink('https://nave.pub.evil.com/x'), false)
  assert.equal(hasSiteLink(''), false)
})

test('ensureSiteLink appends once, idempotently', () => {
  const once = ensureSiteLink('hello world')
  assert.equal(once, `hello world\n\n${SITE_URL}`)
  assert.equal(ensureSiteLink(once), once)                      // already linked → unchanged
  const deep = 'try it: https://nvoy.nave.pub'
  assert.equal(ensureSiteLink(deep), deep)                      // deep link satisfies the rule
})

test('extractHashtags: lowercase, dedup, order, word-boundary', () => {
  assert.deepEqual(extractHashtags('Ship #Grants and #privacy, then #grants again'), ['grants', 'privacy'])
  assert.deepEqual(extractHashtags('#at-start works'), ['at'])  // hyphen ends the tag (client tokenizer)
  assert.deepEqual(extractHashtags('url#fragment is not a tag'), [])
  assert.deepEqual(extractHashtags('none here'), [])
})

test('ensureHashtags: absent → ecosystem tag, present → untouched, link stays last', () => {
  assert.equal(ensureHashtags('plain text'), 'plain text\n\n#nave')
  assert.equal(ensureHashtags('has #tags already'), 'has #tags already')
  const withLink = `prose line\n\n${SITE_URL}`
  const out = ensureHashtags(withLink)
  assert.match(out, /#nave/)
  assert.ok(out.trimEnd().endsWith(SITE_URL), 'site link must remain the final line')
})

test('composeContent puts the image URL last', () => {
  assert.equal(composeContent('text', 'https://x/y.png'), 'text\n\nhttps://x/y.png')
  assert.equal(composeContent('text', null), 'text')
})

test('imetaTag: url + mime + alt', () => {
  assert.deepEqual(imetaTag('https://nave.pub/assets/cards/nvoy.png', 'Nvoy card'),
    ['imeta', 'url https://nave.pub/assets/cards/nvoy.png', 'm image/png', 'alt Nvoy card'])
  assert.deepEqual(imetaTag('https://x/y.jpg?v=2'), ['imeta', 'url https://x/y.jpg?v=2', 'm image/jpeg'])
  assert.deepEqual(imetaTag('https://x/noext'), ['imeta', 'url https://x/noext'])
})

test('buildTags: standalone post — imeta + t tags, no threading', () => {
  const tags = buildTags({ content: 'shipping #grants #nave', imageUrl: 'https://nave.pub/assets/cards/grants.png', imageAlt: 'alt' })
  assert.deepEqual(tags, [
    ['imeta', 'url https://nave.pub/assets/cards/grants.png', 'm image/png', 'alt alt'],
    ['t', 'grants'], ['t', 'nave'],
  ])
})

test('buildTags: reply to a top-level note — parent is root, author p-tagged', () => {
  const parent = { id: 'aa'.repeat(32), pubkey: 'bb'.repeat(32), tags: [] }
  const tags = buildTags({ content: 'thanks!', replyTo: parent.id, parent })
  assert.deepEqual(tags, [
    ['e', parent.id, '', 'root'],
    ['p', parent.pubkey],
  ])
})

test('buildTags: reply to a mid-thread note — marked root + reply, author p-tagged', () => {
  const rootId = 'cc'.repeat(32)
  const parent = { id: 'aa'.repeat(32), pubkey: 'bb'.repeat(32), tags: [['e', rootId, '', 'root'], ['p', 'dd'.repeat(32)]] }
  const tags = buildTags({ content: 'deep reply', replyTo: parent.id, parent })
  assert.deepEqual(tags, [
    ['e', rootId, '', 'root'],
    ['e', parent.id, '', 'reply'],
    ['p', parent.pubkey],
  ])
})

test('buildTags: parent fetch failed — degrade to old behavior (e root only)', () => {
  const id = 'aa'.repeat(32)
  assert.deepEqual(buildTags({ content: 'x', replyTo: id, parent: null }), [['e', id, '', 'root']])
})

test('mentionedApps: word-boundary, deduped, gated hosts absent', () => {
  assert.deepEqual(mentionedApps('Nontact keeps contacts fresh'), ['https://nontact.nave.pub'])
  assert.deepEqual(mentionedApps('Nact brokers it; Nactor is its runtime'), ['https://nact.nave.pub'])
  assert.deepEqual(mentionedApps('warm.contact is inbound-first'), ['https://warm.contact'])
  assert.deepEqual(mentionedApps('the Cockpit and Console are gated'), [])   // never public-linked
  assert.deepEqual(mentionedApps('no apps here'), [])
})

test('ensureLinks: apex always, plus every named app, idempotent', () => {
  const out = ensureLinks('Nontact makes the address book stop rotting.')
  assert.ok(out.includes('https://nave.pub'), 'apex always present')
  assert.ok(out.includes('https://nontact.nave.pub'), 'named app linked too')
  assert.equal(ensureLinks(out), out, 'idempotent')
  // a deep link alone does NOT satisfy the apex rule any more
  const deep = ensureLinks('read it at https://nvoy.nave.pub')
  assert.ok(hasApexLink(deep), 'apex appended even when a subdomain link exists')
  assert.ok(deep.includes('https://nvoy.nave.pub'))
})

// --- ensureDisclosure (the Director's standing AI-assistance line, 2026-07-23)
{
  const { ensureDisclosure, DISCLOSURE } = await import('./post-format.mjs')
  const one = (s) => (s.match(/assisted by Claude Code/g) || []).length
  test('appends the standing disclosure at the very bottom', () => {
    const out = ensureDisclosure('A post about nave.\n\nhttps://nave.pub\n#nave')
    assert.ok(out.trimEnd().endsWith(DISCLOSURE))
    assert.equal(one(out), 1)
  })
  test('replaces a model-emitted "Generated by Claude Code (→ claude.ai)"', () => {
    const out = ensureDisclosure('A post.\n\n_Generated by Claude Code (→ claude.ai)_')
    assert.equal(one(out), 1)
    assert.ok(!/Generated (by|with) Claude|→ claude\.ai|via Claude/i.test(out))
  })
  test('is idempotent — re-running never doubles the line', () => {
    const once = ensureDisclosure('A post.')
    assert.equal(ensureDisclosure(once), once)
    assert.equal(one(ensureDisclosure(once)), 1)
  })
  test('strips multiple prior attributions, leaving exactly one', () => {
    const out = ensureDisclosure('A post.\n\nGenerated with Claude\nvia Claude Code')
    assert.equal(one(out), 1)
  })
}
