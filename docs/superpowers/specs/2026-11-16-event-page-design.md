# Event page: a full page with a status panel

**Status:** design agreed with Eric on 2026-11-16 (design canvas https://claude.ai/artifact/AeaeVySLeUM866d1emm8Ct, page "Full page + drawer (Nov 16)", boards A1–A3). Builds on PR #35 (`feat/publish-wizard`). Ships with it: this branch stacks on that one and both release together.

## 1. Why

The event editor is a large modal over the calendar. Five rounds of feedback on PR #35 kept fixing symptoms of that container: a crowded footer, a tab rail that hides what's incomplete, and steps that wrap. Research (NN/g on modals, wizards and task lists; how Shopify, Linear, Ghost, Eventbrite and Meetup edit records; GOV.UK "complete multiple tasks") pointed the same way. A record that people return to over weeks belongs on a page. Its status and next step belong in a persistent side panel, as a checklist, not a bottom-of-screen wizard.

What PR #35 got right stays as it is: the lifecycle and its rules (`ListingRules`), readiness checks with links to the field, one next action, Preview, the private-draft vs published split, honest saves, and the Details/Planning split.

## 2. Goals

- An event opens as a full page. **← Calendar** and the browser's Back button return to the calendar where you left it.
- Tabs stay: Listing, Planning, Potluck & Volunteers, Attendees, and the muted Coming-soon tabs, in a left tab list on the page. Eric's call: one long scrolling page made some sense for Listing/Planning and little for the rest. What's incomplete stays visible through the status panel (shown on every tab) and a red dot on the Listing tab.
- A right-hand **Status & next step** panel replaces the footer wizard. It holds:
  - the lifecycle as a checklist, with who and when on each finished step
  - the readiness items for the next step, as ticks with links
  - the one next-action button and **⋮**
  - the listing card with **Preview listing**
  - the failed-save message
- Phones: the panel becomes a status card at the top of the page plus a sticky next-action bar at the bottom.
- The List view gets a **Needs approval** filter, so council can scan proposed events.

## 3. Non-goals

- The quick-look drawer (option B): dropped.
- The listing-styled editor (option C): not now.
- Making saves faster. That is the separate "fast writes" branch, where the Worker remembers recent writes.
- Venues (address columns, adding a venue from the app): a separate branch.
- Changing the lifecycle, the readiness rules, the save model or any Worker route.

## 4. Anti-goals (would make this a failure even if it works)

- Losing an edit when leaving the page by any route: ← Calendar, Back, a link to another event, or closing the tab.
- The calendar losing its scroll position, view or program year after returning from an event.
- A page that's slower to open than the modal was.
- A lead not being able to tell what's left to do without scrolling.

## 5. Design

### 5.1 Routing

- The page is addressed with the existing `?event=<rowId>` link, with an optional `&section=<id>`. No hash routing is needed: Netlify serves `index.html` for `/`, and the query string already round-trips.
- Opening an event uses `history.pushState`, so Back works. Today's code uses `replaceState`.
- A `popstate` listener:
  - leaving an event URL closes the page, through the same leave path as ← Calendar
  - arriving at an event URL opens that event
- A deep link with `section=` opens that tab (`details` and `listing` both mean Listing; `notes` and `planning` mean Planning).
- **← Calendar** is `history.back()` when the event was opened from inside the app, otherwise it pushes the calendar URL. Fresh visits from a shared link still get a working ← Calendar.
- The calendar DOM stays mounted and is only hidden, so scroll position, view and year survive. `layoutSticky()` re-runs on return.

### 5.2 Containers

- **New `#eventPage`** (a page-level container, not a dialog) replaces the workspace use of `#scrim`/`#modal`.
- **Stays a modal** (`#modal`): the create form (`openNewEventForm`), reference events, the day picker, Feedback, the loading state for other modals, and the Preview overlay, which stays an overlay above the page.
- `body.event-open` hides the calendar chrome (header rows, phone bar, FAB) and shows `#eventPage`.
- The help drawer still works on top of the page and pushes it aside on wide screens, as it pushes the calendar now.

### 5.3 Page layout (desktop)

- **Top bar:**
  - ← Calendar
  - the title, the program tag (+N) and the internal-description subtitle (`paintHeadMeta`, unchanged)
  - the status badge
  - ? / View in gather / Copy link
- **Left tab list:** today's rail on the page: Listing (renamed from Details), Planning, Potluck & Volunteers, Attendees, then Budget, Comms and Feedback (muted, "soon").
  - Clicking swaps the main column, as the rail does today (`activeSection`, one tab's inputs in the DOM).
  - Listing gets a red dot when a readiness item for the next step fails (from `footerModel` links). Potluck may show an open-slot count if it's already loaded; never fetch for it.
- **Main column:** the active tab, under a heading with a one-line description of the tab (today's `SECTIONS[].foot` copy moves here from the footer). Each tab keeps its own render, wiring, fetches and lock rules, exactly as today.
- **Right panel**, `position: sticky`, about 300px wide, top to bottom:
  1. **Status & next step** card:
     - the five lifecycle steps as a vertical checklist (done ✓, current, to do)
     - who/when on done steps, where the data exists (§5.5)
     - under the current step, the readiness items for the next action as ✓/✗ rows; each ✗ is a link that switches to the field's tab and focuses it
     - then the one primary button and ⋮
     - then one sentence of help (the footerModel `sub`)
     - the registrant-email offer and the conflict/needs-Eventbrite-cancel bars render inside this card
  2. **Listing card:** today's `#listingCard` content, with Not on Eventbrite yet / Private draft / Public, the Preview listing button, View on Eventbrite, the tickets line and the edited-on-Eventbrite notice.
  3. **Save state:** shown only on failure ("Save failed — retry", clickable). Saving otherwise shows on the primary button, as in PR #35.
- Width: the main column is capped near 760px of field width for readability. The page centers between the tab list and the panel.

### 5.4 What moves where (from PR #35)

| PR #35 | Event page |
|---|---|
| Modal header | Page top bar (same content + ← Calendar) |
| Tab rail | Left tab list on the page (same behavior; "Details" renamed "Listing") |
| Footer row 1 (steps) | Panel checklist, vertical |
| Footer row 2 (title, sub, links, primary, ⋮) | Panel card: links become ✓/✗ rows; primary and ⋮ below |
| Off-Details footer line (`SECTIONS[].foot`) | Tab heading description |
| `#listingCard` above Title | Panel, below the status card |
| `#saveStatus` pill | Panel, failure only |
| Leave guard bar (in modal) | Bar at the top of the main column |

### 5.5 Who/when on the checklist

Only show what the row already records. No new Coda columns in this branch.

| Step | Shown |
|---|---|
| Draft | "by <Created by>" when set |
| Proposed | the step only (the row doesn't record who or when) |
| Approved | "by <Approved by> · <Approved at>" when set |
| On Eventbrite | "<Last EB push at>" (date) when set |
| Published | "<Last published at>" when set; plus "N of M registered" when the live status has loaded |

If the planning-event normalizer doesn't carry these fields yet, add them to `planningRowToEvent` as read-only fields. They are never written by the form; `eventToCodaCells` stays unchanged.

### 5.6 Phones (≤600px, same `PHONE_MQ`)

- No left tab list and no side panel.
- At the top, under a compact top bar (← and the title on one row; tag and badge on the next), a **status card** shows:
  - the footerModel title, e.g. "Approved · 1 thing left"
  - the first failing readiness link
  - "Step N of 5 · see all steps", which expands the full checklist inline
- Below it, the tabs become a horizontal, scrollable tab strip; the active tab's content follows.
- A **sticky bottom bar** holds the primary button and ⋮ (≥44px).
- The listing card with Preview sits at the top of the Listing section on phones.

### 5.7 Save model and leaving

- Unchanged: `saveQueue`, `pendingFor`, `applied`, `flushAutosave`, `leaveForm`, `guardUnload`, `_unsaved`/`_recent`, `dropFailedEdits`.
- Tab switching keeps today's behavior: autosave the outgoing tab, then reset `_form.base` after the new tab renders.
- The status panel is visible on every tab, so the primary action can fire from any tab. It already flushes and waits for every edit (`pushToEventbrite`, `transitionTo`), so this is safe; the readiness links switch to the field's tab first (`focusField`, from PR #35).
- Leaving through ← Calendar, Back (`popstate`), opening another event, or the create form all go through `leaveGuard` then `leaveForm`, exactly as `close()`/`openEditor` do now.
- Back with unsent Eventbrite changes: re-push the event URL to cancel the navigation, then show the leave bar. Other cases close normally.

### 5.8 List view: Needs approval

- A filter toggle in the List view's toolbar: **Needs approval** (with a count). When on, only Proposed events show, grouped by date as now. Undated ideas show at the end of their month, as now.
- It's visible to everyone (leads see what's waiting too). Off by default, and per-device remembered in `est-view-prefs` (try/catch).
- On phones, the List view is the only view, so the toggle sits at the top of the list.

### 5.9 Help

- The guide sections about the editor are rewritten for the page:
  - `#edit-details`
  - `#lifecycle`
  - `#planning`
  - `#field-markers`, where the icons are unchanged
  - `#publish`
- The calendar help gets a line on Needs approval. Add a `## <date>` entry to whats-new.
- The help guard must pass. `[[labels]]` must match on-screen text.

## 6. Constraints

- Buildless, vanilla JS, no new dependencies. `web/listing-readiness.js` stays free of DOM and browser globals, because the Worker bundles it.
- No Worker changes and no Coda schema changes.
- Every rule from PR #35's spec still holds:
  - D1: stable containers, inner HTML only
  - D3: Saved = applied
  - D4: nothing from Eventbrite is written
  - D6: the panel is painted from `footerModel`; extend the model, don't fork it
- Tooltips use `data-tip`. Phones keep 44px targets. Light and dark themes both work.

## 7. Left to the builder

- The exact CSS: widths, spacing, sticky offsets. Match the compact scale from PR #35.
- Whether `footerModel` returns the vertical checklist directly (`steps` already has done/current/todo), or the panel maps from it.
- Whether the old `#scrim/#modal` workspace CSS (`.modal.ws`) is deleted or left for the create form; delete what's unused.

## 8. Settled during the builder check (my calls, for Eric to check)

1. **Who/when data is already readable.** `/rows` returns full rows. Checked on the local Worker: `Created by`, `Approved by`, `Approved at`, `Last published at` and `Last EB push at` are all present. This is a normalizer-only change, with no Worker work.
   - `Approved at` is a date (`YYYY-MM-DD`).
   - `Last published at` and `Last EB push at` are ISO text.
   - The relations arrive as names.
   - Format all of them like the app's other dates. Blank means the line is omitted.
2. **What the leave guard checks.** It's PR #35's existing leave bar, keyed on `unpushedFields` (edits not on Eventbrite yet). It applies only to events on Eventbrite. Pending saves never block leaving: `leaveForm` queues them, as `close()` does today. A failed save is retried once and dropped, as today. No new conditions.
3. **Opened inside the app vs from a link.** In-app opens stamp `history.state = {event:id, inApp:true}`. ← Calendar uses `history.back()` only when that stamp is present.
   - **Fresh deep link:** the page shows the same "Loading…" state the modal used until events and reference lists load.
   - **Unknown or deleted id:** toast "That event isn't in this program year or no longer exists" and show the calendar (replace the URL).
   - **Signed out:** the sign-in gate, as today; the page opens after sign-in.
   - **`tmp-` (still being created):** not linkable, as today.
4. **History.** Opening from the calendar pushes. Create replaces: the create modal closes, and the new event's page replaces the URL, so Back returns to the calendar, not to an empty create form. Opening another event from inside a page pushes, so Back steps event to event. Reference events and the day picker open only from the calendar; nothing on the page opens them.
5. **Layout.** `body.event-open` hides the calendar chrome. The page uses its own sticky offsets, not `--bar-h`. Measure in a browser at desktop, ≥1000px with Help open, and phone width. `layoutSticky()` re-runs on return.
6. **Locks and loading state.**
   - Relations-not-ready keeps today's per-field behavior: Program(s), Leads and Where are read-only until ready, or the page waits on "Loading…" on first visit.
   - Cancelled/past locks apply per tab, as today.
   - The red dot on Listing comes only from `footerModel` links.
   - Counts in the tab list and on the filter never trigger a new fetch.
7. **What autosave covers.** Unchanged from today: the listing and Planning fields via `readForm`/`formCells`. The notes doc, Potluck slots/claims and the Attendees roster keep their own save paths.
8. **Needs approval.** It counts and shows Proposed events in the program year on screen, dated or not. Ideas that are Proposed appear at the end of their month. On phones, the toggle becomes a single row at the top of the list; today's phone list has no toolbar.

## 9. Risks

- **The leave path:** `popstate` fires after the URL has already changed. The guard has to re-push the event URL to cancel the navigation; get this wrong and Back silently drops the leave bar.
- **The footer's old jobs:** today's footer code (`renderEditorFooter`, `footerActsHTML`, the steps row, per-tab foot line) is repainted into the panel and the tab heading. Make sure every caller that repaints the footer now repaints the panel.
- **Deep links:** existing `?event=…&section=notes|planning|details` links must still land on the right section.
