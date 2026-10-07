# school-lunch-calendar

Builds Apple Calendar–compatible (.ics) subscription feeds of school lunch menus from
LINQ Connect. Each school gets its own calendar with one all-day event per school day.
The event title is the main entree, and the notes list the rest of the menu.

## Feeds

| School | File | Notes |
| --- | --- | --- |
| Majestic Elementary | `majestic_elementary_lunch.ics` | Menu items by category |
| Orion Jr High | `orion_jr_high_lunch.ics` | Menu items with carbs and serving size |

Subscription URLs:

- `https://aaronmartinez6.github.io/school-lunch-calendar/majestic_elementary_lunch.ics`
- `https://aaronmartinez6.github.io/school-lunch-calendar/orion_jr_high_lunch.ics`

**iPhone / Mac (Apple Calendar):** on iPhone, Settings → Apps → Calendar → Calendar Accounts →
Add Account → Other → Add Subscribed Calendar, and paste a URL. On Mac, File → New Calendar
Subscription.

**Android (Google Calendar):** the Android app can't add a URL subscription, so do it once in a
browser. Go to calendar.google.com → Other calendars → **+** → From URL, and paste a URL. It then
syncs to the phone (if it doesn't show up, open the Google Calendar app → Settings → tap the
calendar → turn on Sync). Google decides when to refresh subscribed calendars, so updates can
take several hours to a day. For other Android calendar apps, the free app ICSx⁵ subscribes to a
URL directly and lets you choose the refresh interval.

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

LINQ Connect blocks requests from cloud servers (GitHub Actions gets HTTP 403), so the feeds are
refreshed from an iPhone instead:

1. `ios/lunch_calendar.js` is a [Scriptable](https://scriptable.app) port of
   `lunch_calendar.py`. It fetches the menus over the phone's connection, builds the same .ics
   files, and uploads them to this repo through the GitHub API. It only commits when the menus
   actually changed.
2. A Shortcuts automation runs it daily at 3:00 AM, but only when the phone is on Wi-Fi.
3. GitHub Pages serves the files from the `main` branch.

If any request fails or a school comes back with no events, the script uploads nothing and shows
a notification, so the last good feeds stay live.

**Keep the two scripts in sync.** Any change to menu formatting (titles, notes, carbs, schools,
the school-year window) must be made in both `lunch_calendar.py` and `ios/lunch_calendar.js`.
Their output is meant to be identical so subscribed calendars update in place.

### iPhone setup

1. Install Scriptable (free) and turn on iCloud for it. Copy `ios/lunch_calendar.js` into the
   Scriptable folder in iCloud Drive and name it `lunch_calendar`.
2. Create a GitHub fine-grained personal access token: Settings → Developer settings →
   Personal access tokens → Fine-grained tokens → Generate new token. Under repository access,
   choose only this repository, and under permissions set **Contents: Read and write**.
3. Run the script once inside Scriptable. It asks for the token and stores it in the iOS
   Keychain (never in this repo).
4. In Shortcuts → Automation → **+** → Time of Day: 3:00 AM, Daily, **Run Immediately**. Add
   these actions:
   - **Get Network Details** (Wi-Fi, Network Name)
   - **If** Network Details **has any value**
     - Scriptable **Run Script**: `lunch_calendar`
   - **End If**

`.github/workflows/update.yml` is kept as a manual-only fallback in case LINQ ever stops
blocking GitHub's servers. Run it from the Actions tab.

## Caveat

The data comes from LINQ Connect's **unofficial** `FamilyMenu` API. It isn't documented
or supported and could change or start blocking requests at any time. If that happens,
the update fails and the last published feeds stay in place.
