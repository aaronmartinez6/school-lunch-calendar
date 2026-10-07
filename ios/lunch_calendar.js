// Scriptable port of lunch_calendar.py. Fetches the LINQ Connect menus from the phone's
// connection (LINQ blocks datacenter IPs, so GitHub Actions can't do it), builds the same
// .ics files, and uploads them to the repo through the GitHub Contents API when the menus
// changed. Run daily by a Shortcuts automation; see README.md.
//
// Keep the menu formatting in sync with lunch_calendar.py: output must match byte for byte
// (apart from DTSTAMP) so subscribed calendars update in place.

const DISTRICT_ID = "d2d47bc8-c3a8-e911-bda1-ca3d28c62f37";
const API = "https://api.linqconnect.com/api/FamilyMenu";

const SCHOOLS = {
  majestic: {
    name: "Majestic Elementary Lunch",
    building_id: "4a625646-adb4-e911-bda4-cb12c2836691",
    carbs: false,
    out: "majestic_elementary_lunch.ics",
  },
  orion: {
    name: "Orion Jr High Lunch",
    building_id: "fa45749c-aeb4-e911-bda4-c9ee6993c835",
    carbs: true,
    out: "orion_jr_high_lunch.ics",
  },
};

const SESSION = "Lunch";

// School year window to request. Months the school hasn't published yet come back empty.
const YEAR_START = "2026-08-01";
const YEAR_END = "2027-06-30";
const CHUNK_DAYS = 31;

const EXCLUDE_FROM_NOTES = new Set(["milk", "condiments"]);
const TITLE_SUFFIXES = [", elementary", ", small", ", large", ", jr", ", middle school", ", high school",
                        ", hs", ", jh", ", ms", ", es"];

const HEADERS = {
  "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 " +
                "(KHTML, like Gecko) Version/17.0 Safari/605.1.15",
  "Accept": "application/json, text/plain, */*",
  "Origin": "https://linqconnect.com",
  "Referer": "https://linqconnect.com/",
};

const REPO = "aaronmartinez6/school-lunch-calendar";
const TOKEN_KEY = "school-lunch-calendar-github-token";

// ---- dates (plain YYYY-MM-DD strings, arithmetic in UTC) ----

function toDate(iso) { return new Date(iso + "T00:00:00Z"); }
function iso(d) { return d.toISOString().slice(0, 10); }
function addDays(isoStr, n) { const d = toDate(isoStr); d.setUTCDate(d.getUTCDate() + n); return iso(d); }
function compact(isoStr) { return isoStr.replace(/-/g, ""); }

function fmt(isoStr) {  // the API wants M-D-YYYY
  const [y, m, d] = isoStr.split("-").map(Number);
  return `${m}-${d}-${y}`;
}

// ---- parsing and formatting (mirrors lunch_calendar.py) ----

function carbsOf(rec) {
  for (const n of rec.Nutrients || []) {
    if ((n.Name || "").trim().toLowerCase() === "total carbohydrate") {
      if (n.HasMissingNutrients) return null;
      return [n.Value, n.Unit || "g"];
    }
  }
  return null;
}

