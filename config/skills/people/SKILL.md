---
name: people
description: Keeps views/people.csv, the time the owner spends with people and what it was about, one row per person. Use it only when the owner tells you about time spent with someone, such as "spent the past 30 minutes with Sam planning the Goa trip", not for a person mentioned in passing.
---

# People: `views/people.csv`

```csv
date,start,minutes,person,topic,note,source
```

One row per person, under that header, so an hour with two people is two rows with the same `start` and `minutes`. The CSV rules of your instructions apply.

## The columns

- `date`, `start`: when it began, worked out from the message time: "for the past 30 minutes", sent at 21:13, started at 20:43. If no start can be worked out, leave `start` empty rather than ask.
- `minutes`: how long it lasted, in whole minutes: an hour is `60`.
- `person`: who it was with, one person per row.
- `topic`: what it was about, in a few words: `planning the Goa trip`.
- `note`: anything else worth keeping, such as the place, or a guess, which starts the note with ❓.
- `source`: the message numbers, such as `#1061`.

## When to add rows

- Add rows only when the owner tells you about time spent with someone. A person mentioned in passing, such as "lunch with Sam" on a food photo, stays in that entry: in the meal's note, not here.
- Write each person's name the same way every time: look at the rows already there, and use the name they use. When a name could mean two people, such as two friends called Sam, file your best guess, mark it ❓, and ask; once the owner says, write that person's name so it tells them apart from then on.
- Ask when the length is missing: leave `minutes` empty, mark the row ❓, and ask how long it was.
