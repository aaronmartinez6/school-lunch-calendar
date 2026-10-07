#!/usr/bin/env python3
"""Build .ics calendar feeds of school lunch menus from LINQ Connect.

Usage:
    python3 lunch_calendar.py                    # builds every school below
    python3 lunch_calendar.py --school orion     # just one school
    python3 lunch_calendar.py --debug            # also prints sessions/categories found

Standard library only (Python 3.8+).
"""
import argparse
import json
import urllib.request
from datetime import date, datetime, timedelta, timezone

DISTRICT_ID = "d2d47bc8-c3a8-e911-bda1-ca3d28c62f37"
API = "https://api.linqconnect.com/api/FamilyMenu"

# One entry per school. Add more here if you ever need them.
SCHOOLS = {
    "majestic": {
        "name": "Majestic Elementary Lunch",
        "building_id": "4a625646-adb4-e911-bda4-cb12c2836691",
        "carbs": False,
        "out": "majestic_elementary_lunch.ics",
    },
    "orion": {
        "name": "Orion Jr High Lunch",
        "building_id": "fa45749c-aeb4-e911-bda4-c9ee6993c835",
        "carbs": True,
        "out": "orion_jr_high_lunch.ics",
    },
}

SESSION = "Lunch"

# School year window to request. Months the school hasn't published yet come back empty.
YEAR_START = date(2026, 8, 1)
YEAR_END = date(2027, 6, 30)
CHUNK_DAYS = 31

# Categories left out of the event notes (the title still uses the entree).
EXCLUDE_FROM_NOTES = {"milk", "condiments"}
# Trailing text trimmed from the title, e.g. "Bacon Cheeseburger, Elementary".
TITLE_SUFFIXES = (", elementary", ", small", ", large", ", jr", ", middle school", ", high school",
                  ", hs", ", jh", ", ms", ", es")

HEADERS = {
    "User-Agent": ("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 "
                   "(KHTML, like Gecko) Version/17.0 Safari/605.1.15"),
    "Accept": "application/json, text/plain, */*",
    "Origin": "https://linqconnect.com",
    "Referer": "https://linqconnect.com/",
}


def fmt(d):  # the API wants M-D-YYYY
    return f"{d.month}-{d.day}-{d.year}"


def fetch(building_id, start, end):
    url = (f"{API}?buildingId={building_id}&districtId={DISTRICT_ID}"
           f"&startDate={fmt(start)}&endDate={fmt(end)}")
    req = urllib.request.Request(url, headers=HEADERS)
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.load(r)


def carbs_of(rec):
    """Return (value, unit) for Total Carbohydrate, or None if the item has no carb data."""
    for n in rec.get("Nutrients") or []:
        if (n.get("Name") or "").strip().lower() == "total carbohydrate":
            if n.get("HasMissingNutrients"):
                return None
            return n.get("Value"), n.get("Unit") or "g"
    return None


def parse(data, session_name, debug=False):
    """Return {date: {category: [item dicts]}} for the requested serving session."""
    days = {}
    for sess in data.get("FamilyMenuSessions") or []:
        name = sess.get("ServingSession", "")
        if debug:
            print(f"  session: {name}")
        if name.strip().lower() != session_name.strip().lower():
            continue
        for plan in sess.get("MenuPlans") or []:
            for day in plan.get("Days") or []:
                m, d, y = (int(x) for x in day["Date"].split("/"))
                cats = days.setdefault(date(y, m, d), {})
                for meal in day.get("MenuMeals") or []:
                    for cat in meal.get("RecipeCategories") or []:
                        cname = cat.get("CategoryName", "Other")
                        if debug:
                            print(f"    category: {cname}")
                        items = cats.setdefault(cname, [])
                        for rec in cat.get("Recipes") or []:
                            n = " ".join((rec.get("RecipeName") or "").split())
                            if n and all(i["name"] != n for i in items):
                                items.append({
                                    "name": n,
                                    "serving": (rec.get("ServingSize") or "").strip(),
                                    "carbs": carbs_of(rec),
                                })
    return days


def clean_title(name):
    low = name.lower()
    for suf in TITLE_SUFFIXES:
        if low.endswith(suf):
            return name[: -len(suf)].strip()
    return name


