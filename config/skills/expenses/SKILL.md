---
name: expenses
description: Keeps views/expenses.csv, one row for each expense. Use it for anything the owner paid, or owes for, whatever its form - a receipt or a bill, a payment screenshot, an invoice by email, a note such as "coffee 150" - and for the cost of a restaurant meal, a ticket or a booking, which are also meals or travel.
---

# Expenses: `views/expenses.csv`

```csv
date,time,merchant,description,amount,currency,category,payment,split,note,source
```

One row per expense, under that header. The CSV rules of your instructions apply: quote fields that contain commas, and keep the rows sorted by date and time.

## The columns

- `date`, `time`: when it was paid, from the receipt. A receipt without a time takes the message's time if it was sent the same day; otherwise leave `time` empty.
- `merchant`: who was paid, by the name people use: `Blue Tokai`, not `BLUE TOKAI COFFEE ROASTERS PVT LTD`. The same merchant is written the same way every time.
- `description`: what it was for, in a few words: `coffee and a croissant`.
- `amount`: the total paid, exactly as shown: the grand total, with tax, service and tip, as a plain number (`1240.50`). A refund is negative.
- `currency`: the currency's ISO code: `INR`, `USD`, `EUR`, `GBP`. Read it from the receipt's sign or code. A text without one is in the home currency. A `$` that could be more than one currency is a guess: mark it ❓ if the place doesn't settle it.
- `category`: one of `Food & drink`, `Groceries`, `Transport`, `Travel`, `Shopping`, `Bills`, `Health`, `Entertainment`, `Work`, `Other`, written exactly so. `Transport` is getting around where the owner is (rides, fuel, parking, a metro card); `Travel` is a trip's tickets and stays. Add a new category only when the owner asks, and add their instruction to `memory/preferences.md`.
- `payment`: how it was paid, when the receipt shows it or the owner says: `cash`, `card`, `UPI`, `HDFC card 1234`. Never more of a card's number than its last four digits.
- `split`: empty when the owner paid for themselves alone. Otherwise who shared it and the owner's part, in words: `with Sam, half`, `with Sam and Priya, a third each`, `with Sam, mine 400`. See below.
- `note`: anything else worth keeping, short. A guess starts it with ❓.
- `source`: the message numbers, such as `#1050`.

## Splits

- "split with Sam" means the owner paid the whole bill and shares it equally: `amount` is the whole bill, and `split` is `with Sam, half`.
- When the shares aren't equal, `split` gives the owner's own part: `with Sam, mine 400`.
- When someone else paid and the owner owes them their part, `amount` is the owner's part, `payment` is `owed to Sam`, and `split` is `Sam paid 1200`.
- Settling up changes the row it settles, and adds no row: when the owner pays back what they owed, `payment` becomes `paid Sam back`; when someone pays the owner back, `note` says `Sam paid back 600`. Either way the message joins the row's `source`.
- Whether something was split matters: when you can't tell, guess, mark it ❓ and ask.

## Reading receipts

- Take the total the owner paid, not a subtotal. A handwritten tip counts.
- One photo with several receipts is one row for each.
- A receipt and a message about it ("that was for work") are one row: both numbers go in `source`.
- A restaurant bill is also a meal, and a ticket or a booking also travel: file each in its own view, with the same `source`.
- An amount you can't read is a guess too: file your best reading, mark it ❓, and ask.
