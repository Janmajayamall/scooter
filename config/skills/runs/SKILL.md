---
name: runs
description: Keeps views/runs.csv, one row for each run, walk, hike, ride, swim or workout. Use it when the owner sends a screenshot from a running or fitness app (Strava, Garmin, Apple Fitness, Nike Run Club and the like) or says what exercise they did, such as "ran 5k in 28 min".
---

# Runs: `views/runs.csv`

```csv
date,time,activity,distance_km,duration,pace_per_km,avg_hr,elevation_m,note,source
```

One row per activity, under that header. The CSV rules of your instructions apply.

## The columns

- `date`, `time`: when the activity started. Take them from the app's screenshot when it shows them; otherwise from the message: "ran this morning", sent at 09:10, is today, and its time is empty.
- `activity`: what it was, one lowercase word: `run`, `walk`, `hike`, `ride`, `swim`, `strength`, `yoga`, or another the owner uses.
- `distance_km`: the distance in kilometres, with at most two decimals: `5.21`. An app that shows miles: multiply by 1.609344, and say `converted from 3.24 mi` in `note`. Empty for a workout without a distance.
- `duration`: the activity's time as `MM:SS`, or `H:MM:SS` from an hour: `27:40`, `1:05:12`. When the app shows both moving time and elapsed time, take the moving time.
- `pace_per_km`: minutes and seconds per kilometre, `M:SS`: `5:19`. Take it from the app, converting a pace per mile (divide the seconds by 1.609344), or work it out from `duration` and `distance_km`. Empty without a distance.
- `avg_hr`: the average heart rate in beats per minute, a whole number, when the app shows it.
- `elevation_m`: the elevation gained, in whole metres. Feet: multiply by 0.3048.
- `note`: the route or the place, how it went if the owner says, a conversion, or a guess, which starts the note with ❓.
- `source`: the message numbers, such as `#1061`.

## Reading screenshots

- Read the numbers from the activity's summary, not from a split or a lap.
- Two screenshots of the same activity, such as the map and the stats, are one row: both numbers go in `source`. So is a screenshot and a message about it.
- An app's own name for the activity ("Morning Run", "Evening Walk") isn't a note: say something only if it tells something.
- A number you can't read is a guess: file your best reading, mark it ❓, and ask only if it matters.
