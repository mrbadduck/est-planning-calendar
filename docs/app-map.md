# App map — how `web/` is built

Moved out of CLAUDE.md on 2026-11-16 so it isn't loaded on every task. Read it before
changing the app. The event-page work (Phase 1) splits `web/app.js` into small files and
rewrites this page as a file map; until then it walks `app.js` top to bottom.

Terms: `docs/GLOSSARY.md`. Why things are the way they are: `docs/decisions/`.

## `app.js`, top to bottom

Split into `web/index.html` + `web/styles.css` + `web/app.js` (buildless; all
logic in `app.js`). Key pieces of `app.js`, top to bottom:

- **Data layer**: `PROGRAMS`/`PEOPLE` (built-in palette + editor picker seeds,
  the programs list is replaced live from `/ref/programs`), `MOCK_REFS` (built-in
  holiday/partner overlays, still awaiting Hebcal), `planningRowToEvent` /
  `eventToCodaCells`, and **`CodaSource`** — the single live data source hitting
  the proxy. `const DB = CodaSource;` (the in-memory mock was removed).
- **State**: `state` object (program year, current view, layers, role, events).
  Program year runs **Sep→Aug**.
- **Event model**: normalized event with `scheduling ∈ {exact, range, month}`.
  Undated "ideas" render in the left gutter (Calendar) / month footer (Overview),
  anchored to their rough week/month.
- **Three views**: `renderOverview()` (default — whole year, months as cards, weeks
  bucketed **weeknight Mon–Thu / weekend Fri–Sun**), `renderMonths()`
  (detailed month grids with a left "Ideas" gutter) and `renderList()` (an agenda:
  one row per day with anything on it, refs collapsed to one muted line, undated
  ideas closing out their month). `applyView()` shows `curView()`, which is
  `state.view` — except **phones (≤600px, `PHONE_MQ`) always get the list**.