// Returns Map<isoDate, Map<category, item[]>> for the requested serving session.
function parse(data, sessionName) {
  const days = new Map();
  for (const sess of data.FamilyMenuSessions || []) {
    const name = sess.ServingSession || "";
    if (name.trim().toLowerCase() !== sessionName.trim().toLowerCase()) continue;
    for (const plan of sess.MenuPlans || []) {
      for (const day of plan.Days || []) {
        const [m, d, y] = day.Date.split("/").map(Number);
        const key = `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
        if (!days.has(key)) days.set(key, new Map());
        const cats = days.get(key);
        for (const meal of day.MenuMeals || []) {
          for (const cat of meal.RecipeCategories || []) {
            const cname = cat.CategoryName ?? "Other";
            if (!cats.has(cname)) cats.set(cname, []);
            const items = cats.get(cname);
            for (const rec of cat.Recipes || []) {
              const n = (rec.RecipeName || "").split(/\s+/).filter(Boolean).join(" ");
              if (n && items.every(i => i.name !== n)) {
                items.push({ name: n, serving: (rec.ServingSize || "").trim(), carbs: carbsOf(rec) });
              }
            }
          }
        }
      }
    }
  }
  return days;
}

function cleanTitle(name) {
  const low = name.toLowerCase();
  for (const suf of TITLE_SUFFIXES) {
    if (low.endsWith(suf)) return name.slice(0, -suf.length).trim();
  }
  return name;
}

function isEntree(cname) {
  const low = cname.toLowerCase();
  return ["entree", "entr\u00e9e", "main"].some(k => low.includes(k));
}

function titleFor(cats) {
  for (const [cname, items] of cats) {
    if (items.length && isEntree(cname)) return "Lunch: " + cleanTitle(items[0].name);
  }
  for (const [, items] of cats) {
    if (items.length) return "Lunch: " + cleanTitle(items[0].name);
  }
  return "Lunch (menu not posted)";
}

// Python's format(x, "g"): 6 significant digits, trailing zeros dropped, exponent form
// outside 1e-4 <= |x| < 1e6.
function fmtG(x) {
  if (x === 0) return "0";
  const [mant, expStr] = x.toExponential(5).split("e");
  const exp = Number(expStr);
  const strip = s => s.includes(".") ? s.replace(/0+$/, "").replace(/\.$/, "") : s;
  if (exp < -4 || exp >= 6) {
    return `${strip(mant)}e${exp < 0 ? "-" : "+"}${String(Math.abs(exp)).padStart(2, "0")}`;
  }
  return strip(x.toFixed(Math.max(0, 5 - exp)));
}

function itemText(item, showCarbs) {
  if (!showCarbs) return item.name;
  const c = item.carbs;
  const bits = [c ? `${fmtG(c[0])}${c[1]} carbs` : "carbs n/a"];
  if (item.serving) bits.push(item.serving);
  return `${item.name} (${bits.join(", ")})`;
}

function notesFor(cats, showCarbs) {
  const lines = [];
  // entrees first, order otherwise kept (Array.prototype.sort is stable)
  const ordered = [...cats].sort((a, b) => Number(!isEntree(a[0])) - Number(!isEntree(b[0])));
  for (const [cname, items] of ordered) {
    if (!items.length || EXCLUDE_FROM_NOTES.has(cname.trim().toLowerCase())) continue;
    if (showCarbs) {
      lines.push(`${cname}:`);
      for (const i of items) lines.push(`- ${itemText(i, true)}`);
    } else {
      lines.push(`${cname}: ${items.map(i => i.name).join(", ")}`);
    }
  }
  return lines.join("\n");
}

function esc(s) {
  return s.replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,")
          .replace(/\r\n/g, "\\n").replace(/\n/g, "\\n");
}

function utf8Len(ch) {
  const c = ch.codePointAt(0);
  return c < 0x80 ? 1 : c < 0x800 ? 2 : c < 0x10000 ? 3 : 4;
}

// RFC 5545 line folding at 75 octets.
function fold(line) {
  const chars = [...line];
  if (chars.reduce((n, ch) => n + utf8Len(ch), 0) <= 75) return line;
  const out = [];
  let cur = "", curLen = 0;
  for (const ch of chars) {
    const limit = out.length ? 74 : 75;
    if (curLen + utf8Len(ch) > limit) { out.push(cur); cur = ""; curLen = 0; }
    cur += ch; curLen += utf8Len(ch);
  }
  out.push(cur);
  return out.join("\r\n ");
}

function buildIcs(days, school, now = new Date()) {
  const stamp = now.toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
  const lines = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//School Lunch Feed//EN",
                 "CALSCALE:GREGORIAN", "METHOD:PUBLISH",
                 `X-WR-CALNAME:${esc(school.name)}`,
                 "REFRESH-INTERVAL;VALUE=DURATION:PT12H", "X-PUBLISHED-TTL:PT12H"];
  for (const d of [...days.keys()].sort()) {
    const cats = days.get(d);
    if (![...cats.values()].some(items => items.length)) continue;
    lines.push(
      "BEGIN:VEVENT",
      `UID:lunch-${d}-${school.building_id.slice(0, 8)}@school-lunch-feed`,
      `DTSTAMP:${stamp}`,
      `DTSTART;VALUE=DATE:${compact(d)}`,
      `DTEND;VALUE=DATE:${compact(addDays(d, 1))}`,
      `SUMMARY:${esc(titleFor(cats))}`,
      `DESCRIPTION:${esc(notesFor(cats, school.carbs))}`,
      "TRANSP:TRANSPARENT",
      "END:VEVENT",
    );
  }
  lines.push("END:VCALENDAR");
  return lines.map(fold).join("\r\n") + "\r\n";
}

function countEvents(ics) { return (ics.match(/^BEGIN:VEVENT\r?$/gm) || []).length; }
function withoutDtstamp(ics) { return ics.split("\r\n").filter(l => !l.startsWith("DTSTAMP:")).join("\r\n"); }

// ---- the run (I/O goes through `io` so this also runs under Node for testing) ----

// Builds one school's .ics. Throws if any request fails or nothing was found, so a blocked or
// broken API never overwrites a good feed.
async function buildSchool(key, school, io) {
  io.log(`[${key}] ${school.name}`);
  const allDays = new Map();
  const failures = [];
  for (let start = YEAR_START; start <= YEAR_END; ) {
    let end = addDays(start, CHUNK_DAYS - 1);
    if (end > YEAR_END) end = YEAR_END;
    const url = `${API}?buildingId=${school.building_id}&districtId=${DISTRICT_ID}` +
                `&startDate=${fmt(start)}&endDate=${fmt(end)}`;
    try {
      const got = parse(await io.getJSON(url, HEADERS), SESSION);
      for (const [d, cats] of got) allDays.set(d, cats);
      io.log(`  ${start} to ${end}: ${got.size} days`);
    } catch (e) {
      failures.push(`${start}: ${e.message || e}`);
      io.log(`  ${start} to ${end}: failed (${e.message || e})`);
    }
    start = addDays(end, 1);
  }
  if (failures.length) throw new Error(`${school.name}: ${failures.length} request(s) failed, first: ${failures[0]}`);
  const ics = buildIcs(allDays, school);
  if (!countEvents(ics)) throw new Error(`${school.name}: no events found`);
  io.log(`  built ${school.out} with ${countEvents(ics)} events`);
  return ics;
}

async function github(io, token, method, path, body) {
  return io.request(method, `https://api.github.com/repos/${REPO}/contents/${path}`, {
    "Authorization": `Bearer ${token}`,
    "Accept": "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "school-lunch-calendar",
  }, body);
}

// Uploads the file if its menus differ from what's on main. Returns true if it committed.
async function upload(io, token, path, ics, force = false) {
  const cur = await github(io, token, "GET", `${path}?ref=main`);
  if (cur.status !== 200) throw new Error(`GitHub GET ${path}: HTTP ${cur.status}`);
  const old = io.fromBase64(cur.json.content.replace(/\n/g, ""));
  if (!force && withoutDtstamp(old) === withoutDtstamp(ics)) {
    io.log(`  ${path}: no menu changes`);
    return false;
  }
  const put = await github(io, token, "PUT", path, {
    message: "Update lunch calendars", content: io.toBase64(ics), sha: cur.json.sha, branch: "main",
  });
  if (put.status !== 200) throw new Error(`GitHub PUT ${path}: HTTP ${put.status}`);
  io.log(`  ${path}: committed`);
  return true;
}

// Builds every school first and uploads only if all of them succeeded.
async function run(io, token, { dryRun = false, force = false } = {}) {
  const built = [];
  for (const [key, school] of Object.entries(SCHOOLS)) built.push([school.out, await buildSchool(key, school, io)]);
  if (dryRun) return { built, changed: [] };
  const changed = [];
  for (const [path, ics] of built) if (await upload(io, token, path, ics, force)) changed.push(path);
  return { built, changed };
}

// ---- Scriptable entry point ----

function scriptableIO() {
  return {
    log: s => console.log(s),
    async getJSON(url, headers) {
      const req = new Request(url);
      req.headers = headers;
      req.timeoutInterval = 30;
      const text = await req.loadString();
      const status = req.response.statusCode;
      if (status !== 200) throw new Error(`HTTP ${status}`);
      return JSON.parse(text);
    },
    async request(method, url, headers, body) {
      const req = new Request(url);
      req.method = method;
      req.headers = body ? { ...headers, "Content-Type": "application/json" } : headers;
      if (body) req.body = JSON.stringify(body);
      req.timeoutInterval = 60;
      const text = await req.loadString();
      let json = null;
      try { json = JSON.parse(text); } catch (e) { /* non-JSON error body */ }
      return { status: req.response.statusCode, json };
    },
    toBase64: s => Data.fromString(s).toBase64String(),
    fromBase64: b => Data.fromBase64String(b).toRawString(),
  };
}

async function getToken() {
  if (Keychain.contains(TOKEN_KEY)) return Keychain.get(TOKEN_KEY);
  if (!config.runsInApp) throw new Error("No GitHub token saved. Run the script once in the Scriptable app.");
  const a = new Alert();
  a.title = "GitHub token";
  a.message = `Paste a fine-grained token with Contents read/write on ${REPO}. It's stored in the iOS Keychain.`;
  a.addSecureTextField("github_pat_...");
  a.addAction("Save");
  a.addCancelAction("Cancel");
  if (await a.present() === -1) throw new Error("Cancelled");
  const token = a.textFieldValue(0).trim();
  if (!token) throw new Error("No token entered");
  Keychain.set(TOKEN_KEY, token);
  return token;
}

async function notify(title, body) {
  const n = new Notification();
  n.title = title;
  n.body = body;
  await n.schedule();
}

if (typeof Script !== "undefined") {
  (async () => {
    try {
      const { changed } = await run(scriptableIO(), await getToken());
      const msg = changed.length ? `Updated ${changed.join(", ")}` : "No menu changes";
      console.log(msg);
      if (config.runsInApp) await notify("Lunch calendars", msg);
      Script.setShortcutOutput(msg);
    } catch (e) {
      console.error(e);
      await notify("Lunch calendar update failed", String(e.message || e));
      Script.setShortcutOutput(`ERROR: ${e.message || e}`);
    }
    Script.complete();
  })();
} else if (typeof module !== "undefined") {
  module.exports = { SCHOOLS, parse, buildIcs, buildSchool, run, fmtG, fold, withoutDtstamp, countEvents };
}
