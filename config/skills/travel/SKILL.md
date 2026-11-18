---
name: travel
description: Keeps views/travel.csv, one row for each leg of a journey and each stay - flights, trains, buses, ferries, hotels. Use it for tickets, boarding passes, booking confirmations (often forwarded by email), itinerary changes and cancellations, and when the owner says they are travelling somewhere.
---

# Travel: `views/travel.csv`

```csv
date,depart_time,from,to,mode,carrier,number,seat,booking_ref,arrive,note,source
```

One row per leg, under that header. The CSV rules of your instructions apply.

## The columns

- `date`: the day the leg departs, at the place it departs from.
- `depart_time`: when it departs, `HH:MM`, as the ticket prints it, which is the local time where it departs.
- `from`, `to`: where it departs and arrives. A flight by the airports' codes (`BLR`, `DEL`); a train by the stations' codes or names, as the ticket gives them; otherwise the place's name.
- `mode`: `flight`, `train`, `bus`, `ferry`, `car` (a hired car or a cab between cities), or `stay` (below).
- `carrier`: the airline, railway or company: `IndiGo`, `Indian Railways`.
- `number`: the flight's or the train's number: `6E 2135`, `12951`.
- `seat`: the seat: `12A`; on a train the coach and berth: `B2 34`.
- `booking_ref`: the PNR, booking reference or confirmation number: `ABC123`.
- `arrive`: when it arrives, `HH:MM` local where it arrives, or `YYYY-MM-DD HH:MM` when that is another day than `date`.
- `note`: the class, a terminal or a platform, a change or a cancellation, or a guess, which starts the note with ❓.
- `source`: the message numbers, such as `#1052`.

## Legs, stays and bookings

- One row per leg: a return trip is two rows, and a flight with a connection is a row for each flight, with the same `booking_ref`. A ticket for several people is one row per leg; the people go in `note` if it names others than the owner.
- A stay at a hotel, or any place booked to sleep, is a row with `mode` `stay`: `date` is the day of check-in, `depart_time` the check-in time if given, `from` empty, `to` the town, `carrier` the place's name, `number` empty, `seat` the room if given, `booking_ref`, and `arrive` the day of check-out, with its time if given.
- Getting around where the owner is, such as a cab across town, isn't travel: it is only an expense.
- The price of a ticket or a stay is also an expense, dated the day it was paid, with the category `Travel`.
- A journey goes on the page of the day it departs, and the day it was booked gets a "booked" line (the day-pages skill).
- A change, such as a new time or seat, updates the row, and its message joins `source`. A cancellation keeps the row, with `cancelled` in `note`, and its message in `source`.
- Before adding a row, look for the same `booking_ref` and leg: a ticket that arrives twice, once on WhatsApp and once by email, is one row.