- **Editor = a section-model workspace** (`SECTIONS` registry; rail + `#wpanel`):
  live sections **Details** (the Eventbrite listing only, in listing order:
  Title, Summary, Description, When, Where — with the Address on listing toggle
  and its hints inside the Where block — and **Ticketing** (`ticketingGroupHTML`:
  the "Free tickets" field = Coda column `Capacity`, plus a muted "Paid tickets and
  discount codes: coming later"). Every listing field shows and is editable at
  every stage (R27); approval gates only Add to Eventbrite/Publish (readiness).
  The listing card `#listingCard` sits on top at every stage with **Preview
  listing** (`data-pv-open` → `openPreview`): before the event is on Eventbrite a
  modest "Not on Eventbrite yet" row and a preview built from the form
  (`ListingPreview.fromForm` in `web/listing-preview.js` → the Worker
  `previewModel` shape, node-tested); once on Eventbrite the Worker's
  `/eventbrite/preview` (Eventbrite's draft data). Both render through
  `previewBodyHTML` (text escaped, description via `ListingHtml.sanitize`)),
  **Planning** (SECTIONS id `planning`; legacy `?section=notes` maps to it;
  label changed from "Planning Notes" 2026-11: Program(s) +
  Leads side by side, **Internal description** (`description`), then the notes
  doc — the fields take the same cancelled/past lock as Details, the doc only the
  cancelled one), **Potluck & Volunteers** and **Attendees**
  (`renderAttendees`/`wireAttendees` — lead-only live roster of Eventbrite orders ∪
  gather claimants via Worker `GET /roster/:rowId`, segment chips from
  `web/roster-lib.js`, **Copy emails** / **Email** = `mailto:` BCC; leads send from
  their own accounts, no Worker-side sending), plus a muted **Coming soon** group
  (Budget/Comms/Feedback) whose panels host the feedback board. Field markup comes
  from shared builders (`titleFieldHTML`, `programsFieldHTML`, `whereGroupHTML`, …)
  used by `renderDetails`, `renderPlanningTab` and the create form
  (`renderPlanning`, which keeps every field in its old order); `wireEventFields`
  wires whichever are rendered. `openEditor(ev, section)` resets to Details unless a
  section is passed; `readForm()` null-guards every field (only the active
  section's inputs exist in the DOM) and falls back to the event's own values.
  **Header**: title, then the first program as a tag in its own color (+N), the
  first line of the Internal description as a subtitle (`paintHeadMeta`, helpers in
  `web/editor-head.js`, live as you type), then the status badge and icons. The
  editor runs a compact scale (`:is(.modal.ws,.modal.create)` rules in
  `styles.css`); phones keep 44px tap targets.
- **Status state machine** (`Status` ∈ Draft/Proposed/Approved/Cancelled; *Live*
  = approved+EB-published and *Past* = date passed are DERIVED, not stored).
  Action-driven, not a dropdown: the footer is a wizard (`ListingRules.footerModel`
  in `web/listing-readiness.js`, painted by `renderEditorFooter`). Row 1 = the five
  steps (Draft → Proposed → Approved → On Eventbrite → Published), full width.
  Row 2 = what's next (title/sub/links to blocking fields) on the left, with the one
  primary action and **⋮** on the right, bottom-aligned (the only secondary is the
  registrant-email offer's "Not now"). Off Details the footer is one line on what
  the tab is for (`SECTIONS[].foot`) + **⋮** (plus an in-flight Saving…). **⋮** holds **Delete event** before publishing and **Cancel event…**
  / **Unpublish** after (never both). Approve is gated server-side (Tribal Council).
  Header = the status badge (`statusInfo`, from the same `stageOf` as the steps, so
  it repaints with the footer; a button that opens the lifecycle guide) + ? / View
  in gather / Copy link icons (`transitionTo`, `cancelEvent`, `deleteEditor`). **Cancel** tears down the
  Eventbrite listing via Worker `POST /cancel/eventbrite` (unpublish, else cancel
  +notify) then sets Status=Cancelled. A past approved event (`isHistory`: Approved
  or Live, date gone by) locks the **Details** and **Planning** fields and drops Cancel/Delete; the notes
  doc, Potluck & Volunteers and Attendees are unaffected. The lock is decided when the event
  opens (so a Council date typo can still be fixed in that session; approving a
  past-dated proposal asks first) and is enforced only in the UI — the Worker doesn't
  check it (#32), and `todayStr` is fixed at page load. Design:
  `docs/superpowers/specs/2026-08-23-status-machine-and-editor-refinements.md`.
- **Save model (create-then-workspace + on-blur autosave):** a NEW event opens a
  one-shot compact Planning modal (`openNewEventForm`, Cancel/Create) — not the
  workspace, so no premature empty rows; on Create it persists once and
  transitions into the workspace via `openEditor(saved)`. An EXISTING event's
  workspace **autosaves every field on blur** (`autosaveEditor`, debounced 800ms,
  in place — modal stays open) and **writes only the columns whose form value
  changed**: `formCells(readForm())` vs `_form.base` (the form as last queued;
  `_form` = `{ev, base}`, bound to its event), diffed by `SaveQueue.changedCells`.
  That's only the user's edits: nothing read from Eventbrite is ever put into the
  form or written (D4 — the old live re-seeding once wiped Capacity); field sync
  status compares the form with `ev.pushed` (`Last EB pushed values`, written only
  by the Worker). It never writes Status (only `transitionTo`/`cancelEvent` do) — a
  whole-row write once blanked relations and undid approvals (#24). Writes go
  through **`saveQueue`** (`web/save-queue.js`, node-tested in
  `proxy/test/save-queue.test.js`): per event, one write in flight, later edits
  coalesce, a failed write rides along with the next one; no global saving flag.
  `_unsaved` (`id → {ev, before}`) keeps an edited event's local copy through
  re-fetches until it saves (then the `_recent` guard; `scheduleReconcile` pulls
  server truth). A failed save stays retryable only while its editor is open; when
  the editor goes (`leaveForm`/`close`, after one more try) `dropFailedEdits` puts
  back only the fields the failed edits changed — what did save (a create, a status
  change) stays, re-guarded by `_recent` against Coda's list lag — and toasts. A
  stale local copy must never linger (one once let a Propose undo an approval). A
  401 retries after sign-in (`_authRetry`); a 404 is an ordinary failure (Coda can
  404 a row created seconds ago). Relations arrive as names and `mapRelations` maps them to row ids; an
  event stays `_lossy` until every reference list is loaded and its names all
  map, and meanwhile the editor waits ("Loading…", first visit) or shows
  Program(s)/Leads/Where read-only (`relationsReady`) — a picker seeded from a
  partial map would save a partial list. Saving shows only in the footer's primary
  button: **Saving…** while anything is pending (`pendingFor`), **Still saving…**
  after CodaApplied's 20 s slow mark. A step under way (`_busy` + `_busyLabel`:
  Propose/Approve/Reopen/Cancel/Delete/Unpublish/push) shows there too, with the
  secondary and ⋮ disabled, and no busy toast. The `#saveStatus` pill shows only
  **Save failed — retry** (click to retry); when nothing says Saving, it's saved.
  `close()` — and every opener that replaces the modal, via `leaveForm()` —
  queues a pending edit so a fast Done/Esc/✕ can't drop the last change;
  `beforeunload` (listened for only while an editor is open or a save is pending —
  `guardUnload`) queues the form and asks. Typeahead/venue pickers take an
  `onChange` (guarded against initial seeding) so chip/segment mutations schedule
  a save. Transitions/Cancel/Delete hold the event they started on (never
  `editing`, which can change mid-await; `_busy` per event) and wait for its queue
  first; a still-creating (`tmp-`) event doesn't open. The Eventbrite push
  (`pushToEventbrite`: Add to Eventbrite / Update draft / Publish / Update listing)
  calls `flushAutosave()`, then waits until `pendingFor` is false (every edit
  applied), and stops if a save fails (the Worker reads Coda). It adopts the
  `pushed` snapshot the Worker returns (never recomputed); `refreshEbStatus` reads
  registrants + edited-on-Eventbrite for display only.
  Design/plan:
  `docs/superpowers/specs|plans/2026-08-23-workspace-save-pattern*` (the queue and
  partial writes replaced its snapshot-and-rewrite save in #24).
- **URL deep-links**: `?event=<rowId>&section=<id>` two-way synced (`syncUrl`/
  `clearUrl`/`openFromUrl`); a **Copy link** header button shares the current view.
- **Feedback/Ideas board** (`feedbackBoardHTML`/`wireFeedback`): a votable roadmap
  board — a global header CTA (`#feedbackBtn`) + a context-tagged board in each
  coming-soon section. Backed by the Coda `Roadmap Feedback` table
  (`grid-pP5rwauO2j`) via Worker `GET/POST /feedback` + `POST /feedback/:id/vote`
  (new var `CODA_FEEDBACK_TABLE`). Design/plan:
  `docs/superpowers/specs|plans/2026-08-22-event-workspace*`.
- **Help drawer** (`openHelp(id)` / `closeHelp` / `renderHelp` — the HELP block near
  the end of `app.js`): a right-side drawer that renders `web/help/guide.md` +
  `whats-new.md` through `HelpLib` (`web/help/help-lib.js`). Entry points: the header
  **?** (`#helpBtn`), the editor header's **?** (`data-act="help"` → the active
  section's `SECTIONS[].help`), the create form's **?**, the status badge
  (`data-help="lifecycle"`), the sign-in "New here?" link, `?help=<id>`, and a
  once-per-device Welcome on first sign-in (`est-help-welcomed`); a What's-new dot
  (`est-help-seen`). The calendar key is the guide's live `{{legend}}` embed
  (`legendEmbedHTML`). App code names a guide ONLY via `openHelp('<id>')`,
  `help:'<id>'` or `data-help="<id>"` — the forms the guard checks. On wide screens
  (≥1000px) the open drawer pushes the page aside (`body.help-open` padding) rather
  than covering it.
- **Tooltips**: any element with `data-tip` gets the shared bubble (`showTip`/
  `hideTip`) on hover and keyboard focus — use it, not `title=`, for icon buttons.
- **Header + calendar settings (⚙)**: row 2 is view switch + year picker, then ↻,
  ⚙ (`#ovfBtn`) and **+ New event** at the far right. ⚙ opens `#ovfPanel`, which
  holds the layer toggles (`#layers`, `renderLayers`).
- **Phones (≤600px)**: both header rows hide; `.phonebar` is one row — "EST
  Planning" + ☰ (`#menuBtn`). ☰ opens `#menuPanel` (`phoneMenu`/`wirePhoneMenu`):
  account (rendered by `renderAuth` alongside the desktop avatar menu), Help,
  Feedback / Ideas (`openFeedback`), program year (`#menuYr`), and a second copy of
  the layer toggles (`#menuLayers` — `renderLayers`/`syncLayerToggles` keep both
  copies in step). A floating **+** (`#fabAdd`, `addEvent`) replaces + New event.
  The CSS breakpoint and `PHONE_MQ` must stay the same width.
- **Adding from the calendar**: only the revealed **+** buttons add — `.cell-add`
  (days), `.gadd` (Ideas column), `.zone-add` (Overview lanes); clicking the rest of
  a day or lane does nothing.
- **`layoutSticky()`**: measures header heights into `--bar-h`/`--wh-h` so the
  sticky weekday row + month headers stack correctly; self-corrects on load,
  resize, view switch, and Help opening/closing.


## Gotchas (things that already bit us)

- `web/listing-readiness.js` is imported by the Worker: keep it free of DOM/browser globals; editing it redeploys the Worker.
- All calendar grid columns use `minmax(0,1fr)`, **not** bare `1fr` — that's what
  keeps columns equal and clips long chips instead of stretching. Don't revert.
- **Class-name collision watch:** the month grid is `.mgrid`; the modal body is
  `.mbody`. Keep them distinct (they collided once and broke the calendar grid).
- Coloring is intentional: planning events by **program** (hue), **status** by
  chip treatment (dashed→tint→solid→filled; no 🔒 — approved isn't locked for leads, decision 5); reference calendars muted.
- `localStorage` holds only caches (`est-cache-*`) and per-device UI state (the
  help drawer's `est-help-welcomed` / `est-help-seen`, and `est-view-prefs` — the
  layer toggles someone has switched + their view above phone width; untouched
  layers follow Coda's `Default on`); real persistence comes from the Coda
  backing, never browser storage.
- After any JS edit, run `./scripts/check.sh` (syntax, shared mirrors, help guard,
  structural rules). The Stop hook runs it too.
- **The Worker caches Coda reads in KV (stale-while-revalidate).** Coda calls run
  100s of ms with multi-second (observed 60s) tails, and per-isolate memory
  caches evaporate on isolate recycle — so `swrGet` in `proxy/src/worker.js`
  persists snapshots in the `CACHE` KV namespace (free tier): the **slim People
  projection** (auth/sign-in — soft 5m/hard 30m, patched in place on member
  create; now also carries `Active Member?` — `PEOPLE_KV_KEY` is `people-slim-v3`,
  bump it on any slim-shape change), **/rows** (soft 30s/hard 5m — busted on every planning write incl.
  publish/cancel/notes-doc; `?fresh=1` bypasses for the notes-doc fast-poll),
  **/ref/***, **/references**, and **/roster/:rowId** (soft 60s/hard 5m per event
  — busted by the claim write routes via the slot's Event relation; `?fresh=1` for
  the refresh button; the value holds raw registrant emails, server-side only).
  When adding a Worker write path that mutates
  planning rows, bust `ROWS_KV_KEY`. Cache API is a no-op on workers.dev (no
  Cloudflare zone — DNS stays at Hover), which is why KV.
- **Coda `valueFormat=rich` fences text values in triple backticks** (```` ```Main dish``` ````)
  and backslash-escapes markdown punctuation. Every rich read must unwrap via
  `stripRich` in `proxy/src/gather.js` — `plain()`/`relName()` already do; never
  pass a rich cell string to output any other way (this once leaked ```-fenced
  titles/labels into both apps).
- **Reference Coda columns by stable *id*, not name** — column names change freely
  in the doc and silently break name-keyed reads. IDs live in one place,
  `proxy/src/coda-columns.js` (each id commented with its human name); read rows
  with `useColumnNames=false` (`readAllRows(..., { byId:true })`) and write cells
  with `{ column: <id> }`. **Done:** the auth path (`resolvePerson`/`peopleRows` —
  a People-column rename would otherwise break sign-in + role-gating) and all new
  gather code. **Deferred id-hardening (still name-keyed — convert opportunistically,
  with live verification):** (a) the planning read/write seam
  (`planningRowToEvent`/`eventToCodaCells` + the Worker `/rows`) — ideally moved
  server-side so the UI stops learning the Coda row shape (decision #4); (b) the
  generic `/ref` reads (programs/people/venues), the Eventbrite payload builders,
  and the feedback `Voters` write.


## Worker (proxy) at a glance

Deployed at `est-planning-proxy.eastsidetribe.workers.dev` (CI deploys on merge; never
from a session). **Doc-scoped read+write** token, `ALLOW_WRITES="true"`,
`FIREBASE_PROJECT_ID` set, CORS locked to an allowlist (the app origin +
`localhost:8080` for local dev). Serves `GET /rows`, `GET /ref/:name`, `GET /me`
(verifies the Firebase ID token → matches email to `EST People SRC` → role),
`GET /roster/:rowId` (lead-only attendee roster: live Eventbrite orders + gather claims,
resolved to People by `All Emails`, Active Member? badge from `c-yJfWc0GMsQ`),
`GET /mutation/:id` (has Coda applied a write), the Eventbrite routes
(`/publish/eventbrite`, `/cancel/eventbrite`, unpublish, `/eventbrite/preview`), and
role-gated writes that inject person attribution. Points at `EST Planning Events SRC`
(`grid--gYIvdD-cE`).

Mission Control doc: `DYAz_wCVfv` (`superhuman://docs/DYAz_wCVfv`). Source tables:
`EST Planning Events SRC` (`grid--gYIvdD-cE`), `EST Events SRC` (`grid-9TAt5vMMKH`),
`EST Programs SRC` (`grid-g87NFbtqN8`), `EST People SRC` (`grid-X316Eql8dE`),
`Roadmap Feedback` (`grid-pP5rwauO2j`).
