// Parsing an email, in the email reader's process (5.6 of DESIGN.md).
//
// `postal-mime` does the parsing: the MIME tree, transfer encodings, character sets and encoded
// words. This module turns what it gives into what the spool holds: the subject, the body as text,
// and the attachments. The body is the plain-text part, or else the HTML part turned into text
// (`htmlToText`), since postal-mime gives an HTML-only email no text of its own.
//
// It runs only in the reader, which runs as `scooter-mail`: no library that parses mail runs in the
// bridge's process (section 2). The bridge checks what the reader hands over, and reads the headers
// it decides on (the sender check, the `Message-ID` and the `Date`) itself.

import PostalMime from 'postal-mime'

// What an attachment's MIME type must look like to be handed over as it is: `type/subtype`, in the
// characters RFC 6838 allows, at most 127 of each. Anything else is `application/octet-stream`.
// The bridge holds a type to the same rule (`src/bridge/channels/email.mjs`).
const MIME_TYPE = /^[a-z0-9][a-z0-9!#$&^_.+-]{0,126}\/[a-z0-9][a-z0-9!#$&^_.+-]{0,126}$/
export const UNKNOWN_MIME = 'application/octet-stream'

// The longest original file name handed over, in characters. A longer one is cut; the bridge names
// the stored file itself (4.1), so the name is only what the owner called it.
export const NAME_MAX_CHARS = 255

// The first `max` characters of `text`, a character being a Unicode code point.
export function firstChars(text, max) {
  let count = 0
  let end = 0
  for (const char of text) {
    if (count === max) break
    count += 1
    end += char.length
  }
  return text.slice(0, end)
}

export function mimeTypeOf(value) {
  const type = typeof value === 'string' ? value.trim().toLowerCase() : ''
  return MIME_TYPE.test(type) ? type : UNKNOWN_MIME
}

// ---------------------------------------------------------------------------------------------
// HTML to text

// The named character references a mail client writes: the five of XML, every name of Latin-1
// (U+00A0 to U+00FF, in order), and the punctuation, symbols and spaces of HTML 4. A name that
// isn't here is left as it was written.
const LATIN1 = [
  'nbsp', 'iexcl', 'cent', 'pound', 'curren', 'yen', 'brvbar', 'sect', 'uml', 'copy', 'ordf', 'laquo', 'not', 'shy',
  'reg', 'macr', 'deg', 'plusmn', 'sup2', 'sup3', 'acute', 'micro', 'para', 'middot', 'cedil', 'sup1', 'ordm',
  'raquo', 'frac14', 'frac12', 'frac34', 'iquest', 'Agrave', 'Aacute', 'Acirc', 'Atilde', 'Auml', 'Aring', 'AElig',
  'Ccedil', 'Egrave', 'Eacute', 'Ecirc', 'Euml', 'Igrave', 'Iacute', 'Icirc', 'Iuml', 'ETH', 'Ntilde', 'Ograve',
  'Oacute', 'Ocirc', 'Otilde', 'Ouml', 'times', 'Oslash', 'Ugrave', 'Uacute', 'Ucirc', 'Uuml', 'Yacute', 'THORN',
  'szlig', 'agrave', 'aacute', 'acirc', 'atilde', 'auml', 'aring', 'aelig', 'ccedil', 'egrave', 'eacute', 'ecirc',
  'euml', 'igrave', 'iacute', 'icirc', 'iuml', 'eth', 'ntilde', 'ograve', 'oacute', 'ocirc', 'otilde', 'ouml',
  'divide', 'oslash', 'ugrave', 'uacute', 'ucirc', 'uuml', 'yacute', 'thorn', 'yuml',
]
const ENTITIES = new Map([
  ['amp', '&'], ['lt', '<'], ['gt', '>'], ['quot', '"'], ['apos', "'"],
  ...LATIN1.map((name, n) => [name, String.fromCodePoint(0xa0 + n)]),
  ['OElig', 'Œ'], ['oelig', 'œ'], ['Scaron', 'Š'], ['scaron', 'š'], ['Yuml', 'Ÿ'], ['fnof', 'ƒ'], ['circ', 'ˆ'],
  ['tilde', '˜'], ['ensp', ' '], ['emsp', ' '], ['thinsp', ' '], ['zwnj', '‌'], ['zwj', '‍'],
  ['lrm', '‎'], ['rlm', '‏'], ['ndash', '–'], ['mdash', '—'], ['lsquo', '‘'], ['rsquo', '’'], ['sbquo', '‚'],
  ['ldquo', '“'], ['rdquo', '”'], ['bdquo', '„'], ['dagger', '†'], ['Dagger', '‡'], ['bull', '•'], ['hellip', '…'],
  ['permil', '‰'], ['prime', '′'], ['Prime', '″'], ['lsaquo', '‹'], ['rsaquo', '›'], ['oline', '‾'], ['frasl', '⁄'],
  ['euro', '€'], ['trade', '™'], ['larr', '←'], ['uarr', '↑'], ['rarr', '→'], ['darr', '↓'], ['harr', '↔'],
  ['lArr', '⇐'], ['uArr', '⇑'], ['rArr', '⇒'], ['dArr', '⇓'], ['hArr', '⇔'], ['minus', '−'], ['le', '≤'], ['ge', '≥'],
  ['ne', '≠'], ['asymp', '≈'], ['infin', '∞'], ['check', '✓'], ['star', '☆'],
])

// Decodes character references: `&amp;`, `&eacute;`, `&#233;` and `&#xE9;`. A reference to no
// character, or to U+0000, becomes U+FFFD, as HTML has it.
export function decodeEntities(text) {
  return text.replace(/&(?:#[xX]([0-9a-fA-F]{1,6})|#([0-9]{1,7})|([A-Za-z][A-Za-z0-9]{1,31}));?/g, (whole, hex, decimal, name) => {
    if (name !== undefined) return ENTITIES.get(name) ?? whole
    const code = hex !== undefined ? parseInt(hex, 16) : Number(decimal)
    if (code === 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) return '�'
    return String.fromCodePoint(code)
  })
}

// Elements whose content is no text of the message.
const HIDDEN = new Set(['head', 'script', 'style', 'template', 'title'])
// Elements that break a line where they start and end.
const BLOCKS = new Set([
  'address', 'article', 'aside', 'blockquote', 'body', 'caption', 'center', 'dd', 'details', 'dialog', 'div', 'dl',
  'dt', 'fieldset', 'figcaption', 'figure', 'footer', 'form', 'header', 'hgroup', 'html', 'li', 'main', 'nav', 'ol',
  'pre', 'section', 'summary', 'table', 'tbody', 'tfoot', 'thead', 'tr', 'ul',
])
// Elements that leave a blank line before and after them: a paragraph, a heading, a rule.
const PARAGRAPHS = new Set(['p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'hr'])
// Table cells, which sit side by side.
const CELLS = new Set(['td', 'th'])

// An HTML body as text: tags dropped, character references decoded, and line breaks kept where
// block elements, `<br>` and table rows put them (5.6). Comments, scripts, styles and the head are
// dropped with what they hold. Spaces run together as a browser shows them, a paragraph or a
// heading is set off by a blank line, a list item starts with "- ", and table cells are kept apart
// by a space.
//
// The HTML is the sender's, so it is read in one pass that finds each `<` and `>` once, and takes
// time in step with its length whatever it holds: a tag, a comment or a script that never ends
// drops the rest.
export function htmlToText(html) {
  const lower = html.toLowerCase()
  // What is out so far, in pieces, and its last character: building one string and looking at its
  // end would take time in the square of its length.
  const parts = []
  let last = ''
  const put = piece => {
    if (piece === '') return
    parts.push(piece)
    last = piece.at(-1)
  }
  const dropTrailingSpaces = () => {
    while (last === ' ') {
      const piece = parts.pop().replace(/ +$/, '')
      if (piece !== '') parts.push(piece)
      last = parts.length === 0 ? '' : parts.at(-1).at(-1)
    }
  }
  // Line breaks owed before the next text: 1 at a block's edge, 2 at a paragraph's. Several edges
  // in a row owe the most of them, not their sum.
  let owed = 0
  let prefix = ''
  const breakLine = count => {
    dropTrailingSpaces()
    if (last !== '') put('\n'.repeat(count))
    owed = 0
  }
  const text = raw => {
    const piece = decodeEntities(raw).replace(/[ \t\r\n\f\u00a0]+/g, ' ')
    if (piece === '') return
    if (piece === ' ') {
      if (owed === 0 && last !== '' && last !== ' ' && last !== '\n') put(' ')
      return
    }
    if (owed > 0) breakLine(owed)
    put(`${prefix}${last === '' || last === '\n' ? piece.trimStart() : piece}`)
    prefix = ''
  }
  let i = 0
  while (i < html.length) {
    const open = html.indexOf('<', i)
    if (open === -1) {
      text(html.slice(i))
      break
    }
    if (open > i) text(html.slice(i, open))
    // A `<` that starts no tag is text, as a browser shows it.
    if (!/[A-Za-z/!?]/.test(html[open + 1] ?? '')) {
      text('<')
      i = open + 1
      continue
    }
    if (html.startsWith('<!--', open)) {
      const end = html.indexOf('-->', open + 4)
      i = end === -1 ? html.length : end + 3
      continue
    }
    const close = html.indexOf('>', open + 1)
    if (close === -1) break
    i = close + 1
    // `<!doctype …>`, `<?xml …>` and `</ >` are no text.
    const tag = /^(\/?)\s*([a-zA-Z][a-zA-Z0-9-]*)/.exec(html.slice(open + 1, Math.min(close, open + 64)))
    if (!tag) continue
    const closing = tag[1] === '/'
    const name = tag[2].toLowerCase()
    if (HIDDEN.has(name) && !closing && html[close - 1] !== '/') {
      const end = lower.indexOf(`</${name}`, close + 1)
      const after = end === -1 ? -1 : html.indexOf('>', end)
      i = after === -1 ? html.length : after + 1
      continue
    }
    if (name === 'br') breakLine(Math.max(owed, 1))
    else if (PARAGRAPHS.has(name)) owed = Math.max(owed, 2)
    else if (BLOCKS.has(name)) owed = Math.max(owed, 1)
    else if (CELLS.has(name) && closing) text(' ')
    if (name === 'li' && !closing) prefix = '- '
  }
  return parts
    .join('')
    .split('\n')
    .map(line => line.trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

// ---------------------------------------------------------------------------------------------
// Emails

// Parses a whole message. Returns `{ subject, text, attachments }`, each attachment as `{ name,
// mime, content }`: its file name or null, its MIME type, and its content as a Buffer. Every
// attachment postal-mime finds is one, an image shown inside the body included: the photo an
// owner sends from Apple Mail is such an image. Rejects when postal-mime can't parse the message.
export async function parseEmail(raw) {
  const email = await PostalMime.parse(raw, { attachmentEncoding: 'arraybuffer' })
  const text = typeof email.text === 'string' && email.text.trim() !== '' ? email.text : typeof email.html === 'string' ? htmlToText(email.html) : ''
  return {
    subject: typeof email.subject === 'string' ? email.subject : '',
    text: text.replace(/\r\n?/g, '\n').trim(),
    attachments: email.attachments.map(attachment => ({
      name: typeof attachment.filename === 'string' && attachment.filename !== '' ? firstChars(attachment.filename, NAME_MAX_CHARS) : null,
      mime: mimeTypeOf(attachment.mimeType),
      content: Buffer.from(attachment.content instanceof ArrayBuffer ? new Uint8Array(attachment.content) : attachment.content),
    })),
  }
}

// The subject of a header block, decoded, or "" when it has none or can't be read. For mail that is
// handed over with its headers only.
export async function parseSubject(header) {
  try {
    const email = await PostalMime.parse(header)
    return typeof email.subject === 'string' ? email.subject : ''
  } catch {
    return ''
  }
}

// The header lines of a header block, unfolded, as `{ name, value }` with the name in lower case.
// The bridge has its own, stricter reading for its sender check (`src/bridge/channels/email.mjs`).
function headerLines(header) {
  const whole = header.toString('utf8')
  const end = whole.search(/\r?\n\r?\n/)
  const text = (end === -1 ? whole : whole.slice(0, end)).replace(/\r?\n(?=[ \t])/g, '')
  const lines = []
  for (const line of text.split(/\r?\n/)) {
    const colon = line.indexOf(':')
    if (colon > 0) lines.push({ name: line.slice(0, colon).trim().toLowerCase(), value: line.slice(colon + 1) })
  }
  return lines
}

// Whether any `From` header of a header block mentions one of `addresses`, which are in lower case.
// It decides whether the reader fetches the whole message (5.6), and is looser than the bridge's
// sender check on purpose: every message that check could keep is fetched, and the check decides.
export function mentionsOwner(header, addresses) {
  return headerLines(header).some(({ name, value }) => name === 'from' && addresses.some(address => value.toLowerCase().includes(address)))
}
