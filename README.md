# school-lunch-calendar

Builds Apple Calendar–compatible (.ics) subscription feeds of school lunch menus from
LINQ Connect. Each school gets its own calendar with one all-day event per school day.
The event title is the main entree, and the notes list the rest of the menu.

## Feeds

| School | File | Notes |
| --- | --- | --- |
| Majestic Elementary | `majestic_elementary_lunch.ics` | Menu items by category |
| Orion Jr High | `orion_jr_high_lunch.ics` | Menu items with carbs and serving size |

Subscribe in Apple Calendar (File → New Calendar Subscription, or on iPhone:
Settings → Calendar → Accounts → Add Subscribed Calendar) using:

- `https://aaronmartinez6.github.io/school-lunch-calendar/majestic_elementary_lunch.ics`
- `https://aaronmartinez6.github.io/school-lunch-calendar/orion_jr_high_lunch.ics`

## Running it

Requires Python 3.8+ and nothing outside the standard library.

```sh
python3 lunch_calendar.py                  # build every school
python3 lunch_calendar.py --school orion   # build one school (majestic or orion)
python3 lunch_calendar.py --debug          # also print serving sessions and categories found
```

Schools, the school-year window, and which categories show up in the notes are
configured at the top of `lunch_calendar.py`. Months the school hasn't published yet
return 0 days. They fill in automatically once the menus are posted.

## How it stays up to date

A scheduled GitHub Action (`.github/workflows/update.yml`) runs the script daily at
11:00 UTC and commits the .ics files when the menus change. GitHub Pages serves the
files from the `main` branch. You can also start a run by hand from the Actions tab.

## Caveat

The data comes from LINQ Connect's **unofficial** `FamilyMenu` API. It isn't documented
or supported and could change or start blocking requests at any time. If that happens,
the workflow run fails and the last published feeds stay in place.
