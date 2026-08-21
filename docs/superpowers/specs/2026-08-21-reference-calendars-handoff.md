# Handoff — Real Reference Calendars (build the read/render)

**Date:** 2026-08-21
**Status:** Design approved. **Coda config table BUILT + hydrated.** Code (proxy + app) **NOT started.**
**This doc = design spec + current state + exactly what to build next.** Read it cold and you can build the feature.

---

## The feature

Replace the hardcoded `MOCK_REFS` reference overlays (US holidays / Jewish holidays / Partner / Shabbat — all fake) with **real public calendars, fetched directly**. Council manages the subscription list in a **Coda table**; the app reads it, the **proxy fetches + parses** each public `.ics` feed server-side, and the app renders them as **toggleable reference layers** (same UX as the current mock layers).

**Why direct (not via Coda):** Eric already syncs these public gCals into Coda in another doc, but that's 2–3 hops with no added value for the planning app. The calendars are public; grab them directly.

## Decisions (settled in brainstorming — don't relitigate)

1. **Curation lives in the source URL.** Hebcal's configurable feed + already-curated gCals. **No in-app filtering.**
2. **Config in a Coda table (SSOT). NO in-app admin UI** — council edits the table directly in Coda (they live in Coda anyway). The app stays **read-only**. *(This replaced Eric's original "admin modal in the app" idea — the Coda table makes it unnecessary.)*
3. **Direct `.ics` fetch via the proxy** — browser `fetch()` of `calendar.google.com` is CORS-blocked, so the Worker fetches server-side.
4. **Minimal VEVENT parser — NO `ical.js`.** Verified: Google's public `.ics` feeds contain **0 `RRULE`** (Google pre-expands recurrences into discrete dated `VEVENT`s). A ~20-line parser suffices. Keep `ical.js` in your back pocket only if some future feed turns out to use `RRULE`.

## ✅ DONE — the Coda config table

- **Doc:** `DYAz_wCVfv` (EST Mission Control). **Table:** `Reference Calendars SRC` = **`grid-vg-fRbtoyr`**, on page `section-YxOd82w5hR` (the planning page).
- **Columns** (id · name · type):
  | id | name | type |
  |---|---|---|
  | `c-f6BJXxOuPh` | Name | text (display) |
  | `c-5y0KMX4kid` | iCal URL | text* |
  | `c-TbU7TfbGJs` | Color | text (hex, e.g. `#4E9A3D`) |
  | `c-V1ScFlytvq` | Enabled | checkbox |
  | `c-vT-zpWk4fj` | Default on | checkbox |
- **10 rows hydrated** — all `Enabled=true`; `Default on=true` **only for Jewish Holidays**:
  East Side Tribe, Jewsic City, Moishe House, NowGen, Jewish Federation of Greater Nashville, NextDor, Micahnections, WES Young Professionals, The Jewish Observer, **Jewish Holidays** (Hebcal).
- \***iCal URL read note:** even though the column is "text," the API returns each cell as a `{url, name, type:"urlref"}` object. When the proxy reads rows with `useColumnNames=true&valueFormat=simpleWithArrays`, the value comes back as the URL **string** — but code defensively for both `string` and `{url}` shapes (same coercion used for `notesDocUrl` in `planningRowToEvent`).

**Council can now manage everything from Coda** — add/remove rows, edit URL/color, toggle `Enabled` / `Default on`. No app deploy needed for config changes.

## Verified technical facts

- **Public iCal URL format:** `https://calendar.google.com/calendar/ical/<CALENDAR_ID_URLENCODED>/public/basic.ics` — derived from the Coda "Public Calendar Link" (`.../embed?src=<CALENDAR_ID>`); `@` → `%40`.
- **All 10 feeds return HTTP 200 valid iCalendar. 0 `RRULE`** across tested feeds (EST 217 VEVENTs, Hebcal "Jewish Holidays" 569, Moishe 296, NowGen 58, WES 8; sparse ones: Jewsic/Fed/NextDor 5, Jewish Observer 1).
- **Micahnections "New" (@import) 404s** (no public `.ics`) → used the **old @group** feed (`5051b6…@group`, "MICAH-NECTIONS", 3 events). Note in case a better feed surfaces.
- **CORS:** browser fetch of the `.ics` is blocked → must go through the proxy.

## TO BUILD

### 1) Proxy — `proxy/src/worker.js`
Add a read-only `GET /references` endpoint (mirror the existing `/ref/:name` and `/rows` read patterns):

- Config table id: `grid-vg-fRbtoyr`. Read its rows via the existing `readAllRows(`${base}/docs/${docId}/tables/grid-vg-fRbtoyr/rows`, auth)` (uses `useColumnNames=true&valueFormat=simpleWithArrays`). Columns by name: `Name`, `iCal URL`, `Color`, `Enabled`, `Default on`.
- For each row with `Enabled` truthy:
  - Derive a **stable layer id** — slug the Name (e.g. lowercase, non-alnum→`-`) or use the Coda row id (`r.id`). Prefer a slug for readable ids, but ensure uniqueness.
  - `fetch()` the iCal URL (coerce the cell to a URL string). On non-200 / fetch error, **skip that calendar** (log + continue) so one bad feed doesn't break the rest.
  - **Parse VEVENTs** (minimal iCal):
    - Unfold folded lines first (RFC 5545: a line beginning with a space/tab continues the previous line).
    - Split on `BEGIN:VEVENT` … `END:VEVENT`.
    - Per event read `SUMMARY` and `DTSTART`:
      - All-day: `DTSTART;VALUE=DATE:YYYYMMDD` → `date = YYYY-MM-DD`, `allDay:true`.
      - Timed: `DTSTART:YYYYMMDDTHHMMSSZ` (or with TZID) → take the date part `YYYY-MM-DD` (the app renders ref events all-day anyway; time not needed for v1).
    - Unescape SUMMARY (`\,`→`,`, `\n`→space, `\;`→`;`, `\\`→`\`).
  - Emit normalized events: `{ id:<layerId>-<date>-<slugOfTitle>, source:'ref', refLayer:<layerId>, program:'oth', title, date:'YYYY-MM-DD', allDay:true, readOnly:true, status:'ref', leads:[] }` (matches `refEv()` in app.js).
- **Bound the window** — only emit events within ~6 months back … ~18 months ahead (keeps payloads sane; the app shows one program year at a time and can navigate).
- **Return** `{ layers:[{ id, name, color, defaultOn }], events:[…] }`.
- **Cache** the whole result per-isolate ~1h (like `REF_CACHE`), single global key (config is one table). Reference calendars change slowly.
- **No auth** (public data), GET only — same posture as `/rows` and `/ref`.
- Node check: `node --check proxy/src/worker.js`. Deploy: push to main (CI) or `cd proxy && npx wrangler deploy`.

### 2) App — `web/app.js` (+ `web/styles.css` if needed)
- **Make `REF_LAYERS`/`REF` dynamic.** Currently const at ~line 24–30. Change to `let`; after `/references` loads, rebuild `REF_LAYERS = layers.map(l=>({id:l.id, name:l.name, color:l.color, on:l.defaultOn}))` and `REF = Object.fromEntries(...)`, then call `renderLayers()`.
- **`DB.listReferences()`** (~line 335, currently `return MOCK_REFS.slice()`) → `const r = await fetch(PROXY_BASE+'/references'); const j = await r.json();` → set the dynamic `REF_LAYERS`/`REF` from `j.layers`, seed `state.layers` for the new ids from `defaultOn`, and **return `j.events`** (already normalized).
- **`state.layers`** (line 359) is hardcoded `{planning:true, us:true, jew:true, part:false, shab:false}`. Keep `planning:true`; **remove the mock ref keys**; add ref-layer keys dynamically from `j.layers` (`state.layers[l.id] = l.defaultOn`) when references load. Guard `renderLayers()`/`state.layers[...]` for ids that arrive async.
- **Retire `MOCK_REFS`** (~line 247) and the init cached-render path that references it (~line 1204 uses `...MOCK_REFS`). On cold load, references come from `/references` (cache a copy for instant repaint if desired).
- **Colors:** `layer.color` is a hex string; the app already interpolates `REF[refLayer].color` into `style="--c:${...}"` / `background:${...}` — hex works identically to the current CSS-var values.
- The ref-event editor view (`openEditor` for `source==='ref'`, ~line 735/739) shows `REF[refLayer].name` — works once `REF` is populated.
- Node check after edits: `node --check web/app.js`.

### Current code reference map (approx lines, `web/app.js`)
- `REF_LAYERS` + `REF`: 24–30 · `refEv()`: 246 · `MOCK_REFS`: 247 · `state` obj: 352 · `state.layers` seed: 359 · `DB.listReferences`: 335 · `loadEvents` (merges refs): 375 · `renderLayers`: 565 · layer-toggle handler: 1057 · init cached-render with MOCK_REFS: 1204.
- Proxy (`proxy/src/worker.js`): `REF_CACHE`: 27 · `/rows` GET: ~105 · `/ref/:name` REF map: 116 · `readAllRows`: 199. Slot `/references` alongside these read routes.

## Verification (do at the end)
- **Proxy:** `curl https://est-planning-proxy.eastsidetribe.workers.dev/references` → `{layers:[10], events:[many]}`, dates correct, colors present, `defaultOn` true only for Jewish Holidays.
- **App:** 10 reference-layer toggles appear (colored per hex); **Jewish Holidays starts ON**, others off; events render on the right dates; toggling a layer shows/hides its events. Sparse feeds (Jewish Observer = 1 event) are expected, not bugs.
- If any feed ever uses `RRULE`, its recurring events will be missing → add minimal `RRULE` expansion or note it.

## Suggested approach
Spec → `writing-plans` → `subagent-driven-development` (same flow as the notes-doc feature that shipped earlier this session). Small–medium size; the proxy parser is the only non-trivial bit.

## Session context you're inheriting
- **Notes-doc feature shipped** this session (Planning Notes as per-row Google Docs) + a fix for **Coda read-after-write lag** (a fresh row 404s from the buttons API ~25–45s; pack-action URL write-back lags ~50s). Branch `feat/planning-notes-google-docs` merged to `main`.
- **CI deploys now BOTH work** on push to `main`: `deploy-pages` (app) and `deploy-proxy` (Worker). Fixed by adding repo secret `CLOUDFLARE_API_TOKEN` + pinning `account_id = c68ba18b669e519e535be065dab431f1` in `proxy/wrangler.toml`. Manual `cd proxy && npx wrangler deploy` still works too.
- Local dev: `npx -y live-server web --port=8080 --no-browser` (a server may already be running on 8080).
