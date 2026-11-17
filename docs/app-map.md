# App map — how `web/` is built

Moved out of CLAUDE.md on 2026-11-16 so it isn't loaded on every task. Read it before
changing the app. `web/app.js` was split into small files (event-page work, Phase 1,
no behavior change); this page is the file map, in load order, with the facts about
each piece kept under the file that owns it.

Terms: `docs/GLOSSARY.md`. Why things are the way they are: `docs/decisions/`.

`web/` is `index.html` + `styles.css` + plain `<script>` files that share globals
(buildless: no modules, no imports). Each file starts with a header comment — **Owns**
(names other files use), **Reads/Writes** (shared mutable state from other files),
**Loaded after** (why its place in the order matters). `./scripts/check.sh` keeps every
`web/*.js` at 800 lines or fewer.

## Adding a file

- Scripts load in the order `index.html` lists them. A new file's `<script src>` goes
  where its top-level statements belong: top-level statements that *run at load*
  (listener registrations, the `prefs.layers` fix-up, `init()`) keep their original
  relative order, and a file must not run anything at load that a later file declares
  (`const`/`let` are not yet defined there). `init();` (main.js) is the last statement.
  Functions only used at call time can live anywhere.
- The four Escape `keydown` handlers run in this order: `preview.js` (closes only the
  preview) → `editor-close.js` (`requestClose` when the modal is open; on the event page
  it only hides the leave bar) → `editor-close.js` ⋮ menus (the panel's `#edMenu` and the top bar's `#epMenu`, one listener) → `help.js`.
  Three of them call `stopImmediatePropagation`, so reordering changes which one
  wins. (`ui.js` hides the tooltip and `shell.js` closes the ⚙/account menus on Escape
  too; neither stops propagation.)
- Update the file's header and this page when you add, move or rename things.

## The event page (2026-11)

A planning event opens as a full page, `#eventPage` (`index.html`), shown in place of
the calendar; the calendar DOM stays mounted and hidden (`body.event-open` hides its
chrome), so its view, year and scroll survive. Spec:
`docs/superpowers/specs/2026-11-16-event-page-design.md`.

- **Containers** (stable, filled with `innerHTML`, D1): `#epTop` (← Calendar `#epBack`,
  the program stripe, title + `#epTag` program tag + `#epSub` subtitle (`paintHeadMeta`),
  `#epBadges` status badge, `#epActions` ? / View in gather / Copy link icons — wide and
  mid layouts — and `#epMenu`, the phone layout's ⋮ with the same three actions,
  `headMenuHTML`/`headMenu` in editor-close.js; both sets are painted, CSS shows one), `#epTabs`
  (the tab list, `railHTML`; a sticky horizontal strip at mid and phone layouts),
  `#epMain` (`#edGuard` leave bar, `#epHead` tab heading = label + `SECTIONS[].foot`,
  `#wpanel` the active tab), `#epPanel` (the one Status & next step card,
  `statusPanelHTML`, ending with the listing row `#listingCard`), and `#epPhoneBar`
  (phone layout: `placePhoneBar` moves `#edActs` + `#edMenu` here).
- **Layouts** (polish 2026-11-16): CSS container queries on `#eventPage`'s own width
  (styles.css → "event page layouts", the one place the numbers live, so Help open
  counts): **wide** ≥1100px tab list | main | panel; **mid** 760–1099 tab strip, then
  main | panel (280px, sticky); **phone** <760 status card, tab strip, the tab, bottom
  bar. JS reads the answer from `--ep-layout` (`epLayout()`, status-panel.js); a
  ResizeObserver calls `layoutEventPage()` when it changes. 44px tap targets follow the
  device, not the layout: `@media (pointer:coarse), (max-width:600px)`.
- **Planning** (`SECTIONS[].fill:'scroll'`): the same viewport-tall page (`ep-fill` +
  `ep-scroll`), but the tab scrolls inside `#wpanel` and the notes doc (`.ndoc-fld`)
  takes the height left below the fields, at least 420px.
