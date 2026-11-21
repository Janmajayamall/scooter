// Sample emails, shaped as Gmail, Apple Mail and Outlook send them, as Scooter's mailbox receives
// them: with the headers the mail goes through, the provider's `Authentication-Results` on top.
//
// Scooter's mailbox is at Gmail here, so the provider's server name is `mx.google.com`. The owner
// writes from three addresses, one for each mail app. No address here is a real one: the domains
// are the ones RFC 2606 keeps for examples.
//
// Each sample is a function that returns the message as a Buffer, with CRLF line ends as a mail
// server sends them. `headers` puts headers on top, as the provider does, and `replaceHeader`
// changes one, for the sender check's cases.

export const MAILBOX = 'scooter.inbox@example.com'
export const AUTHSERV = 'mx.google.com'
export const OWNER_GMAIL = 'owner@example.com'
export const OWNER_APPLE = 'owner@example.net'
export const OWNER_OUTLOOK = 'owner@example.org'
export const OWNER_ADDRESSES = [OWNER_GMAIL, OWNER_APPLE, OWNER_OUTLOOK]
export const STRANGER = 'offers@shop.example'

const crlf = text => Buffer.from(text.replace(/\r?\n/g, '\r\n'))

// A base64 body as mail apps write it: lines of 76 characters.
const base64 = bytes =>
  Buffer.from(bytes)
    .toString('base64')
    .replace(/.{76}/g, '$&\n')
    .trimEnd()

// The bytes of a short M4A file: an `ftyp` box and an empty `mdat`, enough to be one by its start.
export const M4A = Buffer.concat([Buffer.from('0000001c667479704d344120000000004d34412069736f6d6d703432', 'hex'), Buffer.from('000000086d646174', 'hex')])
// The bytes of a short PDF.
export const PDF = Buffer.from('%PDF-1.4\n1 0 obj << /Type /Catalog >> endobj\ntrailer << /Root 1 0 R >>\n%%EOF\n')

// What Gmail's MX writes on top of every message it receives, for a sender `from` whose domain's
// DMARC check gave `dmarc`.
export function gmailReceived({ from, dmarc = 'pass', authserv = AUTHSERV }) {
  const domain = from.split('@')[1]
  return [
    `Delivered-To: ${MAILBOX}`,
    'Received: by 2002:a05:7300:5a8c:b0:1a2:3b4c:5d6e with SMTP id k12csp2918441dyc;',
    '        Mon, 9 Nov 2026 07:42:41 -0800 (PST)',
    'ARC-Seal: i=1; a=rsa-sha256; t=1762702961; cv=none;',
    '        d=google.com; s=arc-20240605;',
    '        b=Lk9wFQ2xVb1yJf3R0aQ8zZt7Kq2mW5sN4hY6cE1uB0dP9oI8vX7rT3gA2eS5lM4n',
    `ARC-Authentication-Results: i=1; ${authserv};`,
    `       dkim=pass header.i=@${domain} header.s=s1 header.b=Ab3dEf12;`,
    `       spf=pass (google.com: domain of ${from} designates 209.85.220.41 as permitted sender) smtp.mailfrom=${from};`,
    `       dmarc=${dmarc} (p=NONE sp=QUARANTINE dis=NONE) header.from=${domain}`,
    `Return-Path: <${from}>`,
    'Received: from mail-sor-f41.google.com (mail-sor-f41.google.com. [209.85.220.41])',
    '        by mx.google.com with SMTPS id a640c23a62f3a-a9e1c2d3e4f5sor4471839.12.2026.11.09.07.42.41',
    `        for <${MAILBOX}>`,
    '        (Google Transport Security);',
    '        Mon, 09 Nov 2026 07:42:41 -0800 (PST)',
    `Received-SPF: pass (google.com: domain of ${from} designates 209.85.220.41 as permitted sender) client-ip=209.85.220.41;`,
    `Authentication-Results: ${authserv};`,
    `       dkim=pass header.i=@${domain} header.s=s1 header.b=Ab3dEf12;`,
    `       spf=pass (google.com: domain of ${from} designates 209.85.220.41 as permitted sender) smtp.mailfrom=${from};`,
    `       dmarc=${dmarc} (p=NONE sp=QUARANTINE dis=NONE) header.from=${domain}`,
  ].join('\n')
}