def title_for(cats):
    """Use the first main entree as the event title (alternates go in the notes)."""
    for cname, items in cats.items():
        if items and is_entree(cname):
            return "Lunch: " + clean_title(items[0]["name"])
    for cname, items in cats.items():  # fallback: first non-empty category
        if items:
            return "Lunch: " + clean_title(items[0]["name"])
    return "Lunch (menu not posted)"


def item_text(item, show_carbs):
    if not show_carbs:
        return item["name"]
    c = item["carbs"]
    bits = [f"{c[0]:g}{c[1]} carbs" if c else "carbs n/a"]
    if item["serving"]:
        bits.append(item["serving"])
    return f"{item['name']} ({', '.join(bits)})"


def is_entree(cname):
    return any(k in cname.lower() for k in ("entree", "entr\u00e9e", "main"))


def notes_for(cats, show_carbs):
    lines = []
    ordered = sorted(cats.items(), key=lambda kv: not is_entree(kv[0]))  # entrees first, order otherwise kept
    for cname, items in ordered:
        if not items or cname.strip().lower() in EXCLUDE_FROM_NOTES:
            continue
        if show_carbs:
            lines.append(f"{cname}:")
            lines += [f"- {item_text(i, True)}" for i in items]
        else:
            lines.append(f"{cname}: {', '.join(i['name'] for i in items)}")
    return "\n".join(lines)


def esc(s):
    return (s.replace("\\", "\\\\").replace(";", "\\;").replace(",", "\\,")
             .replace("\r\n", "\\n").replace("\n", "\\n"))


def fold(line):
    """RFC 5545 line folding at 75 octets."""
    b = line.encode("utf-8")
    if len(b) <= 75:
        return line
    out, cur = [], b""
    for ch in line:
        cb = ch.encode("utf-8")
        limit = 75 if not out else 74
        if len(cur) + len(cb) > limit:
            out.append(cur.decode("utf-8"))
            cur = b""
        cur += cb
    out.append(cur.decode("utf-8"))
    return "\r\n ".join(out)


def build_ics(days, school):
    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    lines = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//School Lunch Feed//EN",
             "CALSCALE:GREGORIAN", "METHOD:PUBLISH",
             f"X-WR-CALNAME:{esc(school['name'])}",
             "REFRESH-INTERVAL;VALUE=DURATION:PT12H", "X-PUBLISHED-TTL:PT12H"]
    for d in sorted(days):
        cats = days[d]
        if not any(cats.values()):
            continue
        lines += [
            "BEGIN:VEVENT",
            f"UID:lunch-{d.isoformat()}-{school['building_id'][:8]}@school-lunch-feed",
            f"DTSTAMP:{stamp}",
            f"DTSTART;VALUE=DATE:{d.strftime('%Y%m%d')}",
            f"DTEND;VALUE=DATE:{(d + timedelta(days=1)).strftime('%Y%m%d')}",
            f"SUMMARY:{esc(title_for(cats))}",
            f"DESCRIPTION:{esc(notes_for(cats, school['carbs']))}",
            "TRANSP:TRANSPARENT",
            "END:VEVENT",
        ]
    lines.append("END:VCALENDAR")
    return "\r\n".join(fold(l) for l in lines) + "\r\n"


def run_school(key, school, debug):
    if school["building_id"].startswith("PASTE"):
        print(f"[{key}] skipped: building ID not set in SCHOOLS")
        return
    print(f"[{key}] {school['name']}")
    all_days = {}
    start = YEAR_START
    while start <= YEAR_END:
        end = min(start + timedelta(days=CHUNK_DAYS - 1), YEAR_END)
        try:
            got = parse(fetch(school["building_id"], start, end), SESSION, debug)
            all_days.update(got)
            print(f"  {start} to {end}: {len(got)} days")
        except Exception as e:
            print(f"  {start} to {end}: failed ({e})")
        start = end + timedelta(days=1)
    with open(school["out"], "w", encoding="utf-8", newline="") as f:
        f.write(build_ics(all_days, school))
    n = sum(1 for c in all_days.values() if any(c.values()))
    print(f"  wrote {school['out']} with {n} events")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--school", default="all", choices=["all", *SCHOOLS])
    ap.add_argument("--debug", action="store_true")
    a = ap.parse_args()
    for key, school in SCHOOLS.items():
        if a.school in ("all", key):
            run_school(key, school, a.debug)


if __name__ == "__main__":
    main()