- **List tabs** (`SECTIONS[].fill`: Potluck & Volunteers, Attendees): `renderSection`
  sets `#eventPage.ep-fill`; the page is then exactly the viewport tall and only the
  list scrolls (`.slots-list`, `.roster-body`), with its filters, group headings
  (`.slot-group-hd`, sticky) and the Attendees footer staying put.
- **Still modals** (`#scrim`/`#modal`): the create form, reference events, the day
  picker, Feedback, other loading states; Preview stays an overlay above the page.
- **Routing**: see `editor.js` → *URL deep-links + history* below. Esc doesn't leave
  the page (it only hides the leave bar); ← Calendar, Back and other openers go through
  `leaveGuard` → `leaveEventPage`/`leaveForm`.
- **Phone layout**: no side panel; the status card sits above the tab strip
  ("Step N of 6 · see all steps", `toggleSteps`), its listing row included, and the
  next-step button + ⋮ sit in `#epPhoneBar`. `layoutEventPage()` re-homes them when
  the layout changes.
- **List view: Needs approval** (`calendar.js`): `#listBar` (shown with the List view
  by `applyView`) holds the toggle (`listBarHTML`); on, `renderList` keeps only
  `PageRules.needsApproval` events (Proposed planning events) and hides reference
  dates. Per device in `est-view-prefs` (`prefs.needsApproval`).

## File map (load order)

Before `util.js` (pure helpers; the ones marked **[node-tested]** have a test in
`proxy/test/`): `auth-firebase.js` (module; Firebase bridge, mirrored from `shared/`),
`roster-lib.js` **[node-tested]** (attendee segments + mailto helpers),
`help/help-lib.js` **[node-tested]** (guide parser/renderer), `listing-readiness.js`
**[node-tested]** (shared publish rules; also imported by the Worker, so no DOM),
`listing-html.js` **[node-tested]** (description sanitizer), `listing-preview.js`
**[node-tested]** (preview model before Eventbrite), `coda-applied.js` **[node-tested]**
(honest-save poller), `save-queue.js` **[node-tested]** (per-event save queue),
`editor-head.js` **[node-tested]** (header meta), `page-rules.js` **[node-tested]** (section aliases, step notes, needs-approval).

1. **`util.js`** — pure helpers: `esc`, `cap`, date/time formatting, `linkify`, `cssColor`.
2. **`data.js`** — reference lists, local cache, the Coda seam, `CodaSource`.
- **Data layer**: `PROGRAMS`/`PEOPLE` (built-in palette + editor picker seeds,
  the programs list is replaced live from `/ref/programs`), `MOCK_REFS` (built-in
  holiday/partner overlays, still awaiting Hebcal), `planningRowToEvent` /
  `eventToCodaCells`, and **`CodaSource`** — the single live data source hitting
  the proxy. `const DB = CodaSource;` (the in-memory mock was removed).
3. **`pickers.js`** — `initTypeahead` (Leads/Volunteers) and `initVenuePicker`.
4. **`state.js`** — prefs, the `state` object, program-year dates, `loadEvents`, the `_recent`/`_unsaved` local-copy guards, refs settling, date bucketing.
- **State**: `state` object (program year, current view, layers, role, events).
  Program year runs **Sep→Aug**.
- **Event model**: normalized event with `scheduling ∈ {exact, range, month}`.
  Undated "ideas" render in the left gutter (Calendar) / month footer (Overview),
  anchored to their rough week/month.