// A plain email from the owner's Gmail: text and HTML alternatives, quoted-printable for the rupee.
export function gmailPlain({ from = OWNER_GMAIL, dmarc = 'pass', subject = 'Dinner at Bombay Canteen', messageId = '<CAF3x9qR2pZ8mWk1y=dinner@mail.gmail.com>', date = 'Mon, 9 Nov 2026 21:12:28 +0530', body = 'Dinner with Sam at Bombay Canteen, =E2=82=B93,200, I paid.' } = {}) {
  return crlf(`${gmailReceived({ from, dmarc })}
DKIM-Signature: v=1; a=rsa-sha256; c=relaxed/relaxed;
        d=example.com; s=s1; t=1762702961; x=1763307761; darn=example.com;
        h=to:subject:message-id:date:from:mime-version:from:to:cc:subject
         :date:message-id:reply-to;
        bh=47DEQpj8HBSa+/TImW+5JCeuQeRkm5NMpJWZG3hSuFU=;
        b=Q2xV5mR8sT1uW4yZ7bC0dF3gH6jK9lM2nP5qS8tV1wX4zA7cE0fI3kN6oR9uX2yB
MIME-Version: 1.0
From: Owner Example <${from}>
Date: ${date}
Message-ID: ${messageId}
Subject: ${subject}
To: ${MAILBOX}
Content-Type: multipart/alternative; boundary="000000000000a1b2c3d4e5f60718"

--000000000000a1b2c3d4e5f60718
Content-Type: text/plain; charset="UTF-8"
Content-Transfer-Encoding: quoted-printable

${body}

--000000000000a1b2c3d4e5f60718
Content-Type: text/html; charset="UTF-8"
Content-Transfer-Encoding: quoted-printable

<div dir=3D"ltr">${body}</div>

--000000000000a1b2c3d4e5f60718--
`)
}

// A booking the owner forwards from Gmail: the forward inline, as Gmail writes it, in text and in
// HTML, and the airline's e-ticket attached.
export function gmailForwardedBooking() {
  const from = OWNER_GMAIL
  return crlf(`${gmailReceived({ from })}
MIME-Version: 1.0
References: <0102018f3a2b4c5d-booking@email.airline.example>
In-Reply-To: <0102018f3a2b4c5d-booking@email.airline.example>
From: Owner Example <${from}>
Date: Mon, 9 Nov 2026 18:20:51 +0530
Message-ID: <CAF3x9qR2pZ8mWk1y=fwd@mail.gmail.com>
Subject: Fwd: Your booking is confirmed: PNR X7Y2KQ
To: ${MAILBOX}
Content-Type: multipart/mixed; boundary="000000000000f1e2d3c4b5a60917"

--000000000000f1e2d3c4b5a60917
Content-Type: multipart/alternative; boundary="000000000000f1e2d3c4b5a60915"

--000000000000f1e2d3c4b5a60915
Content-Type: text/plain; charset="UTF-8"
Content-Transfer-Encoding: quoted-printable

Work trip.

---------- Forwarded message ---------
From: Airline Reservations <reservations@airline.example>
Date: Sun, 8 Nov 2026 at 18:04
Subject: Your booking is confirmed: PNR X7Y2KQ
To: <${from}>


Dear Owner,

Flight 6E 2134, Bengaluru (BLR) to Mumbai (BOM), Fri 13 Nov 2026, departs 07:15=
, arrives 08:55.
Fare: =E2=82=B95,412

--000000000000f1e2d3c4b5a60915
Content-Type: text/html; charset="UTF-8"
Content-Transfer-Encoding: quoted-printable

<div dir=3D"ltr"><div>Work trip.</div><br><div class=3D"gmail_quote"><div d=
ir=3D"ltr" class=3D"gmail_attr">---------- Forwarded message ---------<br>F=
rom: <strong class=3D"gmail_sendername">Airline Reservations</strong> <span=
>&lt;reservations@airline.example&gt;</span><br>Date: Sun, 8 Nov 2026 at 18=
:04<br>Subject: Your booking is confirmed: PNR X7Y2KQ<br></div><br><table><=
tr><td>Flight</td><td>6E 2134</td></tr><tr><td>Fare</td><td>&#8377;5,412</t=
d></tr></table></div></div>

--000000000000f1e2d3c4b5a60915--
--000000000000f1e2d3c4b5a60917
Content-Type: application/pdf; name="E-ticket X7Y2KQ.pdf"
Content-Disposition: attachment; filename="E-ticket X7Y2KQ.pdf"
Content-Transfer-Encoding: base64
Content-ID: <f_m4k2j9x10>
X-Attachment-Id: f_m4k2j9x10

${base64(PDF)}
--000000000000f1e2d3c4b5a60917--
`)
}

