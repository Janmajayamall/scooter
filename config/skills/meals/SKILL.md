---
name: meals
description: Keeps views/meals.csv, one row for each meal, snack or drink. Use it when the owner sends a photo of food or a drink, or says what they ate or drank, and for the meal a restaurant bill or receipt shows, which is also an expense.
---

# Meals: `views/meals.csv`

```csv
date,time,meal,description,est_kcal,place,note,source
```

One row per meal or drink, under that header. The CSV rules of your instructions apply.

## The columns

- `date`, `time`: when it was eaten. A photo sent at the table is the message's time. A meal described later takes the time the owner gives, or else is empty.
- `meal`: one of `breakfast`, `lunch`, `dinner`, `snack` or `drink`, from what it is and when.
- `description`: what it was, in a few words: `poke bowl with salmon and rice`. Name a dish as the menu or the owner does.
- `est_kcal`: your estimate of its calories, a whole number rounded to the nearest 10: `650`. It is always an estimate, from the photo, the portion and the dish, and the column's name says so; the day page writes it as `~650 kcal`. When the owner gives the number, from a label or an app, use theirs and say where it came from in `note`.
- `place`: where it was eaten: the restaurant's or café's name, `home`, `office`, or empty.
- `note`: anything else worth keeping, such as who it was with ("with Sam"), or a guess, which starts the note with ❓.
- `source`: the message numbers, such as `#1050`.

## How to file

- A photo of the food and the receipt for it are one meal: both numbers go in `source`, and the receipt is also an expense.
- A person mentioned with a meal, such as "lunch with Sam" on a food photo, stays in this row's `note`: it isn't time spent with people unless the owner tells you about the time itself.
- Coffee, tea, juice and other drinks on their own are `drink`, unless `memory/preferences.md` says otherwise.
- Estimate generously rather than not at all; an estimate that matters to the owner, such as one they ask about, is a guess to mark ❓.
