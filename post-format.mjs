// post-format.mjs — pure helpers shared by the brain (drafting/validation) and
// the poster (event assembly). Everything here is deterministic and unit-tested
// (post-format.test.mjs); neither side should hand-roll this wire format.
//
// The three house rules every outbound post enforces (Director's standing
// instruction): a nave.pub link, a relevant graphic, appropriate hashtags.

// A nave.pub link counts if ANY nave.pub URL is present (deep links to public
// app subdomains satisfy it — nvoy.nave.pub, notegate.nave.pub, …).
// The lookahead pins the host boundary: nave.pub must be the WHOLE host tail
// (nave.pubx.com and nave.pub.evil.com both fail it).
const NAVE_LINK_RE = /https?:\/\/(?:[a-z0-9-]+\.)*nave\.pub(?![\w.-])(?:\/\S*)?/i

export const SITE_URL = 'https://nave.pub'

export function hasSiteLink(text) {
  return NAVE_LINK_RE.test(String(text || ''))
}

// Append the site link on its own line unless some nave.pub URL is already in
// the text. Idempotent.
export function ensureSiteLink(text, url = SITE_URL) {
  const t = String(text || '').trimEnd()
  return hasSiteLink(t) ? t : `${t}\n\n${url}`
}

// Hashtags as clients index them: lowercase, no '#', deduped, in order of
// appearance. Matches letters/digits/underscore (the common client tokenizer).
export function extractHashtags(text) {
  const seen = new Set()
  for (const m of String(text || '').matchAll(/(?:^|\s)#([\p{L}\p{N}_]+)/gu)) {
    const tag = m[1].toLowerCase()
    if (!seen.has(tag)) seen.add(tag)
  }
  return [...seen]
}

// Guarantee at least one hashtag; if the draft has none, add the ecosystem tag
// on its own line (before any trailing link line, after the prose).
export function ensureHashtags(text, fallback = 'nave') {
  const t = String(text || '').trimEnd()
  if (extractHashtags(t).length) return t
  if (!hasSiteLink(t)) return `${t}\n\n#${fallback}`
  // Keep the link as the final line: insert the tag line above the first line
  // that contains the nave.pub URL.
  const lines = t.split('\n')
  const i = lines.findIndex(l => NAVE_LINK_RE.test(l))
  lines.splice(i, 0, `#${fallback}`, '')
  return lines.join('\n').replace(/\n{3,}/g, '\n\n')
}

// Final note content: prose (already carrying hashtags + link) with the image
// URL as the last line — clients render a trailing media URL inline.
export function composeContent(text, imageUrl) {
  const t = String(text || '').trimEnd()
  return imageUrl ? `${t}\n\n${imageUrl}` : t
}

const IMAGE_MIME = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp' }

// NIP-92 imeta tag for an image URL (space-delimited key/value strings).
export function imetaTag(url, alt) {
  const ext = (String(url).split('?')[0].match(/\.(\w+)$/) || [])[1]?.toLowerCase()
  const parts = [`url ${url}`]
  if (IMAGE_MIME[ext]) parts.push(`m ${IMAGE_MIME[ext]}`)
  if (alt) parts.push(`alt ${alt}`)
  return ['imeta', ...parts]
}

// Tags for a kind-1: NIP-10 threading (when replying), NIP-92 imeta (when an
// image rides along), and a lowercase `t` tag per hashtag in the content so
// hashtag feeds actually surface the note.
//
// `parent` is the event being replied to, if the poster could fetch it:
//   - with a parent that is itself a reply (has an e-root tag): proper marked
//     threading — root stays root, parent becomes the 'reply' marker;
//   - with a top-level parent: parent IS the root;
//   - without a parent event (fetch failed): fall back to the old behavior,
//     e-tag the id as root so the thread link at least holds.
// The p tag on the parent author is what makes the reply NOTIFY them — a reply
// nobody sees is not engagement.
export function buildTags({ content, imageUrl, imageAlt, replyTo, parent }) {
  const tags = []
  if (replyTo) {
    if (parent && parent.id === replyTo) {
      const rootId = (parent.tags?.find(t => t[0] === 'e' && t[3] === 'root') || [])[1]
      if (rootId && rootId !== parent.id) {
        tags.push(['e', rootId, '', 'root'], ['e', parent.id, '', 'reply'])
      } else {
        tags.push(['e', parent.id, '', 'root'])
      }
      if (parent.pubkey) tags.push(['p', parent.pubkey])
    } else {
      tags.push(['e', replyTo, '', 'root'])
    }
  }
  if (imageUrl) tags.push(imetaTag(imageUrl, imageAlt))
  for (const t of extractHashtags(content)) tags.push(['t', t])
  return tags
}