// A voice memo the owner sends from the iPhone's Mail app: an M4A attachment, as Apple Mail writes
// one, with its own boundary and folded headers.
export function appleMailAudio() {
  const from = OWNER_APPLE
  return crlf(`${gmailReceived({ from })}
Content-Type: multipart/mixed; boundary=Apple-Mail-6A1B2C3D-4E5F-4071-8293-A4B5C6D7E8F9
Content-Transfer-Encoding: 7bit
From: Owner Example <${from}>
Mime-Version: 1.0 (1.0)
Date: Mon, 9 Nov 2026 21:42:17 +0530
Subject: Call with Sam
Message-Id: <5E4F3A2B-1C0D-4E9F-8A7B-6C5D4E3F2A1B@example.net>
To: ${MAILBOX}
X-Mailer: iPhone Mail (22B83)


--Apple-Mail-6A1B2C3D-4E5F-4071-8293-A4B5C6D7E8F9
Content-Type: text/plain;
	charset=us-ascii
Content-Transfer-Encoding: 7bit

Recording from today's call.

--Apple-Mail-6A1B2C3D-4E5F-4071-8293-A4B5C6D7E8F9
Content-Type: audio/x-m4a;
	name="Call with Sam.m4a"
Content-Disposition: attachment;
	filename="Call with Sam.m4a"
Content-Transfer-Encoding: base64

${base64(M4A)}
--Apple-Mail-6A1B2C3D-4E5F-4071-8293-A4B5C6D7E8F9
Content-Type: text/plain;
	charset=us-ascii
Content-Transfer-Encoding: 7bit



Sent from my iPhone
--Apple-Mail-6A1B2C3D-4E5F-4071-8293-A4B5C6D7E8F9--
`)
}

// A receipt the owner sends from Outlook on the web: HTML only, in Latin-1, quoted-printable, with
// Outlook's own headers and a style block.
export function outlookHtmlOnly() {
  const from = OWNER_OUTLOOK
  return crlf(`${gmailReceived({ from })}
From: Owner Example <${from}>
To: "${MAILBOX}" <${MAILBOX}>
Subject: Taxi receipt
Thread-Topic: Taxi receipt
Thread-Index: AQHbMk9xVb1yJf3R0aQ8zZt7Kq2mWw==
Date: Mon, 9 Nov 2026 16:20:05 +0000
Message-ID:
 <PN3P287MB1234A1B2C3D4E5F6A7B8C9D0E1F2A@PN3P287MB1234.INDP287.PROD.OUTLOOK.COM>
Accept-Language: en-US, en-IN
Content-Language: en-US
X-MS-Has-Attach:
X-MS-TNEF-Correlator:
msip_labels:
Content-Type: text/html; charset="iso-8859-1"
Content-Transfer-Encoding: quoted-printable
MIME-Version: 1.0

<html><head>
<meta http-equiv=3D"Content-Type" content=3D"text/html; charset=3Diso-8859-=
1">
<style type=3D"text/css" style=3D"display:none;"> P {margin-top:0;margin-bo=
ttom:0;} </style>
</head>
<body dir=3D"ltr">
<div class=3D"elementToProof" style=3D"font-family: Aptos, Aptos_EmbeddedFo=
nt, Calibri, Helvetica, sans-serif; font-size: 12pt;">
Taxi from the airport, &#8377;850.</div>
<div class=3D"elementToProof"><br>
</div>
<div class=3D"elementToProof">Caf=E9 on the way: 120 &amp; a tip.</div>
</body>
</html>
`)
}

// Mail from someone who isn't the owner, as it arrives: a newsletter.
export function stranger() {
  return gmailPlain({ from: STRANGER, subject: 'Our best offers', messageId: '<offers-2026-11-09@shop.example>', body: 'Buy now.' })
}

// `raw` with `lines` added on top of its headers, as a server that receives it adds its own.
export function headers(raw, ...lines) {
  return Buffer.concat([Buffer.from(lines.map(line => `${line}\r\n`).join('')), raw])
}

// `raw` with its first header named `name` (any case) put in place by `replacement`, which may be
// several lines or none, with what follows a folded header's first line removed too.
export function replaceHeader(raw, name, replacement) {
  const text = raw.toString('latin1')
  const end = text.indexOf('\r\n\r\n')
  const head = text.slice(0, end).split('\r\n')
  const start = head.findIndex(line => line.toLowerCase().startsWith(`${name.toLowerCase()}:`))
  if (start === -1) throw new Error(`no header ${name}`)
  let stop = start + 1
  while (stop < head.length && /^[ \t]/.test(head[stop])) stop++
  head.splice(start, stop - start, ...(replacement === null ? [] : replacement.split('\n')))
  return Buffer.from(`${head.join('\r\n')}${text.slice(end)}`, 'latin1')
}