5. **`calendar.js`** — the Calendar (months), Overview and List views.
- **Three views**: `renderOverview()` (default — whole year, months as cards, weeks
  bucketed **weeknight Mon–Thu / weekend Fri–Sun**), `renderMonths()`
  (detailed month grids with a left "Ideas" gutter) and `renderList()` (an agenda:
  one row per day with anything on it, refs collapsed to one muted line, undated
  ideas closing out their month). `applyView()` shows `curView()`, which is
  `state.view` — except **phones (≤600px, `PHONE_MQ`) always get the list**.
  The List's **Needs approval** toggle (`#listBar`, `listBarHTML`) is described under
  *The event page* above.
6. **`editor-tabs.js`** — the open event (`editing`), the `SECTIONS` registry, the tab list, the tab heading (`#epHead`: label + `SECTIONS[].foot`), `renderSection`. The editor files `editor.js`, `fields.js` and `tabs-listing-planning.js` (files 10–12, loaded after `notes-doc.js`, `field-markers.js` and `preview.js`) and the tab files share this editor description:
- **Editor = a section-model page** (`SECTIONS` registry; tab list `#epTabs` + `#wpanel`):
  live sections **Listing** (SECTIONS id `details`; labeled "Details" until 2026-11; a red dot (`.tab-dot`) when a readiness link is a Listing field; the Eventbrite listing only, in listing order:
  Title, Summary, Description, When, Where — with the Address on listing toggle
  and its hints inside the Where block — and **Ticketing** (`ticketingGroupHTML`:
  the "Free tickets" field = Coda column `Capacity`, plus a muted "Paid tickets and
  discount codes: coming later"). Every listing field shows and is editable at
  every stage (R27); approval gates only Add to Eventbrite/Publish (readiness).
  The listing row `#listingCard` is the last line of the Status & next step card
  (`listingCardHTML`: badge, link-style **Preview listing** (`data-pv-open` → `openPreview`),
  View on Eventbrite ↗ once public, the tickets line) at every stage: before the event
  is on Eventbrite a "Not on Eventbrite yet" badge and a preview built from the form
  (`ListingPreview.fromForm` in `web/listing-preview.js` → the Worker
  `previewModel` shape, node-tested); once on Eventbrite the Worker's
  `/eventbrite/preview` (Eventbrite's draft data). Both render through
  `previewBodyHTML` (text escaped, description via `ListingHtml.sanitize`)),
  **Planning** (SECTIONS id `planning`; legacy `?section=notes` maps to it;
  label changed from "Planning Notes" 2026-11: Program(s) +
  Leads side by side, **Internal description** (`description`), then the notes
  doc — the fields take the same cancelled/past lock as Listing, the doc only the
  cancelled one), **Potluck & Volunteers** and **Attendees**
  (`renderAttendees`/`wireAttendees` — lead-only live roster of Eventbrite orders ∪
  gather claimants via Worker `GET /roster/:rowId`, segment chips from
  `web/roster-lib.js`, **Copy emails** / **Email** = `mailto:` BCC; leads send from
  their own accounts, no Worker-side sending), plus a muted **Coming soon** group
  (Budget/Comms/Feedback) whose panels host the feedback board. Field markup comes
  from shared builders (`titleFieldHTML`, `programsFieldHTML`, `whereGroupHTML`, …)
  used by `renderDetails`, `renderPlanningTab` and the create form
  (`renderPlanning`, which keeps every field in its old order); `wireEventFields`
  wires whichever are rendered. `openEditor(ev, section)` resets to Listing unless a
  section is passed; `readForm()` null-guards every field (only the active
  section's inputs exist in the DOM) and falls back to the event's own values.
  **Header**: title, then the first program as a tag in its own color (+N), the
  first line of the Internal description as a subtitle (`paintHeadMeta`, helpers in
  `web/editor-head.js`, live as you type), then the status badge and icons; the phone
  layout shows only ← Calendar, the title and ⋮ (`#epMenu`). The
  editor runs a compact scale (`:is(.event-page,.modal.create)` rules in
  `styles.css`); phones keep 44px tap targets.
7. **`notes-doc.js`** — the Planning tab's Google Doc notes block (embed/create button, polling, the Coda button push).
8. **`field-markers.js`** — Eventbrite sync icons, hints and tags on field labels; `listingCardHTML` (the status card's listing row).
9. **`preview.js`** — the Preview listing overlay and its Esc-closes-only-the-preview listener.
10. **`editor.js`** — stage badge, `editorCtx`, header meta, `openEditor` (a planning event → `openEventPage`, the
    event page `#eventPage` in place of the calendar; a reference event → the modal), the create flow, URL sync.
- **URL deep-links + history**: `?event=<rowId>&section=<id>`. In-app opens push an
  entry stamped `{event, inApp:true}` (`writeHistory`); tab switches and URL-driven opens
  replace the URL and keep the entry's state (`syncUrl`). ← Calendar is `history.back()`
  on our stamp, else pushes the calendar URL (`leaveEventPage('back')`). `onPopState`
  (editor-close.js) closes/opens the page on Back/Forward, re-pushing the page's entry when
  the leave guard holds. `openFromUrl` opens a deep link (unknown id: toast + calendar).
  `history.scrollRestoration` is manual: the app restores the calendar's scroll. A **Copy
  link** header button shares the current view.
11. **`fields.js`** — one HTML builder per field, the create-form panel, `wireEventFields`, `readForm`.
12. **`tabs-listing-planning.js`** — the Listing and Planning panels and the private-home address-default rules.
13. **`tab-attendees.js`** — the Attendees tab (the roster is described under `editor-tabs.js` above).
14. **`tab-potluck.js`** — the Potluck & Volunteers tab: the gather slot builder and its claims.
15. **`feedback.js`** — the votable Feedback / Ideas board and its modal.
- **Feedback/Ideas board** (`feedbackBoardHTML`/`wireFeedback`): a votable roadmap
  board — a global header CTA (`#feedbackBtn`) + a context-tagged board in each
  coming-soon section. Backed by the Coda `Roadmap Feedback` table
  (`grid-pP5rwauO2j`) via Worker `GET/POST /feedback` + `POST /feedback/:id/vote`
  (new var `CODA_FEEDBACK_TABLE`). Design/plan:
  `docs/superpowers/specs|plans/2026-08-22-event-workspace*`.
16. **`ui.js`** — toasts and the shared tooltip bubble.
- **Tooltips**: any element with `data-tip` gets the shared bubble (`showTip`/
  `hideTip`) on hover and keyboard focus — use it, not `title=`, for icon buttons.
17. **`save.js`** — the save model, the save pill, `leaveForm`, the unload guard.
- **Save model (create-then-page + on-blur autosave):** a NEW event opens a
  one-shot compact create modal (`openNewEventForm`, Cancel/Create) — not the
  event page, so no premature empty rows; on Create it persists once, closes the
  modal (`closeModal`) and opens the event's page via `openEventPage(saved)`. An
  EXISTING event's page **autosaves every field on blur** (`autosaveEditor`,
  debounced 800ms, in place — the page stays open) and **writes only the columns whose form value
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
  the page goes (`leaveEventPage` — ← Calendar, Back, opening another event — via
  `leaveForm`, after one more try) `dropFailedEdits` puts
  back only the fields the failed edits changed — what did save (a create, a status
  change) stays, re-guarded by `_recent` against Coda's list lag — and toasts. A
  stale local copy must never linger (one once let a Propose undo an approval). A
  401 retries after sign-in (`_authRetry`); a 404 is an ordinary failure (Coda can
  404 a row created seconds ago). Relations arrive as names and `mapRelations` maps them to row ids; an
  event stays `_lossy` until every reference list is loaded and its names all
  map, and meanwhile the editor waits ("Loading…", first visit) or shows
  Program(s)/Leads/Where read-only (`relationsReady`) — a picker seeded from a
  partial map would save a partial list. Saving shows only in the panel's primary
  button: **Saving…** while anything is pending (`pendingFor`), **Still saving…**
  after CodaApplied's 20 s slow mark. A step under way (`_busy` + `_busyLabel`:
  Propose/Approve/Reopen/Cancel/Delete/Unpublish/push) shows there too, with the
  secondary and ⋮ disabled, and no busy toast. The `#saveStatus` pill shows only
  **Save failed — retry** (click to retry); when nothing says Saving, it's saved.
  `leaveEventPage()` (← Calendar) — and every opener that replaces the page or the
  modal, via `leaveForm()` — queues a pending edit so a fast exit can't drop the last change;
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
18. **`status-panel.js`** — the event page's **Status & next step** panel (`ListingRules.footerModel` painted into stable containers by `renderStatusPanel`), the ⋮ menu, `epLayout`/`layoutEventPage`, `focusField`.
19. **`transitions.js`** — `transitionTo`, `cancelEvent`, delete, the Eventbrite-cancel bar. The status state machine (this file and `status-panel.js`):
- **Status state machine** (`Status` ∈ Draft/Proposed/Approved/Cancelled; *Live*
  = approved+EB-published and *Past* = date passed are DERIVED, not stored).
  Action-driven, not a dropdown: the right panel's **Status & next step** card
  (`ListingRules.footerModel` in `web/listing-readiness.js`, painted by
  `renderStatusPanel` into `#edStatus`, `#edChecks`, `#edActs`, `#edMenu`, `#edSub`,
  `#edBars`) shows on every tab: the six steps as a vertical checklist (Draft →
  Proposed → Approved → On Eventbrite → Published → Past; Past is current once
  `past`, with Eventbrite steps never reached shown skipped) with who/when notes
  (`PageRules.stepNotes`), the title and the readiness rows (`checklist`: ✓ label, or
  ✗ a link that focuses the field, switching tabs), the one primary action and **⋮**
  (the only secondary is the registrant-email offer's "Not now"), one sentence
  (`sub`), and the Eventbrite-cancel bar (`#edBars`). Listing gets a red dot when a
  readiness link is a Listing field. The card ends with the listing row
  (`#listingCard`); below it, the `#saveStatus` pill (failed save only). **⋮** holds **Delete event** before publishing and **Cancel event…**
  / **Unpublish** after (never both). Approve is gated server-side (Tribal Council).
  Header = the status badge (`statusInfo`, from the same `stageOf` as the steps, so
  it repaints with the panel; a button that opens the lifecycle guide) + ? / View
  in gather / Copy link icons, or on the phone layout ⋮ with the same three
  (`transitionTo`, `cancelEvent`, `deleteEditor`). **Cancel** tears down the
  Eventbrite listing via Worker `POST /cancel/eventbrite` (unpublish, else cancel
  +notify) then sets Status=Cancelled. A past approved event (`isHistory`: Approved
  or Live, date gone by) locks the **Listing** and **Planning** fields and drops Cancel/Delete; the notes
  doc, Potluck & Volunteers and Attendees are unaffected. The lock is decided when the event
  opens (so a Council date typo can still be fixed in that session; approving a
  past-dated proposal asks first) and is enforced only in the UI — the Worker doesn't
  check it (#32), and `todayStr` is fixed at page load. Design:
  `docs/superpowers/specs/2026-08-23-status-machine-and-editor-refinements.md`.
20. **`eventbrite.js`** — the Eventbrite push (`pushToEventbrite`), registrants/edited status, publish checks.
21. **`editor-close.js`** — the leave guard, `requestClose`/`closeModal` (the modal), `leaveEventPage`/← Calendar (the
    event page: shows the calendar again at its scroll position), the modal footer's and the panel's action dispatch, ⋮ menu keys, header actions.
22. **`shell.js`** — the app shell: layer toggles, `#months`/`#quarter` click delegation, day picker, `layoutSticky`, view switch (`curView`, `applyView`, `PHONE_MQ`), year nav, `addEvent`, and the ⚙ (`ovfMenu`) and ☰ (`phoneMenu`) menus.
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
23. **`auth.js`** — Firebase sign-in: token lifecycle, `/me` identity and roles (`fetchMe`), the sign-in gate, the account menu, `refreshEditorRole`, `initAuth`.
24. **`help.js`** — the Help drawer.
- **Help drawer** (`openHelp(id)` / `closeHelp` / `renderHelp` — `web/help.js`): a right-side drawer that renders `web/help/guide.md` +
  `whats-new.md` through `HelpLib` (`web/help/help-lib.js`). Entry points: the header
  **?** (`#helpBtn`), the event page's **?** icon (`#epActions`, wide and mid layouts)
  and, on the phone layout, its ⋮ → Help for this tab (`#epMenu`; both `data-act="help"`
  → the active section's `SECTIONS[].help`), the create form's **?**, the status badge
  (`#epBadges`, wide and mid; `data-help="lifecycle"`), the sign-in "New here?" link, `?help=<id>`, and a
  once-per-device Welcome on first sign-in (`est-help-welcomed`); a What's-new dot
  (`est-help-seen`). The calendar key is the guide's live `{{legend}}` embed
  (`legendEmbedHTML`). App code names a guide ONLY via `openHelp('<id>')`,
  `help:'<id>'` or `data-help="<id>"` — the forms the guard checks. On wide screens
  (≥1000px) the open drawer pushes the page aside (`body.help-open` padding) rather
  than covering it.
25. **`main.js`** — `refresh`, `init`, and the final `init();`.

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
  generic `/ref` reads (programs/people; `/ref/venues` and the publish route's
  venue read went by-id with the venues work), the Eventbrite payload builders,
  and the feedback `Voters` write.


## Worker (proxy) at a glance

Deployed at `est-planning-proxy.eastsidetribe.workers.dev` (CI deploys on merge; never
from a session). **Doc-scoped read+write** token, `ALLOW_WRITES="true"`,
`FIREBASE_PROJECT_ID` set, CORS locked to an allowlist (the app origin +
`localhost:8080` for local dev). Serves `GET /rows`, `GET /ref/:name`, `GET /me`
(verifies the Firebase ID token → matches email to `EST People SRC` → role),
`GET /roster/:rowId` (lead-only attendee roster: live Eventbrite orders + gather claims,
resolved to People by `All Emails`, Active Member? badge from `c-yJfWc0GMsQ`),
`GET /mutation/:id` (has Coda applied a write), the venue routes (all `canWrite`, read
and written by column id via `VENUE_COLS`, pure parts in `proxy/src/venues.js`, writes
bust `ref-venues-v2`): `GET /venues/:rowId` (one venue's structured address for the edit
form — addresses never go in the shared `/ref/venues` list), `POST /venues` (add a venue:
name required and unique case/space-insensitively → else 409, type must be a Venue Types
row, address via `web/venue-address.js` — blank only for a Home; returns `{id, requestId}`)
and `PUT /venues/:rowId` (change the address; also clears both cached Eventbrite venue ids;
returns `{requestId}`); every venue write also sets the composed `Address`. The Eventbrite routes
(`/publish/eventbrite`, `/cancel/eventbrite`, unpublish, `/eventbrite/preview`), and
role-gated writes that inject person attribution. Points at `EST Planning Events SRC`
(`grid--gYIvdD-cE`).

Mission Control doc: `DYAz_wCVfv` (`superhuman://docs/DYAz_wCVfv`). Source tables:
`EST Planning Events SRC` (`grid--gYIvdD-cE`), `EST Events SRC` (`grid-9TAt5vMMKH`),
`EST Programs SRC` (`grid-g87NFbtqN8`), `EST People SRC` (`grid-X316Eql8dE`),
`Roadmap Feedback` (`grid-pP5rwauO2j`).
