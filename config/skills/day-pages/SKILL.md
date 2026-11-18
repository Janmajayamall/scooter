---
name: day-pages
description: Keeps views/days/YYYY/MM/YYYY-MM-DD.md, one page for each of the owner's days, which links everything filed for that day - its expenses with their totals, runs, meals, travel, time with people, and notes that fit no other view. Use it whenever you add, change or remove anything in another view, and for a note about the day.
---

# Day pages: `views/days/YYYY/MM/YYYY-MM-DD.md`

One page for each day something happened, at the date it happened in the owner's time zone: `views/days/2026/11/2026-11-09.md`. The page follows the views: when you add, change or remove a row, change the page of its date to match, and when a row's date changes, move its line to the other page. A page left with nothing on it is removed.

## The template

Leave out the sections that would be empty, and keep the others in this order:

```markdown
# Monday 9 November 2026

## Expenses: ₹1,240 (+ $4.50)
| time  | what              | amount | category     | original |
|-------|-------------------|--------|--------------|----------|
| 12:40 | Blue Tokai coffee | ₹450   | Food & drink | [receipt](../../../../../../datastore/2026/11/09/1042.jpg) |

## Runs
- 07:10 · 5.2 km · 27:40 · 5:19/km

## Meals
- Lunch: poke bowl (~650 kcal)

## Travel
- Booked: ✈ 6E 2135 BLR → DEL, Sat 14 Nov 06:10, seat 12A, PNR ABC123

## People
- 20:43 · 30 min · Sam · planning the Goa trip

## Notes
- …
```

- The title is the day, written out: weekday, day, month and year.
- **Expenses:** the heading gives the day's totals, one per currency, the home currency first and the others after it in brackets, each with a `+`: `₹1,240 (+ $4.50 + €3)`. Write amounts with the currency's sign, or its code when it has none in common use, and the usual separators. The table has a row for each expense, in order of time; `what` is the merchant and what it was for, and `original` links to the receipt or the file it came from, or is empty.
- **Runs:** time · distance · duration · pace, and the activity when it isn't a run: `- 18:30 · walk · 3.1 km · 38:10`.
- **Meals:** the meal, what it was, and the estimate with `~`: `- Lunch: poke bowl (~650 kcal)`.
- **Travel:** one line per leg or stay departing that day, with a sign for its mode: ✈ flight, 🚆 train, 🚌 bus, ⛴ ferry, 🚗 car, 🏨 stay: `- ✈ 6E 2135 BLR → DEL 06:10, seat 12A, PNR ABC123`. On the day it was booked, as on the page above, the same line with `Booked:` before it and its date after the route: `- Booked: ✈ 6E 2135 BLR → DEL, Sat 14 Nov 06:10, seat 12A, PNR ABC123`.
- **People:** start · minutes · person · topic, one line per row of `people.csv`.
- **Notes:** what the owner said about the day that fits no view, one line each, with its time.

## Guesses

What is marked ❓ in a view is marked ❓ on its line here too, after the part that is a guess: `| 12:40 | Blue Tokai coffee | ₹450 | Food & drink ❓ | … |`. The totals count the guessed amounts.

## Links to attachments

From a day page, an attachment is at `../../../../../../datastore/YYYY/MM/DD/<file>`, using the folder in the attachment's path, which can differ from the page's date: a photo the prompt shows at `…/datastore/2026/11/09/1042.jpg` is linked from any page as `../../../../../../datastore/2026/11/09/1042.jpg`. An email's attachment is linked the same way, and so is the whole email, its `.eml` file.
