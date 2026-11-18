# Design proposal — End-state for events, people & comms

**Status:** proposal / for discussion. Nothing here is built.
**Date:** 2026-11-14.
**Inputs:** the integration audit (`~/Documents/personal/est-integration-audit-findings.md`), `docs/phase2-planning-table.md`, `2026-08-22-eventbrite-publish-design.md`, `2026-09-16-attendees-roster-design.md`, and the live Coda schema (read 2026-11-14).

## 1. Why

The audit found a patchwork where every flow has two owners, or none:

- **Two systems create gCal events.** A forgotten EST Zapier Zap and Coda's daily Freshen Up both create them. They match by searching descriptions in a stale sync table, so events get duplicated.
- **Eventbrite → Mailchimp has been broken since Nov 2024.** The Eventbrite-built integration stopped tagging (and effectively adding) registrants. The 2025 "store" integration adds bare emails with no names, tags or orders. The audience has been kept roughly current by eight manual bulk imports since then.
- **People are stitched together by hand.** "Add EST People from Orders", "Add/Update EST People from Mailchimp", matching people to Mailchimp subscribers by name, a de-duper, and mailing-list sign-up links that get opened one tab at a time.
- **There are two event tables.** `EST Planning Events SRC` is authored in the app. `EST Events SRC` is the older aggregator that metrics, People formulas, venues and discounts point at. They're linked by import buttons and description matching.
- **Comms ride on Eventbrite's notifications**, which you've found unreliable. Mailchimp is used mainly for newsletters.

**The principle that fixes all of this:** every kind of record has exactly one owner. Everything else is either a **push** from that owner, keyed by a stored id, or a **read-only mirror**. No more "find the matching row by searching text."

## 2. Goals, non-goals, anti-goals

**Goals**
1. **One event record**, authored in the plan app. It's the only thing that creates or updates downstream copies (Eventbrite, gCal, Mailchimp).
2. **One person record per human** in `EST People SRC`. It's created or updated automatically from every touchpoint: Eventbrite order, gather claim or sign-in, Givebutter, Mailchimp signup.
3. **Mailchimp as the comms engine.** It always reflects each person's registrations, programs and membership as tags. It sends promotion, confirmation, reminder and follow-up emails that EST controls, instead of Eventbrite's.
4. **Zero routine manual stitching.** Humans only resolve genuinely ambiguous identity matches, from a review queue.
5. **Observable.** Every automated push leaves a log row in Coda: what, when, success or error.

