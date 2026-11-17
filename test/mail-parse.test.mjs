// Parsing emails in the reader (5.6 of DESIGN.md; section 10, "Email"): sample emails as Gmail,
// Apple Mail and Outlook send them, HTML-only mail included, a forwarded booking and an audio
// attachment; HTML turned into text; and the reader's loose check of `From`.

import assert from 'node:assert/strict'
import test from 'node:test'
import { decodeEntities, htmlToText, mentionsOwner, mimeTypeOf, parseEmail, parseSubject } from '../src/mail/parse.mjs'
import { M4A, OWNER_ADDRESSES, OWNER_GMAIL, PDF, appleMailAudio, gmailForwardedBooking, gmailPlain, outlookHtmlOnly, stranger } from './support/mail-samples.mjs'

const headerOf = raw => raw.subarray(0, raw.indexOf('\r\n\r\n') + 4)

test('parse: a plain email from Gmail, its text from the plain part', async () => {
  const email = await parseEmail(gmailPlain())
  assert.deepEqual(email, { subject: 'Dinner at Bombay Canteen', text: 'Dinner with Sam at Bombay Canteen, ₹3,200, I paid.', attachments: [] })
})

test('parse: a booking forwarded from Gmail keeps the forwarded text, and its e-ticket is an attachment', async () => {
  const email = await parseEmail(gmailForwardedBooking())
  assert.equal(email.subject, 'Fwd: Your booking is confirmed: PNR X7Y2KQ')
  assert.match(email.text, /^Work trip\.\n\n---------- Forwarded message ---------\nFrom: Airline Reservations <reservations@airline\.example>\n/)
  assert.match(email.text, /Flight 6E 2134, Bengaluru \(BLR\) to Mumbai \(BOM\), Fri 13 Nov 2026, departs 07:15, arrives 08:55\.\nFare: ₹5,412$/)
  assert.deepEqual(email.attachments, [{ name: 'E-ticket X7Y2KQ.pdf', mime: 'application/pdf', content: PDF }])
})

test('parse: a voice memo from Apple Mail: its text, and the M4A as an attachment with its name', async () => {
  const email = await parseEmail(appleMailAudio())
  assert.equal(email.subject, 'Call with Sam')
  assert.equal(email.text, "Recording from today's call.\n\n\n\nSent from my iPhone")
  assert.deepEqual(email.attachments, [{ name: 'Call with Sam.m4a', mime: 'audio/x-m4a', content: M4A }])
})

test('parse: an HTML-only email from Outlook, in Latin-1, becomes text', async () => {
  const email = await parseEmail(outlookHtmlOnly())
  assert.deepEqual(email, { subject: 'Taxi receipt', text: 'Taxi from the airport, ₹850.\n\nCafé on the way: 120 & a tip.', attachments: [] })
})

test('parse: the subject of a header block alone, encoded words decoded, and "" when there is none', async () => {
  assert.equal(await parseSubject(headerOf(stranger())), 'Our best offers')
  assert.equal(await parseSubject(Buffer.from('From: a@example.com\r\nSubject: =?UTF-8?B?w6l0w6k=?= trip\r\n\r\n')), 'été trip')
  assert.equal(await parseSubject(Buffer.from('From: a@example.com\r\n\r\n')), '')
})

test('parse: an attachment\'s MIME type is kept when it is one, and is application/octet-stream otherwise', () => {
  assert.equal(mimeTypeOf('Audio/X-M4A'), 'audio/x-m4a')
  assert.equal(mimeTypeOf('application/vnd.openxmlformats-officedocument.wordprocessingml.document'), 'application/vnd.openxmlformats-officedocument.wordprocessingml.document')
  for (const bad of ['audio', 'text/plain; charset=utf-8', 'a/b/c', '', null, `x/${'y'.repeat(200)}`]) assert.equal(mimeTypeOf(bad), 'application/octet-stream', String(bad))
})

