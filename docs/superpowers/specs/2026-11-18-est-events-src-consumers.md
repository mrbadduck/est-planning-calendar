# EST Events SRC: schema, consumers and backfill survey

Read-only survey of Mission Control (`DYAz_wCVfv`), 2026-11-18. No writes were made.
Method: `table_columns_read` / `content_read` (tables + formulas + controls) on every canvas page,
scanned for `grid-9TAt5vMMKH`; `formula_execute` for counts. Coda automations (rules) are not
exposed by the MCP, so they come from the 2026-11-14 audit (`~/Documents/personal/est-integration-audit-findings.md`).

Shorthand in formulas: `[Col]` = a column ref, `<Table>` = a table ref.

---

## 1. Schema of `EST Events SRC` (`grid-9TAt5vMMKH`, page "EST Data" `section-a5aJ5Kt0-P`, 238 rows, 41 columns)

Kind: **DATA** = hand-entered (must be backfilled), **DATA*** = hand-entered but has a default formula
(value was frozen in at row creation, so it's real data now), **F** = formula (recreate or drop),
**BTN** = button, **PACK** = pack result stored by a button.

| # | Column | Id | Type | Kind | Formula / default | What it does |
|---|---|---|---|---|---|---|
| 1 | Event Name (display) | c-YcC1vx5Ung | text | DATA* | default: EB event Name, else gCal Summary | Event title. Eventbrite-sourced names carry a "(M/D/YYYY)" suffix |
| 2 | Eventbrite Event | c-LvlbW7Fk28 | lookup → Events EVENTBRITE (sync, single) | DATA* | default: `[gCal Event].[Eventbrite Event]` | The link to the synced Eventbrite event. Key to most metrics |
| 3 | gCal Event | c-kYWGuRBYdC | lookup → Events GCAL (sync, single) | DATA | — | Link to the synced Google Calendar event |
| 4 | gCal Event Start | c-XMXIMWz6Yi | datetime | F | `[gCal Event].[Start]` | display |
| 5 | Venue Host(s) | c-Oaw5hxQt1e | lookup → People | F | `[Venue].[Related People (Hosts)].ListCombine()` (stale default refs a deleted gCal "Host(s)" column) | Hosts via venue |
| 6 | Venue | c-qnAUWGhhWe | lookup → EST Venues SRC (multi) | DATA | — | Venue(s). 3 rows have >1 venue |
| 7 | Collaborators | c-v8SaE7WTNb | lookup → EST Collaborators SRC (multi) | DATA | — | Partner orgs |
| 8 | Cancelled? | c-kZqi1huBiz | checkbox | DATA | default false | Excluded from metrics, disables Slack buttons |
| 9 | Event Date (for Metrics) | c-FNeOszspAw | date | DATA* | default: EB Start, else gCal Start | **The** date every metric filters on |
| 10 | Eventbrite Event All Orders | c-xKNdytBSi6 | lookup → Orders EVENTBRITE | F | `[Eventbrite Event].[All Orders]` | |
| 11 | Eventbrite Event Num Tickets | c-lGjEbLFCDd | number | F | if no EB or override set → `[Num Attendees (Manual Override)]`, else Σ order Attendees | Attendance used by metrics |
| 12 | Volunteers | c-K8QqK9dNsv | lookup → People (multi) | DATA | — | |
| 13 | Leads | c-Gp18FBaE8q | lookup → People (multi) | DATA* | default: `[Program(s)].[Current Leads]` | Event leads. Note: default copies the program's *current* leads at row creation, so some history may be "whoever led the program then", not true event leads |
| 14 | Eventbrite Event Num Orders | c-JZWixU_1CZ | number | F | same override pattern, count of orders | |
| 15 | Metrics Reporting Periods | c-EqFQVRrk-G | lookup → Quarterly Metrics SRC | F | reverse of `Quarterly Metrics.[Events EST]` | |
| 16 | Num First Timers | c-P5n4yYWUON | number | F | `[Eventbrite Event].[First Timers].Count()` | |
| 17 | First Timers EST | c-yaEsMKxlFT | lookup → People | F | People whose `Eventbrite First Event` = this EB event | used by Post-Event Slack reminder |
| 18 | Collab Event | c-wyhI1B79wV | checkbox | F | `[Collaborators].IsNotBlank()` | |
| 19 | Min Leadership Wave | c-79kf_Nh2hP | lookup → Leadership Wave ENUM | F | min wave of `[Leads]` | "3rd wave led" metric |
| 20 | Num Attendees (Manual Override) | c-LHDV30AIeI | number | DATA | — | Attendance when not on EB (3 rows set) |
| 21 | Description | c-hBeyAS0x1E | text | F | `[gCal Event].[Description]` | |
| 22 | Eventbrite Id | c-sLsqeZ0_zh | text | F | `[Eventbrite Event].[Eventbrite Id]` | |
| 23 | gCal Event Id | c-qFF9aveinM | text | F | `[gCal Event].[gCal Event Id]` | |
| 24 | gCal Event End | c-rhWkvJ_aS3 | datetime | F | `[gCal Event].[End]` | |
| 25 | Banner Image Override | c--RGP1jqmMp | image attachments | DATA | — | 1 row set |
| 26 | Banner Image Override URL | c-psY652Cl5V | url | F | publicUrl of the override | |
| 27 | Registration URL Override | c-2-8FNMkNKQ | url | DATA | — | 1 row set |
| 28 | Banner image | c-aNR6WCYUgj | image | F | override, else EB Image | (website-feed-shaped) |
| 29 | Program(s) | c-43WF5l9MHf | lookup → EST Programs SRC (multi) | DATA | — | 4 rows have >1 program |
| 30 | gCal Event URL | c-oZRa5e7QwF | url | F | `[gCal Event].[Url]` | |
| 31 | Eventbrite Event URL | c-JHG92fOFt0 | url | F | `[Eventbrite Event].[Url]` | |
| 32 | Create/Update gCal | c-4Ia85rhSnv | button | BTN | GCal pack `CreateEvent` (stores result in col 33) or `UpdateEvent` from Event Name/Start/End/Event Description | Manual gCal push for events not on EB |
| 33 | gCal Create Event Result | c-S2OgPUG8B8 | pack object (gCal Event) | PACK | written by col 32 | 154 rows set |
| 34 | Event Start | c-Dx4hZN7o83 | datetime | DATA* | default: gCal result Start, else Event Date + 18:00 | |
| 35 | Event End | c-0pwRaIBqeA | datetime | DATA* | default: gCal result End, else Event Date + 20:00 | |
| 36 | Event Description | c-veXmap6hVO | text | DATA* | default: gCal result Description | 100 rows set |
| 37 | Eventbrite Ticket Revenue | c-mVRXbUxdkt | currency | F | `[Eventbrite Event].[Ticket Revenue]` | |
| 38 | Event Photos | c-diN53OflnB | file attachments | DATA | — | 1 row set |
| 39 | Pre-Event Slack Reminder | c-UQxyJCobTC | button | BTN | Slack `PostMessage` with Templates row `i-EzQ4eZv2p3`, args Event Name, Num Tickets, Num Orders, EB Id; channel = first `[Program(s)].[Slack channel]`, else a default channel. Disabled if Cancelled | |
| 40 | Post-Event Slack Reminder | c-gwzURXxQXm | button | BTN | Slack `PostMessage` with Templates row `i-TAUUk6kvci`, args Name, Tickets, Orders, Num First Timers, expense-form URL, bullet list of First Timers EST (name + emails); same channel logic | |
| 41 | Event Discount Config | c-4WnsRvg0d_ | lookup → Event Discount Config SRC | F | reverse of `Event Discount Config SRC.[Event]` | 6 rows have one |

Buttons are posted by hand (no rule found that presses them; Slack posts use Eric's Slack connection).
The table's only view in the doc besides the base is **"EST Event Details & Metrics"** on the Events
page (`section-7kqlKiaYSm`, `table-ES515Pl6Uv`, filter `Cancelled? = false`, 218 rows) — the
human-facing events list.

---

## 2. Consumers of `EST Events SRC`

### 2a. Direct references (formula, lookup target, button or control references `grid-9TAt5vMMKH`)

| # | Table (id) | Column (id) | Kind | Formula (short) | Computes |
|---|---|---|---|---|---|
| 1 | EST People SRC (grid-X316Eql8dE) | Events Led EST (c-GKokVg55Il) | F | `<EST Events SRC>.Filter([Leads].Contains(thisRow))` | events led |
| 2 | EST People SRC | Events Volunteered EST (c-NinGx1Crlj) | F | `<EST Events SRC>.Filter([Volunteers].Contains(thisRow))` | events volunteered |
| 3 | EST People SRC | Events Hosted (c-FI0RjFLZme) | F | `[Host Venue(s)].[EST Events].ListCombine()` (via Venues #6) | events at venues they host |
| 4 | EST People SRC | Last Host Date (c-jYJ5FDGjfV) | F | `[Events Hosted].MaxBy([Event Date (for Metrics)])...` | |
| 5 | EST Venues SRC (grid-foC40iAOaX) | EST Events (c-Wn6h-NPs7Y) | F | `<EST Events SRC>.Filter([Venue].Contains(thisRow))` | events per venue |
| 6 | EST Venues SRC | Last Event Date (c-6p8rt5mA6d) | F | `[EST Events].[Event Date (for Metrics)].Max()` | |
| 7 | EST Programs SRC (grid-g87NFbtqN8) | EST Events (c-BNuoz20ZXe) | F | `<EST Events SRC>.Filter([Program(s)].Contains(thisRow))` | events per program |
| 8 | EST Programs SRC | Last Event Date (c-TnVHY43R-D) | F | max past `[Event Date (for Metrics)]` | |
| 9 | EST Programs SRC | Next Event Date (c-i1lm-0b_bc) | F | min future date | |
| 10 | EST Programs SRC | Average Tickets per Event (Last 12 Months) (c-QW--RRDNDc) | F | avg `[Eventbrite Event Num Tickets]`, last 12 months | |
| 11 | EST Programs SRC | Average Tickets per Event (Last 5 Events) (c-1u6GL0WHMb) | F | avg tickets, last 5 | |
| 12 | EST Collaborators SRC (grid-doJSi_vI5V) | Collab EST Events (c-PwfoBamijb) | F | `<EST Events SRC>.Filter([Collaborators].Contains(thisRow))` | |
| 13 | Quarterly Metrics SRC (grid-N3FOKZyUO8) | Events EST (c-EsMAtXS2WX) | F | `<EST Events SRC>.Filter([Event Date (for Metrics)] between First Date and YTD Date/Last Date AND Cancelled? != true AND date < Today())` | **the root of all event metrics** |
| 14 | Quarterly Metrics SRC | Total Orders (c-G_SeNP50lA) | F | Σ `[Events EST].[Eventbrite Event Num Orders]` | |
| 15 | Quarterly Metrics SRC | Collab Events (c-Rj8fRs_twD) | F | CountIf `[Collab Event]` | |
| 16 | Quarterly Metrics SRC | 3rd Wave Led Events (c-lIAOTtBddM) | F | CountIf `[Min Leadership Wave].WaveNum >= 3` | |
| 17 | Quarterly Metrics SRC | Total Tickets (c-t_fFNrjZIU) | F | Σ `[Eventbrite Event Num Tickets]` | |
| 18 | Quarterly Metrics SRC | Registrants (c-kGUOZiriMt) | F | People whose orders' EB event ∈ `[Events EST].[Eventbrite Event]` | |
| 19 | Quarterly Metrics SRC | First Time Registrants (c-wdx7WH_JfY) | F | Σ `[Num First Timers]` | |
| 20 | Quarterly Metrics SRC | Ticket Sales Revenue (c-Ca6HNeo4-H) | F | Σ `[Eventbrite Ticket Revenue]` | |
| 21 | Events EVENTBRITE (grid-sync-20456-Event) | EST Event (c-I4457rgIZX) | F | `<EST Events SRC>.Filter([Eventbrite Event].Contains(thisRow))` | reverse link |
| 22 | Events EVENTBRITE | Add EST Event (c-3_RMoMkXsD) | BTN | `AddOrModifyRows(<EST Events SRC>, …Eventbrite Event, Event Name, Event Date (for Metrics), gCal Event)`; disabled if linked | **the importer** that creates EST Events rows |
| 23 | Events EVENTBRITE | EST Program(s) (c-R51iXXYxx5) | F | `[EST Event].[Program(s)].ListCombine()` | program of an EB event (feeds People/Programs) |
| 24 | Events GCAL (grid-sync-1003-Event) | EST Event (c-PHH6kn8Qrj) | F | `<EST Events SRC>.Filter([gCal Event].Contains(thisRow))` | reverse link |
| 25 | Events GCAL | Add EST Event (c-lb8SgIWWdM) | BTN | `AddOrModifyRows(<EST Events SRC>, …gCal Event, Event Name, Event Date (for Metrics))` | importer for non-EB events |
| 26 | Mailchimp Audience SRC (grid-sync-11035-Member-…) | Events Led (c-H3S1rBdcrD) | F | `[EST Person].[Events Led EST].ListCombine().Unique().[gCal Event]` | gCal events led |
| 27 | Member Discount Codes SRC (grid-L_6qqZLVrq) | EST Event (c-EqV6ZyDMyL) | DATA lookup → EST Events SRC | hand/button-entered; 154 rows, 5 distinct events | which event the member code is for |
| 28 | Member Discount Codes SRC | Generate Discount (c-EtIZ7MWvX-) | BTN | EST Eventbrite pack `CreateDiscount(code, [EST Event].[Eventbrite Event].[Eventbrite Id], …config)` | creates EB discount codes |
| 29 | Member Discount Codes SRC | Code (c-INArW9mink) | F | `"MEMBER-{plan id[-5:]}-{[EST Event].[Eventbrite Id][-5:]}"` | |
| 30 | Member Discount Codes SRC | Discount URL (c-V8kypnsPqu) | F | `eventbrite.com/e/{[EST Event].[Eventbrite Id]}/?discount=…` | |
| 31 | Member Discount Codes SRC | Event Discount Config (c-8vDlil6A2k) | F | `[EST Event].[Event Discount Config].First()` | |
| 32 | Member Discount Codes SRC | Event Name (c-yAUxALjGyB) | F | `[EST Event].[Event Name]` | used in Email Body |
| 33 | Member Discount Codes SRC | Send Member Email (c-vOOWSFU9S7) | BTN | Gmail `SendEmail(…, subject template with [EST Event].[Event Name], body)` | |
| 34 | Event Discount Config SRC (grid-1DfN8_Ny8K) | Event (c-cktX1XinHF) | DATA lookup → EST Events SRC (display col) | 8 rows (6 linked, 2 blank) | per-event discount amount/percent/qty/dates/blurb |
| 35 | Event Discount Config SRC | Config Name (c-k93qi5py1h) | F | `[Event].[Event Name]` | |
| 36 | Event Discount Config SRC | Generate Codes (c--VMJ-LmEWG) | BTN | for every active Givebutter plan, `AddOrModifyRows(<Member Discount Codes SRC>, …EST Event = control "event for discount codes")`, then press each Generate Discount | uses canvas control `ctrl-TnVRk2ObF5` |
| 37 | EST Planning Events SRC (grid--gYIvdD-cE) | Linked EST Events SRC row (c-sUpvHhlGlI) | DATA lookup → EST Events SRC | 2 of 6 rows linked | the planned strangler seam; not written by the Worker today |
| 38 | Canvas control on Eventbrite page (`section-dAqAG6KcW9`) | "event for discount code sync" (ctrl-ApZIFyYp5z) | select of EST Events SRC rows | current value "April Shabbat Dinner! All are Welcome (4/24/2026)" | |
| 39 | EST Events SRC itself | Pre-/Post-Event Slack Reminder, Create/Update gCal | BTN | (see §1) | the Slack reminder buttons live on this table |
| 40 | View "EST Event Details & Metrics" (`table-ES515Pl6Uv`, Events page) | — | view | filter `Cancelled? = false` | the human events list |

(Subagent page-sweep results for the remaining pages are in §2c.)

### 2b. Second-order consumers (read a column from 2a, so they change when 2a is repointed)

- **EST People SRC:** Num Events Led (`[Events Led EST].Count()`), Num Events Volunteered, Num Events Hosted, Num Events Led Volunteered or Hosted, Last Host Date, **EST Program(s) Attended** (via Events EVENTBRITE.EST Program(s), #23).
- **EST Programs SRC:** Num Events, **Orders EVENTBRITE** (via `[Event EVENTBRITE].[EST Program(s)]`, #23), Total Orders (All Time), Distinct Registrants (All Time) (via People.EST Program(s) Attended).
- **Quarterly Metrics SRC:** Total Events, % Collab Events, % 3rd Wave Led, Avg Tickets Per Event, Distinct Registrants, Avg To-Date Orders Per Registrant, Avg Orders Per Registrant, Avg Distinct Registrants Per Event, Avg First Time Registrants Per Event, Avg Orders Per Event, Approx. Total Distinct Attendees. Essentially every event metric hangs off `Events EST`.
- **Mailchimp Audience SRC:** Num Events Led, Led Event IDs.
- **Event Discount Config SRC:** Member Discount Codes, Email Preview (via #31).
- People "First Event"/"Eventbrite First Event" and Events EVENTBRITE "First Timers" do **not** touch EST Events SRC (they go People → Orders → Events EVENTBRITE); only `Num First Timers` / `First Timers EST` on EST Events SRC wrap them.

### 2c. Other pages (sweep of the remaining 34 canvas pages)

Every other page was read. Base-table consumers above showed up again only through views. New ones:

| # | Where | Object | Reference | What it does |
|---|---|---|---|---|
| 41 | Data Management Workflows (`section-8v9VknebeW`) | canvas button **ctrl-y3NgkJxEsZ "Add EST Events from Eventbrite"** | `[Events EVENTBRITE].Filter([EST Event].IsBlank()).ForEach(AddOrModifyRows(<EST Events SRC>, …))` | bulk importer (writes EST Events SRC) |
| 42 | Data Management Workflows | views "Eventbrite events w/out EST event" (table-her7_UL6co, 8 rows) and "gCal events w/out EST event" (table-XEHOVPDDwk, 15 rows) | filter `[EST Event].IsBlank()` | the import to-do lists |
| 43 | Member Discount Codes page (`section-mdolbZEkCG`) | select control **ctrl-TnVRk2ObF5 "event for discount codes"** | value = an EST Events SRC row (now "We Are Wandering Scholars w/ Prof. Ed Cheng (5/8/2026)"). Options formula not exposed by the API | drives the discount workflow |
| 44 | same page | canvas buttons ctrl-rY5RG1dRHQ "Generate Discount Codes", ctrl-AjX9b80EWg "Send All Emails", ctrl-a_UrWarXRX "add discount config" | use ctrl-TnVRk2ObF5; the last reads `ctrl-TnVRk2ObF5.[Event Discount Config]` (EST Events SRC column c-4WnsRvg0d_) | |
| 45 | same page | views of Member Discount Codes SRC / Event Discount Config SRC | filter `[EST Event].Matches(ctrl-TnVRk2ObF5)` / `[Event].Matches(...)` | |
| 46 | Metrics (`section-fNmaSEdeLG`) | view **EST Events Metrics** (table-PeNaciLZmp) + 11 views of Quarterly Metrics SRC | no filter | metrics dashboard |
| 47 | Metrics Sandbox (`section-VlMInZZFpM`) | charts "2024 Total Tickets Registered by Program" (table-MFd-b0gVoK pie, table-b3pNotXkMk bar) | views of EST Events SRC | |
| 48 | Metrics Sandbox | "View 3/4 of EST People SRC" | filter `[Num Events Volunteered] > 0 or [Num Events Hosted] > 0` | second-order |
| 49 | **EST Events for Website** (Toolbox, `section-qqLRbx9YRH`) | view **table-TGmc77FCAp**, 218 rows | filter `Cancelled? = false`; columns Event Name, Banner image, Description, Registration URL Override, gCal Event Start/End, Eventbrite Id, gCal Event Id | almost certainly read by the website (Coda API or embed). Page has no text naming the reader |
| 50 | EST Event -> gCal Sync (`section-oSdLpYsc_J`) | View 2 of EST Events SRC (table-l-oTqW8XfL) | no filter; holds the Create/Update gCal button | manual gCal push page |
| 51 | Discord Reminders (`section-ayLv2Cshj1`) | View of EST Events SRC (table-opKdfs5j83) | no filter | reference only; reminders come from its own table |
| 52 | Data Management Workflows | View 3 of EST Events SRC (table-OkFo7iYeKF) | no filter | |

`table-AI9I3Q7SlN` ("Eventbrite Events") is a **view** of Events EVENTBRITE (`grid-sync-20456-Event`) on the Eventbrite-gCal Auto-Sync page (`section-Xn1IIrhlje`). Its "EST Event" and "Add EST Event" columns are #21/#22 above.

Pages with no consumers: home, Leadership & Planning, Event Planning Toolbox, Onboarding, People (views of People only), People Dashboard, Newcomers Report (canvas formulas use People only), Programs/Venues/Collaborators (views only), Plan/Gather pages, Fundraising, Data Capture, Toolbox, Event list for grant app (reads Events GCAL), DEPRECATED Inbox Bot, Upcoming Event Security, Strategy pages, All About.

**Count:** 52 rows above. Grouped as distinct things to repoint: ~22 formula columns across 9 tables (People 4, Venues 2, Programs 5, Collaborators 1, Quarterly Metrics 8, Events EVENTBRITE 2, Events GCAL 1, Mailchimp 1, plus Member Discount Codes 5 and Event Discount Config 1), 2 hand-entered lookups (Member Discount Codes.EST Event, Event Discount Config.Event) + the planning seam, 3 importers (2 column buttons + 1 canvas button), 6 discount buttons/controls, 3 own buttons (2 Slack + gCal), 2 select controls, ~9 views (incl. the website view).

### 2d. Automations, outside readers

- **Coda rules (from the 2026-11-14 audit, not visible to the MCP):** 9 rules, 3 on: "Daily Event Freshen Up" (presses Freshen Up on Events EVENTBRITE; doesn't touch EST Events SRC directly), "Event Planning Reminders" (9 AM daily) and a monthly Slack rule. **The last two were not opened**; either may read EST Events SRC (Event Planning Reminders is the likeliest). Check them in Automations before repointing.
- **Worker:** reads/writes only the planning table, People, Venues, Programs etc. (`proxy/wrangler.toml`, `proxy/src/worker.js`). Nothing in `proxy/` or `web/` references `grid-9TAt5vMMKH` or `Linked EST Events SRC row`.
- **Website feed:** `docs/phase2-planning-table.md` and the Aug-22 publish spec say "the website feed" reads `EST Events SRC` ("EST Events SRC aggregation → metrics/site"); the Banner image / Banner/Registration URL Override columns are shaped for it. There's a Toolbox page "EST Events for Website" (see §2c). No feed code was found in sibling repos (`eventbrite-coda-pack`, `givebutter-coda-pack`, etc. have no reference to the table or doc id).
- **Zapier:** the EST Zapier Zap "New Event EB→GCal" goes Eventbrite → gCal; it doesn't read Coda as far as the audit found.

---

## 3. What `EST Planning Events SRC` would need to stand in

Planning table today (40 cols): Title, Program(s) (multi → Programs), Leads (multi → People), Venue Type,
Venue (**single** → Venues), Venue (other), Event Description, Planning Notes, Scheduling, Date, Start, End
(time-only), All day, Window start/end, Status (Draft/Approved/Proposed/Cancelled), Created/Edited/Approved by,
Approved at, Published?, Eventbrite Event (→ Events EVENTBRITE), gCal Event (→ Events GCAL),
Linked EST Events SRC row, Volunteers (multi → People), Create Notes Doc, Notes Doc, Capacity,
Address visibility, Eventbrite Event ID / URL / Ticket Class ID, Publish status, Last published at,
Last publish error, Public summary, Public description, Last EB push at, Button (placeholder), Last EB pushed values.

**Already covered:** name (Title), Program(s), Leads, Volunteers, Venue (single only), Event Description,
date + times, Cancelled (Status = Cancelled), Eventbrite Event link + Eventbrite Event ID + URL, gCal Event link.

**Hand-entered columns to add (backfill targets):**
- `Collaborators` (multi lookup → EST Collaborators SRC). 41 rows have one.
- `Num Attendees (Manual Override)` (number). 3 rows.
- `Banner Image Override` (image) + `Registration URL Override` (url). 1 row each; needed if the website feed moves.
- `Event Photos` (files). 1 row.
- Venue must become **multi** (or pick one): 3 rows have 2+ venues.
- A cancelled flag that survives "Status = Approved past event" backfill: either map Cancelled? → Status = Cancelled, or add a separate checkbox. 20 rows are cancelled.
- Optionally `gCal Create Event Result` / gCal URL for the 154 rows whose gCal event was pushed by the Create/Update gCal button (the Worker's gCal publish will own this later).

**Formula columns to recreate on the planning table** (so consumers have the same hooks):
- `Event Date (for Metrics)` equivalent: the planning `Date` (backfill from EST Events' date; it's DATA there).
- `Eventbrite Event All Orders`, `Num Tickets` (with manual-override fallback), `Num Orders`, `Ticket Revenue`.
- `Num First Timers`, `First Timers EST` (needed by the Post-Event Slack message).
- `Collab Event`, `Min Leadership Wave` (Quarterly Metrics' collab and 3rd-wave counts).
- `Event Discount Config` reverse lookup (once Event Discount Config SRC.Event is repointed).
- `Metrics Reporting Periods` reverse lookup (optional).
- `Banner image` (override, else EB Image) if the website feed moves.
- Buttons: Pre-/Post-Event Slack Reminder (or move to the Worker); Create/Update gCal can be dropped (Worker publishes to gCal).

**Droppable:** gCal Event Start/End/Id/URL, Description (from gCal), Eventbrite Id / URL (planning has its own),
Venue Host(s) (derivable), the gCal pack result once the Worker owns gCal.

---

## 4. Backfill data quality

- **238 rows**, dates 2017-02-11 → 2026-12-13. By year: 2017 6, 2018 4, 2019 3, 2020 5, 2021 25, 2022 25, 2023 43, 2024 50, 2025 44, 2026 33. Event Date is never blank. 2 rows are future (Hanukkah Out East 12/7/2026, Rosh Chodesh Circle 12/13/2026).
- **Eventbrite link:** 171 rows have `Eventbrite Event` (and so an Eventbrite Id); **67 have none**. Of the 67: 53 have a gCal link only, 14 have neither (2017–2019 events, plus "50+ Potluck Shabbat Dinner! 2/7/2025"). By year, no-Eventbrite rows are 2017–2021 all (43), 2022 13, 2023 3, 2024 6, 2025 2, 2026 0. The post-2022 ones are OneTable potlucks, leadership retreats, Fallfest, Jewsic City, 50+ dinners, and 3 cancelled events. 64 of the 67 are not cancelled.
- **gCal link:** 216 rows; 8 rows have Eventbrite but no gCal.
- **Cancelled:** 20 rows (2022 1, 2023 4, 2024 3, 2025 6, 2026 6).
- **Programs:** multi lookup → EST Programs SRC. 13 rows blank, 4 rows have 2+.
- **Leads:** multi lookup → EST People SRC. 41 rows blank. Default formula copied the program's current leads at creation, so treat as approximate. 28 people have ≥1 led event.
- **Volunteers:** multi lookup → People. 40 rows set; 32 people have ≥1.
- **Venue:** multi lookup → EST Venues SRC. **113 rows blank**, 3 rows multi. 49 venues have events; 35 people count as hosts via venue.
- **Collaborators:** multi lookup → EST Collaborators SRC; 41 rows, 19 collaborators.
- **Overrides:** manual attendance 3 rows (2 without Eventbrite), banner 1, registration URL 1, photos 1, discount config 6.
- **Duplicates:**
  - Same Eventbrite event on 2 rows: **L'chaim Time! (12/2/2025)**, rows 209 and 229 (both cancelled, EB 1596776374119).
  - Same name + date: the **Littles Shabbat 2026 series is doubled** (rows 217–222 and 231–245): each date Jan–Jun 2026 has two rows with *different* Eventbrite ids (the series was re-created on Eventbrite); Jan 10 has three (217, 231, 232). Several of each pair are marked cancelled, several are not, so metrics may double-count some dates (e.g. 5/9 and 6/13 have two non-cancelled rows each: 221/242, 222/245; 4/11 has 239 live + 220 cancelled). Needs a human pass before backfill.
  - 51 repeated names overall, mostly generic ("Monthly Shabbat Dinner", "August Community Shabbat") on different dates — not duplicates.
- **Eventbrite events with no EST Events row:** 8 (all Oct 2026+ drafts/live: "testing", Littles Shabbat 11/14, 12/12/2026, 2/13, 3/13, 4/10/2027, Wandering Scholars Jewish Futures 3/1/2027, Shoresh x Tribilings Hanukkah 12/6/2026). The import buttons have stopped being pressed, so recent metrics are already incomplete.
- **Planning ↔ EST Events link:** only 2 of 6 planning rows are linked (Yom Kippur Break Fast 9/21/2026, August Shabbat Dinner 8/21/2026).
- **Member Discount Codes SRC:** 154 rows point at 5 EST Events rows (Hanukkah Out East 12/16/2025, Kids' Tu BiShvat 1/31/2026, Tribelings Movie Night 4/11/2026, Wandering Scholars w/ Ed Cheng 5/8/2026, Hanukkah Out East 2026). These lookups need re-pointing to the new row ids.

---

## 5. Outside readers (hints only)

See §2d and §2c. Summary: possible website feed (docs say one exists; "EST Events for Website" page),
two unopened Coda rules, Slack/Gmail/gCal/Eventbrite pack actions fired from buttons. Nothing in local repos reads the table.