**Non-goals (for this design)**
- Replacing Eventbrite for ticketing or payments.
- Replacing Coda as the database (decision #1 stands).
- Socials and budget/expenses. They attach to the same event record later.

**Anti-goals (failure even if it "works")**
- Any flow that matches records by searching names or descriptions instead of stored ids.
- Two systems that can both create the same downstream object.
- Adding registrants to marketing email without the consent basis EST is comfortable with (§6.4).
- A design that depends on one person's personal account. Today the Eventbrite pack sync and Freshen Up run as Eric, and the Zapier account was forgotten.

## 3. Ownership map (the end-state in one table)

| Record | Owner (source of truth) | Pushed to (by the Worker, keyed by stored id) | Read-only mirrors |
|---|---|---|---|
| Event (plan → publish → past) | **Plan app → `EST Events` table** (today's `EST Planning Events SRC`, §4) | Eventbrite event, gCal event, Mailchimp campaigns | Eventbrite pack sync (orders, metrics) |
| Registration (order) | **Eventbrite** | → People (create/link), → Mailchimp (tags) | `Orders EVENTBRITE` pack sync |
| Potluck/volunteer claim | **gather → `EST Claims SRC`** | → People, → Mailchimp tags | — |
| Membership (paid) | **Givebutter** | → People (`Active Member?`), → Mailchimp tag `Member` | Givebutter pack sync |
| Person (identity, names, emails) | **`EST People SRC`** | → Mailchimp member (merge fields + tags) | — |
| Email consent and subscription status | **Mailchimp** | → People (`Mailing List Status`) via webhook | Mailchimp Audience sync (can retire) |
| Program follows, email prefs, household, host offer | **Coda, edited by the person in gather** (§7b) | → Mailchimp tags (`Follows:`, exclusions) | — |
| Leadership, roles, program leads | **`EST People SRC` / `EST Programs SRC`** (hand-edited) | → Mailchimp tags (`Leader`, `Lead: <Program>`) | — |

**Single writer:** the Cloudflare Worker already has the Coda token and the Eventbrite token, and decision #3 makes it the server-side publisher. It becomes the one integration hub. Coda automations and buttons that push to third parties are retired, and so are Zapier and the Eventbrite↔Mailchimp app connections.

## 4. Events: one table, not two

### Decided (2026-11-14): converge on the planning table and retire `EST Events SRC` in stages, carefully
Most of what `EST Events SRC` does today (gCal links, import buttons, Eventbrite lookups) gets absorbed by the Worker anyway. What's left is history and the formulas that point at it, and the staged migration below moves those one at a time.

Today the two tables split one concept:

- `EST Planning Events SRC` holds authorship, status, public copy and the Eventbrite id.
- `EST Events SRC` holds history (238 rows), metrics hooks (Quarterly Metrics, First Timers, ticket counts), and the relations People formulas use (`Events Led/Volunteered EST`, host venues). It also holds banner/registration overrides, discount config, and Slack pre/post reminder buttons.

Keeping both means every new event needs a twin row and a link, which is exactly the matching problem we're trying to kill. The planning table was designed to grow into the lifecycle record (its "Designed to grow" section). Leads already author there, and approval and publish happen there. It should be **the** event table.

**Staged migration (strangler, nothing breaks mid-way):**

1. **Link, don't import.** When the Worker publishes an event, it creates the `EST Events SRC` twin itself (or links an existing one) and stores the link on the planning row (the planned `Linked EST Events SRC row` seam). The "Add EST Events from Eventbrite" and "gCal events w/out EST event" buttons are retired. Metrics keep working untouched.
2. **Backfill history.** Import the 238 historical `EST Events SRC` rows into the planning table as `Status = Approved` past events with their Eventbrite id, venue, leads, programs, volunteers and collaborators. They show in the plan app's past years for free.
3. **Repoint consumers** to the planning table, one at a time, each verified against the old numbers: People formulas (Events Led/Volunteered/Hosted), Quarterly Metrics, First Timers, Discount Config, Venues, the Slack reminder buttons, and the website/feed if any reads `EST Events SRC`.
4. **Freeze, then rename.** Rename the old table `EST Events (legacy)`, read-only. Rename `EST Planning Events SRC` to **`EST Events`**. Its table id doesn't change, so the Worker is unaffected. This is also when the deferred id-hardening of the planning seam (CLAUDE.md) gets done.

**Alternative considered: keep two tables permanently, 1:1 linked by the Worker.** It's cheaper now, but every lifecycle field (banner, attendance, photos, discounts, comms schedule) has to pick a side forever, and People formulas keep pointing at the aggregator. Rejected as the end-state, though it is exactly migration step 1, so it's also the fallback if steps 2–4 stall.

### Events that never go on Eventbrite
gather-only potlucks, external collab events and "ideas" are just planning rows whose Eventbrite id stays blank. Publishing to gCal and Mailchimp shouldn't require Eventbrite. Each target is independent (§5).

## 5. Event publish pipeline (replaces Zapier + Freshen Up)

```
Plan app ──(Approve)──► planning row (Status=Approved)
     │
     └─(Publish / Update, role-gated)──► Worker POST /publish/:target
             ├─ Eventbrite   (built: create/update/publish/cancel, EB id stored)
             ├─ Google Cal   (NEW: insert/patch/delete by stored gCal event id)
             ├─ Mailchimp    (NEW: create the event's comms campaigns, §6)
             └─ each step → Publish Log row + status fields on the planning row
```

- **gCal is keyed by stored id, never searched.** The Worker writes `gCal Event ID` on the planning row at insert, then patches or deletes by that id. Cancel removes it (or marks it cancelled). The description holds the public summary, the Eventbrite link and the gather link. The location honors `Address visibility` (the §5a safety rule from the publish design). Re-pushing is idempotent.
- **One trigger, not a poll.** Pushes happen when a lead clicks Publish/Update, or automatically on save of public fields for an already-published event (the `_ebDirty` signal that's already tracked). No daily sweep is needed. A nightly "drift check" may compare stored ids against live objects and *report* mismatches to the Publish Log, never fix them silently.
- **JFed email: retired (decided 2026-11-14).** The "New/Updated East Side Tribe Event!" email to the Federation isn't a real process anymore. Anyone at JFed who wants to hear about events can join the mailing list. The Coda JFed controls, templates and Gmail pack action get removed.
- **Google credentials (my call):** a Google Cloud **service account** that the *East Side Tribe Events* calendar is shared with ("Make changes to events"), with its key stored as a Worker secret. With JFed gone the Worker sends no Gmail, so it needs no personal OAuth token, and the access belongs to the org, not a person.
- **Retire:** the EST Zapier Zap "New Event EB→GCal" and its Eventbrite `event.published` webhook. The Coda rule "Daily Event Freshen Up", the Freshen Up/Create/Update gCal buttons, and `Create/Update gCal` on `EST Events SRC`. And the Coda gCal pack connection (keep its sync only if something still reads it).
- **Eventbrite edited directly** (it happens): an Eventbrite `event.updated` webhook goes to the Worker, which logs it and flags the planning row "Changed on Eventbrite". The lead reconciles in the app. The planning row stays the truth, and nothing is silently overwritten either way.

## 6. People & comms

### 6.1 Identity: one resolve-or-create, used by every source

A single Worker function `resolvePerson({email, firstName, lastName, source, sourceRef})` does the following:
1. Normalize the email (lowercase, trim; strip Gmail dots and `+tags` for *matching only*).
2. Match against `EST People SRC` → `All Emails`. This is already what sign-in uses (`resolvePerson`/`peopleRows`, slim KV projection).
3. **One match** → link the source record to that person and fill blank names. Never overwrite names a human set.
4. **No match** → create the person (names + `Email (Manual Input)`), tag `Source = <eventbrite|gather|givebutter|mailchimp>`.
5. **Ambiguous** (no email match, but same full name as an existing person with a different email) → create the person **and** add a row to a `People Review` queue ("possible duplicate of X"). A human merges or dismisses it with the existing de-duper.

Every source calls it, and the manual buttons go away:

| Touchpoint | Trigger | Replaces |
|---|---|---|
| Eventbrite order | Eventbrite webhook `order.placed` → Worker (EST org token) | "Add EST People from Orders" button, bulk imports |
| gather claim / sign-in | already in the Worker | (already automatic; route through the same function) |
| Givebutter | Givebutter webhook if available, else a scheduled Worker pull (hourly) | Givebutter-contact matching by hand |
| Mailchimp signup form / profile update / unsubscribe | Mailchimp webhook → Worker | "Refresh Mailchimp Audience → Add/Update EST People", name matching |
| Manual | a lead or council member adds in Coda / the plan app | unchanged |

**Emails move from a derived formula to an owned list.** `All Emails` today is a formula that unions the manual email, linked Mailchimp, Eventbrite and Givebutter emails, and it depends on those links being made by hand first. In the end-state, `resolvePerson` appends each new email it sees to an owned `Emails` list column on the person. `All Emails` keeps unioning it, so it's backward compatible.

### 6.2 People → Mailchimp (the push that's been missing since Nov 2024)

The Worker upserts the Mailchimp member (`PUT /lists/{id}/members/{md5(email)}`) whenever a person changes in a way Mailchimp cares about. It sets merge fields (`FNAME`, `LNAME`, plus `MEMBER`, `FIRSTEVT` and similar as useful) and applies **tags from a fixed vocabulary**:

| Tag | Applied when |
|---|---|
| `Registered: <Event> <YYYY-MM-DD>` | Eventbrite order for that event (removed on full refund/cancel) |
| `Attended: <Event> <YYYY-MM-DD>` | after the event, if checked in (Eventbrite check-in data) |
| `Claimed: <Event> <YYYY-MM-DD>` | gather claim |
| `Follows: <Program>` | mirrors `Program Follows` (follow added or removed in gather, or auto-follow on first registration) |
| `First-timer` | first-ever registration (removed after their 2nd event) |
| `Member` | `Active Member?` true (removed when it lapses) |
| `Leader`, `Lead: <Program>` | from People/Programs |

This restores what the old Eventbrite integration did (event tags, which stopped in Nov 2024) and adds program, member and attendance dimensions EST never had. Tags are idempotent, so re-running a sync is safe.

**Mailchimp connections:** disconnect **Connection A** (Eventbrite app, Aug 2022, dead since Nov 2024) now. It's harmless to remove, and its 230 contacts and tags stay. Disconnect **Connection B** (store integration, Jun 2025, bare emails) once §6.2 is live, so contacts don't arrive from two paths with different data.

### 6.3 Comms: Mailchimp does the sending, the plan app plans it

For each published event, the Worker creates its comms in Mailchimp from EST templates. The plan app's **Comms** section (currently "Coming soon") shows and edits them:

| Email | Audience (resolved at send time, so late registrants are included) | When | Notes |
|---|---|---|---|
| **Promotion** | segment: `Program: <this program>` (and/or all subscribed, a lead's choice) | lead schedules; default 2–3 weeks out | **Draft** campaign built from public copy + banner; the lead reviews and approves the send in the app |
| **Last-call promo** (optional) | promotion audience minus `Registered: <event>` | ~3 days out | skipped if sold out |
| **Reminder** | tag `Registered: <event>` ∪ `Claimed: <event>` | 2 days before + morning-of | includes address (honors `Address visibility`, since registrants are allowed it), potluck slot claimed, gather link |
| **Follow-up** | `Attended:` / `Registered:` | day after | thanks, photos, feedback link; separate copy for `First-timer` |

- **Program followers** (the promotion audience) = contacts tagged `Follows: <Program>`. The tag mirrors a new Coda table, **`Program Follows`** (person, program, state `following|unfollowed`, source `self|registered|imported`, changed at).
  - **People choose follows in gather's Profile & Preferences page** (§7b), which lists programs straight from `EST Programs SRC`, so there's no second list to keep in sync.
  - **Decided (2026-11-14):** the first registration for an event in a program auto-follows that program (source `registered`), unless the person has unfollowed it. An explicit unfollow stays put, and attending later doesn't re-follow.
  - **Retire Mailchimp's "I'm particularly interested in…" interest group.** First import its current picks into `Program Follows` (source `imported`). Email footers keep Mailchimp's required unsubscribe link, and "Update preferences" points to the gather page instead of Mailchimp's own.
- **Event attendees** (the reminder audience) = `Registered: <event>` ∪ `Claimed: <event>`. Follow-up goes to `Attended: <event>`. Last call goes to followers minus `Registered: <event>`.
- **"Templates with standard drip timings"** = Mailchimp templates (design and wording) + Coda's Comms Schedule rows (offset and time). On publish, the Worker applies the schedule to create the event's set of campaigns. Mailchimp templates don't carry timing.
- These are **regular Mailchimp campaigns**, created and scheduled via the API, targeting a segment built when the campaign is created. Everything appears in Mailchimp's own UI and reports, so EST staff can see and edit them there too.
- **Turn off Eventbrite's reminder emails** per event once Mailchimp reminders are proven, so people don't get both.
- **Emails about a person's journey are Mailchimp Customer Journeys, owned entirely in Mailchimp.** This covers the newsletter welcome, first-timer follow-up, new-member welcome, lapsed-member nudge and re-engagement. Trigger, timing, wording and design all live in the Journey builder, and Coda doesn't model them. The Worker's only part is applying the tags that start them (`First-timer`, `Member`, `Attended: …`).
- **Why event emails aren't Journeys.** A Journey waits from when the person entered it, or from one date field on the contact, so it can't express "2 days before *this* event" for someone registered for several events. Promotions are sends to a whole group, which Journeys don't do. A Worker-fired "reminder due" event (Mailchimp Events API) could hand content to a Journey, but the Worker would still own the timing, and `*|EVENT:…|*` merge tags are reported to be unreliable. That approach is worth a spike only if moving reminder content into Journeys becomes a priority.
- The Attendees section's `mailto:` "Email" button stays for ad-hoc notes.
- Every scheduled or sent campaign gets a `Comms Log` row in Coda (event, type, Mailchimp campaign id, send time, recipient count) and is shown in the event's Comms section.

### 6.4 Consent (needs your decision; see §9)
Reminders and confirmations to registrants are transactional in spirit. Promotions are marketing. Options:
- **(a)** Treat registering as opt-in, which is what the old integration did. Simple, but riskier.
- **(b)** Add a "Keep me posted about East Side Tribe events" question to Eventbrite checkout. Registrants who say yes become `subscribed`. Everyone else is added as `transactional` (they can't get campaigns) and gets reminders via Mailchimp Transactional, or keeps Eventbrite's reminders.
- **(c)** Hybrid: subscribe only first-timers who opt in, and leave existing subscribers alone.

My lean is (b). The decision changes how reminders are sent, so it has to be settled before building §6.3.

## 7. How the apps fit

- **Plan app:** authoring, approval, publish to every target, the Comms section (§6.3), and a "People review" queue for council (§6.1). Leads never touch Coda buttons.
- **gather:** unchanged for members. Its claims and sign-ins flow through `resolvePerson`, and claims become `Claimed:` tags (so potluck contributors get reminders too).
- **Coda:** the database, metrics and observability (Publish Log, Comms Log, People Review). It stops pushing to third parties. The remaining pack syncs (Eventbrite orders, Givebutter, optionally Mailchimp) are **read-only mirrors** for metrics.
- **Worker:** the only integration hub. It gains Eventbrite, Mailchimp and Givebutter webhook endpoints (signature-verified), plus Google and Mailchimp secrets.

## 7b. gather Profile & Preferences (the member-facing surface; its own spec later)

Members sign in to gather already (Firebase → `resolvePerson`). A **Profile & Preferences** page there is the person's single place to manage their relationship with EST. This design fixes only who owns each part. Layout and UX come in the gather spec.

| Section | Owner (source of truth) | gather lets the person | Flows on |
|---|---|---|---|
| Name, email addresses | `EST People SRC` | edit name; add/verify another email | Worker → Mailchimp merge fields |
| Program follows | `Program Follows` (Coda) | follow / unfollow each program (list read live from `EST Programs SRC`) | Worker → `Follows:` tags |
| Email preferences | Mailchimp (consent) + Coda (per-type prefs) | newsletter on/off; reminders for events I'm attending on/off | Unsubscribe and resubscribe go through Mailchimp. Resubscribing sends Mailchimp's confirmation email, because Mailchimp blocks an API straight back to "subscribed". Per-type prefs become exclusion tags. |
| Membership | Givebutter | see status and renewal date; link to manage on Givebutter | read-only display |
| Family / household | Coda (new table; **sensitive**: minimal fields, never exported to Mailchimp beyond e.g. a `Has kids` tag if wanted) | add/edit household members | Tribelings targeting, later |
| Host registration | `EST Venues SRC` hosts + People `Host Status` | offer to host, update details | council review in Coda |

Every write goes through role-checked Worker routes (`/me/*`) that only ever touch the signed-in person's own rows. This follows the gather projection rule: no other person's data reaches the browser.

## 7c. Access & permissions: a dedicated `Plan Access` table (decided 2026-11-14)

Three jobs, kept apart:
- **Sign-in (who are you?)** stays in **Firebase**.
- **Identity (which person?)** stays on **EST People**.
- **Permissions (what can you do?)** move to a new, small **`Plan Access`** table instead of being read from `Leadership Status` and program-lead fields on People.

| Column | Type | Notes |
|---|---|---|
| Person | relation → `EST People SRC` | one row per grant |
| Role | select: `Lead` / `Council` / `Admin` | Lead = create/edit/propose. Council = also approve/reopen/delete. Admin = also the Integration Control page + `/admin/*` routes (this answers "who's an admin") |
| Emails | lookup → Person.`All Emails` | the only People data the Worker reads for permissions |
| Active / Expires on | checkbox or date | seasonal or temporary access without deleting rows |
| Granted by / Granted on | person + date | audit trail |
| Programs (**deferred**, decided 2026-11-14) | relation → Programs | would narrow a Lead to their own programs' events. Not built now; adding it later is additive |

- **The Worker reads `Plan Access` only** to decide plan-app and admin permissions (by column id). It's refreshed every minute by cron and on demand. A **last-good copy is served if Coda is unreachable**, so a Coda outage never breaks sign-in. This replaces today's 30-minute hard expiry on the People cache.
- **gather is different:** any member may sign in, so gather still matches emails to People for identity (claims, Profile & Preferences). No gather screen needs a role. Any future one checks `Plan Access` too.
- **Lock the table** to Admins in Coda. Each refresh compares the new copy with the last one and writes grants, removals and role changes to a **`Role Changes`** log (optionally a council Slack ping).
- **Emergency revoke without Coda:** disable the user in Firebase, or add them to a Worker denylist in KV.
- **Drift check:** a Coda view "Program leads without Plan Access" (and the reverse) catches anyone named a lead on Programs who lacks access, without coupling the two.
- **Migration:** seed `Plan Access` from today's derived roles (Program Lead / Tribal Council). Switch the Worker over and compare the two results for each user over a week of real sign-ins. Then drop the role derivation from the People path.

## 7a. The admin control surface: what Coda controls, and how the Worker obeys

**Decision (2026-11-14):** the Worker is the plumbing and Coda is the rule book. The Worker does anything that talks to an outside service. Everything a non-developer should be able to change, check or fix lives in Coda as data. The Worker reads it on each run and writes back what it did.

### Principles for what gets a knob
1. **Expose what, when, who and the wording. Hide how.** Schedules, copy, audiences, on/off and recipients are knobs. API calls, retries, ids and matching logic are not.
2. **Every knob is typed and bounded.** Selects instead of free text wherever possible, number ranges, and required fields. A typo shouldn't be able to email the wrong people.
3. **Nothing is silent.** Each config row has Worker-written `Status` (✓ valid / ⚠ <reason>) and `Last used` columns. Each action logs which config version it used.
4. **A bad edit fails safe.** If config doesn't validate, the Worker keeps the last good version (cached in KV), logs a `Config Error`, and shows it on the row. It never sends with half-valid config.
5. **Big blasts always need a person.** A send to the full audience always needs a named approver. This rule is not a knob.
6. **Admins and leads have separate surfaces.** Leads work per event in the plan app (Comms section). Admins set policy on a locked **Integration Control** page in Coda.

### The control tables (on a locked "Integration Control" page)

| Table | One row per | Admin can change | Worker writes (grey, read-only columns) |
|---|---|---|---|
| **Flows** | integration flow (fixed list the Worker knows: `eventbrite_publish`, `gcal_sync`, `people_from_eventbrite`, `people_from_givebutter`, `people_from_mailchimp`, `mailchimp_contacts`, `comms_promo`, `comms_reminder`, `comms_followup`) | **Mode**: Off / Test / Live. Test recipient(s). Note. | Last run, last result, last error, runs in the last 7 days |
| **Comms Schedule** | email type (promotion, last call, reminder, morning-of, follow-up, first-timer follow-up, cancellation) | **Which Mailchimp template** (design and wording live there). Subject and preheader (these belong to each campaign in Mailchimp, not the template). Timing: days before plus time of day. Audience rule (select). Default on/off. Needs approval? | Status (template exists, every `{{placeholder}}` in it and the subject is known), last used |
| **Program Comms** (columns on `EST Programs SRC`) | program | Auto-promote? Promotion audience (program tag / all subscribers). Promotion lead time. Reply-to (the program's lead or a shared address) | — |
| **Send Rules** (one-row settings) | — | Quiet hours (no sends before X or after Y). Max marketing emails per person per week. (No Shabbat/Yom Tov hold: decided not needed, 2026-11-14.) Global **Pause all outbound** | Status |
| **Tag Rules** | tag kind (`registered`, `claimed`, `attended`, `program`, `first_timer`, `member`, `leader`) | On/off. Label prefix (only until first use; see below) | Count of contacts tagged, first used on |
| **People Review** (queue, Worker-created rows) | possible duplicate | Resolve with buttons: **Merge into…** / **Not a duplicate** / **Separate person** | Reason, sources, created at |
| **Publish Log · Comms Log · Sync Log · Config Errors** (Worker-written) | attempt or event | **Retry** button on failed rows | Everything else |

**Per-event overrides live on the event row and are edited in the plan app**, not on the control page: skip a reminder, change its send time, edit copy for this event only, approve the promotion. The admin control page sets defaults, and the event row overrides them.

### Deliberately not knobs (Worker config/secrets, changed by a developer)
- Credentials and tokens. Also the Mailchimp **audience id** and the gCal **calendar id**: one wrong paste in Coda could email or publish to the wrong place.
- Matching logic for people, webhook verification, retries, rate limits.
- Email design and wording in Coda. **Both live in Mailchimp templates**, edited in Mailchimp's own editor with a real preview. Templates use a fixed placeholder list that the Worker fills per event: `{{event.title}}`, `{{event.date}}`, `{{event.time}}`, `{{event.address}}` (only when address visibility allows), `{{event.eventbrite_link}}`, `{{event.gather_link}}`, `{{event.lead_note}}`, `{{person.slot}}`. An unknown or broken placeholder marks that Comms Schedule row ⚠ and holds that email. A lead's per-event wording goes into `{{event.lead_note}}` from the plan app. Leads never edit the template itself.
- **Renaming a tag pattern after it's been used.** Segments and past campaigns depend on exact tag names. The Worker stores the actual tag name it used on each event row, so a later prefix change only affects new events. Old reminders still target the right tag.

### How Coda and the Worker talk

```
Coda (rule book + logs)                         Worker (plumbing)
───────────────────────                         ─────────────────
Control tables ──── read by column id ────────► config loader (KV cache ~60s,
                                                  last-good fallback, validates)
"Apply changes" btn ── pack action ───────────► POST /admin/config/refresh → Status ✓/⚠
"Send test" btn ───── pack action ────────────► POST /admin/test-send (to the clicker)
"Retry" btn (logs) ── pack action ────────────► POST /admin/retry/:logId
"Resync person/event" pack action ────────────► POST /admin/resync/:kind/:rowId
Logs, Status cols ◄── row writes by col id ───── every action + every config load
People Review rows ◄─ created on ambiguity ───── resolvePerson()
```

- **Buttons call the Worker through a small "EST Worker" Coda pack.** It's the same pattern as the Eventbrite pack, using a shared-secret header. Each action passes the clicker's email (`User()`) so logs say who did it. The Worker only accepts these from the pack's secret.
- **Reads use column ids**, per the existing id-hardening rule (`coda-columns.js`), so renaming a column in Coda never breaks the Worker.
- **Comms run on a reconciler, not fire-and-forget.** A Worker cron (hourly) looks at upcoming published events and makes sure each one's Mailchimp campaigns exist and match the current template, event details and overrides. It creates, updates or cancels unsent campaigns as needed. So editing a template or moving an event fixes future sends automatically.
  - **Hand edits are respected.** If someone edits a campaign directly in Mailchimp, the Worker sees that the content differs from what it last wrote, marks the campaign "Edited in Mailchimp", and stops touching it.
- **Publish (Eventbrite/gCal) stays event-driven:** on Publish and on save of a published event, as in §5. The reconciler is only for time-based comms.
- **Test mode is real.** In Test, a flow sends only to its test recipients, adds "[TEST]" to subjects, and never writes tags to real contacts.

### Open questions on the control surface (yours)
1. ~~Who's an admin?~~ **Answered by §7c:** anyone with an active `Admin` row in `Plan Access`.
2. ~~Shabbat/Yom Tov hold~~ **Decided: not needed.**
3. ~~Promotion approval~~ **Decided:** a Lead approves promotions to their program's followers. A send to all subscribers needs Council.

## 8. Suggested order of work

Each step stands alone and removes a manual process.

1. **Stop the bleeding (no code, today):**
   - **Make Freshen Up update-only:** set the `Needs Create` formula on the Eventbrite Events table to `false`. Then the Zap is the only thing that creates gCal events (with location), and Freshen Up still keeps them updated. No new duplicates, and nothing lost.
   - Delete the 4 orphan gCal events.
   - Disconnect Mailchimp Connection A.
   - Put the EST Zapier, Eventbrite and Google logins in a shared vault.
   - Move the Eventbrite pack connection off Eric's personal account.
2. **gCal from the Worker (§5):** then retire the Zap and Freshen Up for good.
3. **`resolvePerson` + Eventbrite order webhook → People (§6.1):** kills the "Add EST People from Orders" button and bulk imports.
4. **People → Mailchimp upsert + tags (§6.2):** restores registration tags. Then disconnect Connection B.
5. **Comms section + Mailchimp campaigns (§6.3):** reminders first (highest value), then promotions, then follow-ups. Gated on the consent decision.
6. **Event table convergence (§4, steps 1–4):** can run in parallel from step 2 onward. Step 4 lands last.
7. **Givebutter + Mailchimp webhooks → People:** closes the remaining manual links.

## 9. Open decisions (yours)

1. ~~Consent model~~ **Decided (2026-11-14): (a).** Registrants are added as `subscribed`. Every Mailchimp email carries unsubscribe and manage-preferences links, which is the opt-out. There's no Transactional add-on, so Standard covers everything. §6.3 is unblocked.
2. ~~Mailchimp plan tier~~ **Answered: EST is on Standard.** It covers API contact and tag upserts, API-scheduled campaigns to tag segments, and Customer Journeys. Two caveats tie into decision 1:
   - Reminders to contacts who did **not** opt in need the paid **Transactional Email add-on**.
   - Non-subscribed and unsubscribed contacts count toward the billed contact limit.

   Under option (a), Standard is enough as-is. Under (b) or (c), choose one for non-opted-in registrants: pay for Transactional, leave them on Eventbrite's reminders, or don't add them to Mailchimp.
3. **Event table convergence** (§4): go all the way to one table, or stop at the 1:1-linked fallback?
4. ~~Who approves promotional sends~~ **Decided:** Lead for program followers, Council for all subscribers.
5. ~~Stopgap for duplicates~~ **Resolved:** keep both, with Freshen Up made update-only (step 1).

## 10. My calls (check these)

- The Worker is the single integration hub *for plumbing*. Coda is the rule book and logbook that admins control (§7a). This extends decision #3 from Eventbrite to everything outbound. Coda as the full hub was considered and rejected: it decides from synced copies that can be a day old, it can't receive Eventbrite or Mailchimp webhooks directly, its automations belong to individual people, and its formula logic fails silently.
- Google access is a service account the EST calendar is shared with (calendar only, now that JFed email is retired).
- Mailchimp campaigns are regular, tag-segmented and API-created, rather than Customer Journeys. Journeys can't express per-event date triggers cleanly.
- Tag naming: `Registered: <Event> <YYYY-MM-DD>`, with the date included so recurring titles ("Littles Shabbat") don't collide.
- Possible duplicates are queued for a human, never auto-merged.