// ---------------------------------------------------------------------------------------------
// HTML to text

test('html: tags dropped, character references decoded, line breaks kept at block elements', () => {
  const html = [
    '<!DOCTYPE html><html><head><title>Receipt</title><style>p { color: red }</style></head>',
    '<body><h1>Your  receipt</h1><p>Caf&eacute; &amp; bar,&nbsp;&#8377;450 &#x2014; paid.</p>',
    '<div>Line one<br>Line two<br/>Line three</div>',
    '<ul><li>coffee</li><li>cake</li></ul>',
    '<table><tr><td>Total</td><td>&#8377;450</td></tr><tr><td>Tip</td><td>50</td></tr></table>',
    '<!-- a comment with <p>tags</p> --><script>var x = "<p>no</p>"</script>',
    '<p>2 &lt; 3 and a < b, &unknown; stays</p></body></html>',
  ].join('\n')
  assert.equal(
    htmlToText(html),
    ['Your receipt', '', 'Café & bar, ₹450 — paid.', '', 'Line one', 'Line two', 'Line three', '- coffee', '- cake', 'Total ₹450', 'Tip 50', '', '2 < 3 and a < b, &unknown; stays'].join('\n'),
  )
})

test('html: a comment, tag or script that never ends drops the rest, and nothing makes it slow', () => {
  assert.equal(htmlToText('<p>kept</p><!-- open'), 'kept')
  assert.equal(htmlToText('<p>kept</p><script>never closed <p>x</p>'), 'kept')
  assert.equal(htmlToText('<p>kept</p><div class="x'), 'kept')
  // Inputs that make a careless parser take time in the square of their length.
  for (const piece of ['<a', '<!--', '<script>', '&#', '<p ', '< ']) {
    const start = Date.now()
    htmlToText(piece.repeat(200_000))
    assert.ok(Date.now() - start < 2000, piece)
  }
})

test('html: character references, numeric and named, and the ones that name no character', () => {
  assert.equal(decodeEntities('&amp;&lt;&gt;&quot;&apos;&eacute;&Eacute;&euro;&hellip;&rsquo;'), '&<>"\'éÉ€…’')
  assert.equal(decodeEntities('&#65;&#x42;&#X43;&#0;&#xD800;&#1114112;'), 'ABC���')
  assert.equal(decodeEntities('&nosuch; &amp &copy2026'), '&nosuch; & &copy2026')
})

// ---------------------------------------------------------------------------------------------
// The reader's check of `From`

test('parse: the reader fetches a message whose From names an owner address, in any case and any From header', () => {
  const header = from => Buffer.from(`Subject: x\r\n${from}\r\nTo: s@example.com\r\n\r\n`)
  assert.equal(mentionsOwner(headerOf(gmailPlain()), OWNER_ADDRESSES), true)
  assert.equal(mentionsOwner(headerOf(stranger()), OWNER_ADDRESSES), false)
  assert.equal(mentionsOwner(header(`FROM: Owner <${OWNER_GMAIL.toUpperCase()}>`), OWNER_ADDRESSES), true)
  // Folded.
  assert.equal(mentionsOwner(header(`From: "Owner Example"\r\n <${OWNER_GMAIL}>`), OWNER_ADDRESSES), true)
  // Looser than the bridge's check, which then decides: several From headers, several addresses.
  assert.equal(mentionsOwner(header(`From: a@shop.example\r\nFrom: ${OWNER_GMAIL}`), OWNER_ADDRESSES), true)
  assert.equal(mentionsOwner(header(`From: a@shop.example, ${OWNER_GMAIL}`), OWNER_ADDRESSES), true)
  // An address only in another header, or in the body, doesn't count.
  assert.equal(mentionsOwner(Buffer.from(`From: a@shop.example\r\nReply-To: ${OWNER_GMAIL}\r\n\r\nFrom: ${OWNER_GMAIL}\r\n`), OWNER_ADDRESSES), false)
})
