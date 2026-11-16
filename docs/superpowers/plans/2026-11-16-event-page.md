# Event Page Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Split `web/app.js` into small documented files with no behavior change (Phase 1), then replace the event editor modal with a full event page that has a sticky **Status & next step** panel (Phase 2).

**Architecture:** Phase 1 moves code only: `app.js` becomes ~25 plain `<script>` files that share globals, loaded in `web/index.html` in an order that keeps every top-level statement in its original sequence; a move checker proves no line was added, lost or reordered. Phase 2 swaps the workspace container from `#scrim/#modal` to a page-level `#eventPage`, routes it with `pushState`/`popstate`, and repaints the footer wizard's model (`ListingRules.footerModel`, extended, not forked) into a right-hand panel. Every save, lock and push rule stays as it is.

**Tech Stack:** Vanilla JS, no build step, no new dependencies. Node 22 `node --test` for pure modules (tests live in `proxy/test/`). Cloudflare Worker untouched.

**Spec:** `docs/superpowers/specs/2026-11-16-event-page-design.md` (read it with this plan). Context: `docs/superpowers/handoffs/2026-11-16-event-page-handoff.md`, `docs/app-map.md`, `docs/GLOSSARY.md`, PR #35's spec `docs/superpowers/specs/2026-11-14-publish-flow-footer-wizard-design.md` (decisions D1–D8).

## Branches and PRs

- Stack: `feat/publish-wizard` (#35) → `chore/groundwork` (#36) → **`refactor/split-app`** (Phase 1, Tasks 1–7) → **`feat/event-page`** (Phase 2, Tasks 8–15). All release together; nothing merges on its own.
- Phase 1: create `refactor/split-app` from `feat/event-page` at the commit that adds this plan, in a new worktree `.worktrees/split-app`. When Phase 1 is reviewed, fast-forward `feat/event-page` to it and continue Phase 2 in `.worktrees/event-page`.
- Push each branch and open its PR (base = the branch below it) when its phase passes the whole-branch review. Eric decides merges.

## Global Constraints

- Buildless, vanilla JS, no new dependencies. Plain `<script>` files sharing globals (the pattern of `save-queue.js`, `listing-readiness.js`). No ES modules, no imports, in this plan.
- `web/listing-readiness.js` stays free of DOM and browser globals: the Worker bundles it. Editing it redeploys the Worker on merge.
- No Worker changes and no Coda schema changes.
- PR #35 rules hold: D1 stable containers, inner HTML only (no `outerHTML` assignments); D3 Saved = applied; D4 nothing from Eventbrite is written; D6 the panel is painted from `footerModel` — extend the model, don't fork it.
- Tooltips use `data-tip`, never `title=` on icon buttons. Phones keep 44px targets. Light and dark themes both work. `PHONE_MQ` and the CSS phone breakpoint stay `600px`.
- **R1, no live writes:** no deploys, no `wrangler` uploads, no `gh pr merge`, no force-push, no writes to prod Coda or Eventbrite, never click Publish/Add to Eventbrite/Approve on real data. Browser checks run with writes stubbed (see *Local smoke*).
- **Machine rules** (`~/.claude/CLAUDE.md` → Machine resources): measure memory before starting a server; record the PID, port and cwd of anything you start; kill by PID only; one `npm test` at a time machine-wide via `until mkdir /tmp/jest.lock 2>/dev/null; do sleep 5; done; trap 'rmdir /tmp/jest.lock' EXIT`.
- Every commit passes `./scripts/check.sh`. Commit messages end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Phase 1 commits carry `Help: none — code moved between files, no screen changes.`
- Help ships with the change (Task 14): `web/help/guide.md` + a dated `web/help/whats-new.md` entry; `[[labels]]` are exact on-screen text.
- Use the glossary's words (`docs/GLOSSARY.md`).

## Local smoke (used by many tasks)

- **Server:** `npx -y live-server web --port=8080 --no-browser` from the task's worktree. Only `localhost:8080` is in the Worker's CORS allowlist. Port 8080 is currently Eric's #35 server (PID 2307, `.worktrees/publish-wizard/web`): the controller asks Eric before stopping it, and restarts it the same way afterwards if he still wants it. Record the PID; stop it by PID at the end of the step.
- **Sign-in:** Eric's Firebase session at `localhost:8080` persists per origin. If the gate shows, ask Eric to sign in; never type credentials.
- **Stub writes** before clicking anything, in the page console:
  ```js
  (()=>{ const f=window.fetch; window.fetch=(u,o={})=>{ const m=(o.method||'GET').toUpperCase();
    if(m!=='GET'){ console.warn('[stub] blocked', m, String(u)); return Promise.resolve(new Response(JSON.stringify({error:'stubbed'}),{status:503,headers:{'Content-Type':'application/json'}})); }
    return f(u,o); }; console.log('[stub] writes blocked'); })();
  ```
  A blocked save shows **Save failed — retry**; that is expected under the stub.
- **Pass means:** no errors in the console on load or during the clicks (`read_console_messages` with pattern `Error|Uncaught`), and the listed clicks behave as on `feat/publish-wizard`.
- Browser checks are run by the controller (the session that has Chrome tools) after the task's reviewer passes, unless the implementer has the tools. Close the tab afterwards.

## Review Focus

1. **Back after an edit on the page:** typing in Title then pressing the browser's Back must queue the edit (`leaveForm`) and, for an event on Eventbrite with unpushed edits, keep the user on the page with the leave bar showing — never drop the edit or the bar. (Task 10 test list; Task 15 click-through.)
2. **Load order in Phase 1:** a function or `const` used at load time by an earlier file throws only in the browser, not in `node --check`. (Task 1's load smoke runs every file in order in a stub DOM; every Phase 1 task runs it.)
3. **Deep links from before this change:** `?event=<id>&section=notes|planning|details|publish|attendance` and `&help=<id>` must land on the right tab, signed in or after sign-in, and a fresh deep link's ← Calendar must work. (Task 8 unit tests for the alias map; Task 10 click-through.)
4. **The calendar after returning:** view, program year and scroll position survive a round trip through an event, including on phones and with Help open. (Task 9 and Task 15 click-throughs.)
5. **Repaints that used to target the footer:** every place that called `renderEditorFooter` (save pill, push, transitions, Eventbrite status, registrants, role arriving after sign-in) must now repaint the panel, or the panel shows stale stage/buttons. (Task 11 grep step + click-through.)

---

# Phase 1 — split `web/app.js` (no behavior change)

## File map (load order)

Ranges name the first and last top-level declaration moved, as in `app.js` at `24ecb18` (line numbers are a guide; move whole declarations with their leading comments). Original section banners move verbatim with their code. Every new file starts with a header comment block:

```js
/* <file>.js — <one line: what this owns>.
   Owns: <the top-level names it declares that other files use>
   Reads: <shared state it reads from other files, e.g. state, editing, _ctx>
   Writes: <shared state from other files it assigns, or "nothing">
   Loaded after: <the file it must follow, and why, if it matters> */
```

| # | File | Moves (first → last declaration) | Task |
|---|---|---|---|
| 1 | `web/util.js` | `cssColor` (≈3448) and `esc` → `linkify` (≈3594–3610) | 2 |
| 2 | `web/data.js` | `PROGRAMS` → `loadVenues` (≈1–123) and `eventToCodaCells` → `DB` (≈237–430): reference lists, cache, Coda seam, `CodaSource` | 2 |
| 3 | `web/pickers.js` | `initTypeahead`, `initVenuePicker` (≈124–236) | 2 |
| 4 | `web/state.js` | `PREFS_KEY` → `roughByMonth` (≈431–530): prefs, `state`, dates, `loadEvents`, `_recent`/`_unsaved`, refs settling, date bucketing | 2 |
| 5 | `web/calendar.js` | `isWeekend` → `sortEv` (≈531–739): months, overview, list views | 3 |
| 6 | `web/editor-tabs.js` | `editing` → `collectWhen` (≈770–830), `railHTML` → `renderSection` (≈1443–1469), `comingSoonHTML`, `wireScrollFade` (≈1714–1738) | 4 |
| 7 | `web/notes-doc.js` | `_gdocId` → `wireNotes` (≈838–884), `pollForNotesDoc`, `pushNotesDocButton` (≈1149–1186) | 4 |
| 8 | `web/field-markers.js` | `ICON_PENDING` → `paintFieldMarks` (≈896–1020): field markers, `listingCardHTML` | 4 |
| 9 | `web/preview.js` | `_pvGen` → `closePreview` and its keydown listener (≈1027–1148) | 4 |
| 10 | `web/editor.js` | `STAGE_BADGE` → `openFromUrl` (≈1192–1436): badge, `editorCtx`, header meta, `openEditor`, create flow, URL sync | 4 |
| 11 | `web/fields.js` | `roFieldHTML` → `wireEventFields` (≈1470–1629) and `readForm` (≈2154–2205) | 4 |
| 12 | `web/tabs-listing-planning.js` | `pubDescHintText` → `applyAddressDefault` (≈1630–1713) | 4 |
| 13 | `web/tab-attendees.js` | `renderAttendees` → `fmtAgo` (≈1739–1886) | 5 |
| 14 | `web/tab-potluck.js` | `SLOTS_LOADING_HTML` → `wireSlots` (≈1887–2106) | 5 |
| 15 | `web/feedback.js` | `feedbackBoardHTML` → `wireFeedback` (≈2107–2153), `openFeedback` (≈3125–3135) | 5 |
| 16 | `web/ui.js` | `_toastEl` → the tooltip listeners (≈2206–2244) | 5 |
| 17 | `web/save.js` | `_reconcileT` → `setSaveStatus` (≈2245–2397, incl. the `est:identity` listener), `paintSaveStatus` → `applyLocal` (≈2524–2582) | 6 |
| 18 | `web/footer.js` | `KEBAB_ICON` → `focusField` (≈2402–2523) | 6 |
| 19 | `web/transitions.js` | `transitionTo` → `paintEbBlock` (≈2583–2722) | 6 |
| 20 | `web/eventbrite.js` | `PUSH_ACTS` → `pushToEventbrite` (≈2723–2928) | 6 |
| 21 | `web/editor-close.js` | `show` → the `#mActions` listener (≈2929–3049): leave guard, `requestClose`, `close`, footer dispatch, ⋮ keys | 6 |
| 22 | `web/shell.js` | `#months` listener → `inProgramYear` (≈3050–3177, minus `openFeedback`), `LAYER_BOXES` → `renderLayers` (≈740–766), `ovfMenu`, `phoneMenu`, `wirePhoneMenu` (≈3282–3307) | 7 |
| 23 | `web/auth.js` | `jwtClaims` → `acctMenu` (≈3182–3280), `fetchMe` → `initAuth` (≈3308–3346) | 7 |
| 24 | `web/help.js` | `HELP_WELCOMED_KEY` → `maybeWelcome` listener (≈3390–3593, minus `cssColor`) | 7 |
| 25 | `web/main.js` | `_refreshing`, `refresh`, `init` (≈3347–3389) and the final `init();` | 7 |

Top-level statements that run at load (listener registrations, `prefs.layers` fix-up, `init()`) must keep their original relative order; the table's order does that. In particular the `keydown` Escape handlers stay in the order preview → `requestClose` → ⋮ menu → Help, because three of them call `stopImmediatePropagation`.

Until Task 7 deletes it, `web/app.js` holds what hasn't moved yet. Each task inserts its new `<script src>` tags directly before `app.js`, in table order. That keeps the original statement order because every top-level statement a task moves comes before every top-level statement left in `app.js` (Task 2 moves line ≈440, Task 3 ≈727, Task 4 ≈1141, Task 5 ≈2219–2244, Task 6 ≈2369–3044; Task 7 the rest). The checker (Task 1) enforces the order; if it complains, move the statement with its block rather than reordering. A moved file must not *run* anything at load that is still in `app.js` (a `const` there is not yet declared): the load smoke catches that.

### Task 1: Move checker and load smoke

**Files:**
- Create: `scripts/check-move.mjs`
- Test: `proxy/test/check-move.test.js`

**Interfaces:**
- Produces (exported from `scripts/check-move.mjs`):
  - `codeLines(src: string, {stripHeader: boolean}): string[]` — lines with trailing whitespace trimmed, blank lines dropped; with `stripHeader`, a leading `/* … */` block is removed first.
  - `topLevelStatements(src: string): string[]` — lines starting at column 0 with `[A-Za-z_$(]` that do not start with `function `, `async function `, `const `, `let `, `var `, `class `.
  - `compareMove(origSrc: string, files: {name: string, src: string}[]): string[]` — problems; `[]` means a pure move. Files are in load order; `web/app.js`, if present, is compared without header stripping.
  - `scriptList(indexHtml: string): string[]` — the local `src` values of classic `<script>` tags (skip `type="module"`) in order.
  - CLI: `node scripts/check-move.mjs <orig-ref>` — reads `web/app.js` at `<orig-ref>` via `git show`, the current `web/index.html` script list, and compares the scripts that are new since `<orig-ref>` plus `web/app.js` if still listed. `--load` additionally runs the load smoke. Exit 1 with the problems printed, else prints `check-move: pure move (<n> lines, <m> top-level statements in order)`.
  - Load smoke (`--load`): runs every script from `scriptList` in order in one `node:vm` context whose `window`, `document`, `localStorage`, `location`, `history`, `navigator`, `matchMedia`, `fetch`, `setTimeout`, `setInterval` are a universal stub (a `Proxy` over a function: any property returns the stub, calling or constructing returns the stub, `Symbol.toPrimitive` returns `''`, `then` is `undefined` so it isn't a thenable), `globalThis` = the context, and the final line `init();` of `main.js` (or `app.js`) is skipped. Reports the first thrown error with its file. Real values for `URL`, `Map`, `Set`, `Promise`, `JSON`, `Date`, `Math`, `console`.

- [ ] **Step 1: Write the failing tests** in `proxy/test/check-move.test.js`:
  - `compareMove passes a pure split`: orig `"a();\nfunction f(){\n  return 1;\n}\nb();\n"`; files `[{name:'web/x.js', src:'/* x.js — h\n   Owns: f */\nfunction f(){\n  return 1;\n}\n'}, {name:'web/app.js', src:'a();\n\nb();\n'}]` → `[]`.
  - `compareMove reports a lost line`: same but `x.js` body `return 2;` → problems include `missing: "  return 1;"` and `extra: "  return 2;"`.
  - `compareMove reports reordered top-level statements`: orig `"a();\nb();\n"`, files `[{name:'web/app.js', src:'b();\na();\n'}]` → a problem containing `top-level order`.
  - `compareMove requires a header with Owns:`: a non-`app.js` file without a leading `/* … Owns: … */` block → a problem containing `header`.
  - `scriptList skips modules`: `'<script type="module" src="auth-firebase.js"></script>\n<script src="a.js"></script>\n<script src="b.js"></script>'` → `['a.js','b.js']`.
- [ ] **Step 2: Run** (under the test lock) `cd proxy && node --test test/check-move.test.js` — Expected: FAIL (`Cannot find module '../../scripts/check-move.mjs'`).
- [ ] **Step 3: Implement** `scripts/check-move.mjs` with the interfaces above. Multiset comparison of `codeLines` (count per line; report up to 20 missing/extra lines), then `topLevelStatements` sequence equality (report the first index that differs).
- [ ] **Step 4: Run** the tests — Expected: PASS. Then `node scripts/check-move.mjs 24ecb18 --load` on the unsplit tree — Expected: `check-move: pure move (…)` and no load error (this proves the stub runs today's `app.js`; if it throws, fix the stub, not `app.js`).
- [ ] **Step 5:** `./scripts/check.sh` passes. Commit `chore: check-move.mjs proves the app.js split is a pure move`.

### Task 2: Foundations — util, data, pickers, state

**Files:** Create `web/util.js`, `web/data.js`, `web/pickers.js`, `web/state.js` (rows 1–4 of the file map). Modify `web/app.js` (remove the moved blocks), `web/index.html` (insert `util.js`, `data.js`, `pickers.js`, `state.js` before `app.js`, after `editor-head.js`).

**Interfaces:** Produces the globals named in each file's `Owns:` line, unchanged.

- [ ] **Step 1:** Move the blocks verbatim; write each header (Owns/Reads/Writes/Loaded after).
- [ ] **Step 2:** `node scripts/check-move.mjs 24ecb18 --load` — Expected: pure move, no load error.
- [ ] **Step 3:** `./scripts/check.sh` — Expected: passes (`app.js` is still allow-listed).
- [ ] **Step 4: Local smoke**, read-only: calendar loads in Overview, Months and List; year arrows; ⚙ layer toggle; open one event and switch every tab; close. Console clean.
- [ ] **Step 5:** Commit `refactor(web): data layer, pickers, state and helpers leave app.js`.

### Task 3: Calendar views

**Files:** Create `web/calendar.js` (row 5). Modify `web/app.js`, `web/index.html` (after `state.js`).

- [ ] **Step 1:** Move; header.
- [ ] **Step 2:** `node scripts/check-move.mjs 24ecb18 --load` — pure move.
- [ ] **Step 3:** `./scripts/check.sh` passes.
- [ ] **Step 4: Local smoke:** each view; the + buttons reveal; clicking a List row opens the event; today scrolls into view on load in each view.
- [ ] **Step 5:** Commit `refactor(web): calendar views leave app.js`.

### Task 4: Editor core — tabs, notes doc, markers, preview, editor, fields

**Files:** Create rows 6–12. Modify `web/app.js`, `web/index.html` (after `calendar.js`, in table order).

- [ ] **Step 1:** Move; headers. `editor.js`'s header lists the modal ids it paints (`mStripe`, `mTitle`, `mTag`, `mSub`, `mBadges`, `mActions`, `mBody`, `mFoot`) — Phase 2 changes them.
- [ ] **Step 2:** `node scripts/check-move.mjs 24ecb18 --load` — pure move.
- [ ] **Step 3:** `./scripts/check.sh` passes.
- [ ] **Step 4: Local smoke** (writes stubbed): open an approved event; Details shows the listing card and field markers; **Preview listing** opens and Esc closes only the preview; switch to Planning (notes doc iframe or its create button shows); a readiness link in the footer focuses its field; open the create form from **+ New event** and **Cancel** it; open a reference event.
- [ ] **Step 5:** Commit `refactor(web): editor tabs, fields, markers and preview leave app.js`.

### Task 5: Attendees, Potluck, Feedback, toasts and tooltips

**Files:** Create rows 13–16. Modify `web/app.js`, `web/index.html` (after `tabs-listing-planning.js`).

- [ ] **Step 1:** Move; headers.
- [ ] **Step 2:** `node scripts/check-move.mjs 24ecb18 --load` — pure move.
- [ ] **Step 3:** `./scripts/check.sh` passes.
- [ ] **Step 4: Local smoke:** Attendees roster loads for an event with registrants (read); Potluck & Volunteers lists slots; a Coming-soon tab shows the feedback board; header **Feedback / Ideas** opens; a `data-tip` icon shows its tooltip on hover and on keyboard focus.
- [ ] **Step 5:** Commit `refactor(web): attendees, potluck, feedback and UI helpers leave app.js`.

### Task 6: Saving, footer, transitions, Eventbrite, closing

**Files:** Create rows 17–21. Modify `web/app.js`, `web/index.html` (after `ui.js`).

- [ ] **Step 1:** Move; headers. `save.js`'s header says which functions the save model's rules live in (`saveQueue`, `applied`, `pendingFor`, `leaveForm`, `flushAutosave`, `dropFailedEdits`, `guardUnload`).
- [ ] **Step 2:** `node scripts/check-move.mjs 24ecb18 --load` — pure move.
- [ ] **Step 3:** `./scripts/check.sh` passes. Under the test lock: `cd proxy && npm test` — Expected: the same pass count as `feat/publish-wizard` (308).
- [ ] **Step 4: Local smoke** (writes stubbed): edit Title, blur → button shows **Saving…** then the stub's **Save failed — retry**; click it → retries (blocked again); ⋮ opens, arrow keys move, Esc closes the menu only; on an event on Eventbrite, edit a public field and press ✕ → the leave bar shows; **Keep editing** keeps it open; Esc closes the editor.
- [ ] **Step 5:** Commit `refactor(web): save model, footer, transitions and Eventbrite push leave app.js`.

### Task 7: Shell, auth, help, main; `app.js` is gone; file map

**Files:** Create rows 22–25. Delete `web/app.js`. Modify `web/index.html` (replace the `app.js` tag with `shell.js`, `auth.js`, `help.js`, `main.js`), `scripts/check.sh` (`OVERSIZE_OK=()`), `docs/app-map.md` (rewrite), `CLAUDE.md` (repo map line for `web/` unchanged; nothing else).

- [ ] **Step 1:** Move; headers. Delete `web/app.js`.
- [ ] **Step 2:** `node scripts/check-move.mjs 24ecb18 --load` — pure move over all 25 files; no load error.
- [ ] **Step 3:** `./scripts/check.sh` passes with an empty allow-list (no `web/*.js` over 800 lines). `node scripts/check-help.mjs --branch HEAD --base chore/groundwork` passes (the commit's `Help: none — …` line covers the screens files).
- [ ] **Step 4: Rewrite `docs/app-map.md`** as a file map: one short entry per file in load order (what it owns, in one or two lines, plus the key names), then the existing walkthrough's facts kept under the file that now owns them, then Gotchas unchanged. Keep every fact; drop only "top to bottom of app.js" framing. State the load-order rule (top-level statements in original order; Escape handlers' order) under a heading "Adding a file".
- [ ] **Step 5: Local smoke**, full pass: sign-in gate signed out (open a private window) shows and **New here?** opens Help; signed in: every view, year arrows, ⚙ and phone ☰ (resize to 390px), Help drawer with What's new dot, `?help=lifecycle`, a deep link `?event=<id>&section=notes`, refresh button, and Task 6's editor clicks.
- [ ] **Step 6:** Commit `refactor(web): shell, auth and help leave app.js; app.js removed; file map`.

**Phase 1 review:** whole-branch review of `refactor/split-app` vs `chore/groundwork` (focus: headers accurate, nothing but moves outside `scripts/`, `docs/`, `index.html`, `check.sh`). Then push, open the PR (base `chore/groundwork`), and fast-forward `feat/event-page` to it.

---

# Phase 2 — the event page

**Before Task 8:** Eric confirms **Listing** vs **Details** for the first tab's label (asked when this plan was handed over). Tasks below say "Listing"; if Eric keeps "Details", use "Details" wherever the plan says the tab label, and keep everything else.

Names Phase 2 introduces (used across tasks):

| Name | Where | What |
|---|---|---|
| `PageRules` | `web/page-rules.js` (new, pure, node-tested) | `sectionFromParam`, `stepNotes`, `needsApproval` |
| `ListingRules.footerModel(...).checklist` | `web/listing-readiness.js` | readiness rows for the panel |
| `#eventPage` and its parts | `web/index.html` | `#epBack`, `#epStripe`, `#epTitle`, `#epTag`, `#epSub`, `#epBadges`, `#epActions`, `#epTabs`, `#epMain` (holds `#epGuard`, `#epBlock`, `#epHead`, `#wpanel`), `#epPanel` (holds `#edStatus`, `#edChecks`, `#edActs`, `#edMenu`, `#edSub`, `#edBars`, `#listingCard`, `#saveStatus`), `#epPhoneBar` |
| `openEventPage(ev, section, how)` | `web/editor.js` | renamed `openEditor` workspace path; `how ∈ 'push' \| 'replace' \| 'none'` |
| `leaveEventPage(how)` | `web/editor-close.js` | the page's `close()`; `how ∈ 'back' \| 'push' \| 'popped'` |
| `renderStatusPanel()` | `web/footer.js` (rename the file `web/status-panel.js` in Task 11) | replaces `renderEditorFooter` |

### Task 8: Pure rules — section aliases, step notes, checklist, Needs approval, read-only fields

**Files:**
- Create: `web/page-rules.js`; Test: `proxy/test/page-rules.test.js`
- Modify: `web/listing-readiness.js` (`footerModel` adds `checklist`); Test: `proxy/test/listing-readiness.test.js`
- Modify: `web/data.js` (`planningRowToEvent` adds read-only fields), `web/editor-tabs.js` (`sectionId` delegates to `PageRules.sectionFromParam`), `web/index.html` (load `page-rules.js` after `editor-head.js`)
- Delete: `scripts/check-move.mjs`, `proxy/test/check-move.test.js` (Phase 1 is done)

**Interfaces:**
- Produces `PageRules` on `globalThis` (same IIFE pattern as `editor-head.js`, no DOM):
  - `sectionFromParam(id: string|null): string` — `notes`→`planning`, `attendance`→`attendees`, `publish`→`details`, `listing`→`details`, `''`/`null`→`details`, otherwise `id`. (The tab id stays `details` so old links and `syncUrl` keep working.)
  - `stepNotes(ev, {fmtDate: (iso)=>string, registrants: number|null, capacity: number|null}): string[5]` — one note per lifecycle step, `''` when there is nothing to say (spec 5.5): Draft `by <createdBy>`; Proposed `''`; Approved `by <approvedBy> · <fmtDate(approvedAt)>` (either part alone if the other is blank); On Eventbrite `fmtDate(lastEbPushAt)`; Published `fmtDate(lastPublishedAt)` plus ` · N of M registered` when `registrants != null` (`N registered` when `capacity` is null).
  - `needsApproval(ev): boolean` — `ev.source==='planning' && ev.status==='proposed'`.
- Produces `footerModel(input).checklist: {key: string, label: string, field: string|null, ok: boolean, message: string}[]` — the readiness rows for the stage's next push, grouped one row per field: `title` "Title"; `date` "Date and times" (checks `exact`, `date`, `future`, `start`, `end`, `endAfterStart`; `field` = the first failing check's field, else `date`); `capacity` "Free tickets"; `venue` "Venue and address" (`venueOther`, `venueAddress`); `publicDescription` "Description" (publish list only). `message` = the first failing check's message, `''` when ok. Stage `approved` uses the `add` checks; `onEventbrite` and `published` the `publish` checks; every other stage `[]`. The `approved` check is never a row. `links` is unchanged.
- Produces on normalized events (read-only; `eventToCodaCells` unchanged): `approvedBy` (first name from `Approved by`), `approvedAt` (`Approved at`, `YYYY-MM-DD`), `lastPublishedAt` (`Last published at`, ISO text), `lastEbPushAt` (`Last EB push at`, ISO text). Before coding, confirm the four column names with one read: `curl -s https://est-planning-proxy.eastsidetribe.workers.dev/rows | node -e 'const j=JSON.parse(require("fs").readFileSync(0));console.log(Object.keys((j.items||j)[0].values))'` (adjust to the response shape).

- [ ] **Step 1: Write the failing tests.**
  - `page-rules.test.js`: `sectionFromParam` for each alias above plus `'volunteers'`→`'volunteers'`; `stepNotes` with `{createdBy:'Ana', approvedBy:'Ben', approvedAt:'2026-11-02', lastEbPushAt:'2026-11-03T15:00:00Z', lastPublishedAt:'2026-11-04T15:00:00Z'}`, `fmtDate: s=>'D('+s.slice(0,10)+')'`, `registrants:12, capacity:40` → `['by Ana','','by Ben · D(2026-11-02)','D(2026-11-03)','D(2026-11-04) · 12 of 40 registered']`; all blank → five `''`; `registrants:null` → no registered part; `needsApproval` true only for a planning event with status `proposed` (false for `source:'ref'`).
  - `listing-readiness.test.js`: `checklist` is `[]` for `draft`, `proposed`, `cancelled`; for `approved` with a blank end time it has a `date` row `{ok:false, field:'end', message:'Add an end time'}` and no `publicDescription` row; for `onEventbrite` it has a `publicDescription` row; every row's `label` is one of the five labels; an all-passing event gives rows that are all `ok:true` with `message:''`.
- [ ] **Step 2: Run** (test lock) `cd proxy && node --test test/page-rules.test.js test/listing-readiness.test.js` — Expected: FAIL.
- [ ] **Step 3: Implement** the interfaces. Delete the Phase 1 checker and its test.
- [ ] **Step 4: Run** the two tests, then the full `npm test` — Expected: PASS (count = 308 + new tests − check-move's). `./scripts/check.sh` passes.
- [ ] **Step 5:** Commit `feat(rules): page rules, footer checklist, read-only who/when fields` with `Help: none — rules only, no screen changes yet.`

### Task 9: The page container (no routing yet)

**Files:**
- Modify: `web/index.html` — add `#eventPage` (a `<main>`-level sibling of the calendar, not a dialog) with the ids from the names table; the calendar's existing wrapper keeps its ids. `#edGuard`/`#edBlock` move out of `#modal` into `#epMain`.
- Modify: `web/editor.js` — the workspace path of `openEditor` renders into the page: header into `#ep*`, tab list into `#epTabs` (today's `railHTML`), the active tab into `#wpanel`, and adds `body.event-open`. Reference events, the create form and the loading state for those keep using `#modal` via `show()`. The editor's own first-visit loading state ("Loading…") renders in `#epMain`, not the modal. `paintHeadMeta`/`clearHeadMeta` use `#epTitle`/`#epTag`/`#epSub`/`#epStripe`.
- Modify: `web/editor-close.js` — `close()` splits: `closeModal()` (the `#scrim` part, for the create form/ref/day picker/feedback) and `leaveEventPage(how)` (the page part: everything `close()` does for the editor, then removes `body.event-open`, re-shows the calendar and calls `layoutSticky()`). `requestClose` stays the entry point for ✕/Esc on the **modal**; the page has no ✕ and Esc does not leave it (Esc still closes, in order, the preview, the ⋮ menu, Help, the leave bar).
- Modify: `web/styles.css` — `body.event-open` hides `.bar`/header rows, `.phonebar`, `#fabAdd` and the calendar views (`display:none`, so their scroll position and DOM survive); `#eventPage` layout per spec 5.3: top bar, then a three-column grid `tabs | main (fields capped at 760px) | panel (300px, position:sticky, top below the top bar)`. Help's `body.help-open` padding applies to the page as it does to the calendar. Match PR #35's compact scale. For now the panel shows the old footer markup (`#edSteps`/`#edFoot`/`#edActs`/`#edMenu` stacked) so the task is shippable on its own; Task 11 replaces it.
- Modify: the callers listed by `grep -n "openEditor(" web/*.js` keep calling `openEditor(ev, section)`; it becomes a thin wrapper: reference events → the modal path, planning events → `openEventPage(ev, section, 'none')` (Task 10 changes `'none'`).

**Interfaces:**
- Produces: `openEventPage(ev: Event, section?: string, how: 'push'|'replace'|'none'): void`; `leaveEventPage(how: 'back'|'push'|'popped'): void` (Task 9 ignores `how`); `closeModal(): void`; the page ids in the names table.
- Consumes: `railHTML`, `renderSection`, `renderEditorFooter`, `paintHeadMeta`, `leaveGuard`, `leaveForm`.

- [ ] **Step 1:** Markup + CSS for `#eventPage`; `body.event-open` rules.
- [ ] **Step 2:** `openEventPage`/`leaveEventPage`/`closeModal` as above; **← Calendar** (`#epBack`) calls `leaveGuard(()=>leaveEventPage('back'))` then `leaveEventPage('back')` when not held.
- [ ] **Step 3:** `./scripts/check.sh` passes; `cd proxy && npm test` passes.
- [ ] **Step 4: Local smoke** (stubbed): from Overview scrolled to a late month, open an event → the page shows, calendar chrome hidden; every tab works; **Preview listing** overlays the page; ← Calendar returns to the same view, year and scroll position; the create form, a reference event, the day picker and Feedback still open as modals; Help opens beside the page at ≥1000px and over it below; dark mode readable.
- [ ] **Step 5:** Commit `feat(app): the event editor opens as a page` (help is updated in Task 14; add `Help: pending — Task 14 updates the editor guides` to the message).

### Task 10: Routing — pushState, popstate, deep links, unknown ids

**Files:** Modify `web/editor.js` (`syncUrl`, `clearUrl`, `openFromUrl`, `openEventPage`), `web/editor-close.js` (`leaveEventPage`, the leave guard on `popstate`), `web/main.js` (`popstate` listener registered after `init` is defined, before `init();`), `web/editor-tabs.js` (tab switch uses `syncUrl(ev, id)` with `replaceState`).

**Rules** (spec 5.1, 8.3, 8.4, 5.7):
- `openEventPage(ev, s, 'push')` from the calendar, List, day picker, and from inside a page to another event: `history.pushState({event: ev.id, inApp: true}, '', url)`.
- After create (`createFromForm`): `closeModal()` then `openEventPage(e, undefined, 'replace')` with `replaceState({event:id, inApp:true}, …)` — Back returns to the calendar, not the form.
- Tab switches and `openFromUrl`: `replaceState`, keeping the existing `history.state` (`{event, inApp}` or `null`).
- **← Calendar:** if `history.state && history.state.inApp && history.state.event === editing.id` → `history.back()` (the `popstate` handler closes the page); else `leaveEventPage('push')`, which `pushState(null, '', <url without event/section>)`.
- **`popstate`:** let `id = new URL(location.href).searchParams.get('event')`.
  - The page is open for `editing.id` and `id !== editing.id`: if `leaveGuard(proceed)` holds (unpushed Eventbrite edits), first restore the URL with `history.pushState({event: editing.id, inApp: true}, '', <editing's url>)` so the user stays put, and let `proceed` = `()=>history.back()`; otherwise `leaveEventPage('popped')`, then if `id` names another event open it with `'none'`.
  - The page is closed and `id` is set: open it with `'none'` (forward button).
  - `leaveEventPage('popped')` never touches history; `'push'` pushes the calendar URL; `'back'` is not used by `popstate`.
- **Fresh deep link** (`openFromUrl` at init): opens with `'none'` after events load; a missing id → `toast("That event isn't in this program year or no longer exists")` and `replaceState(null, '', <calendar url>)`. Signed out: the gate shows; `openFromUrl` already runs after sign-in — keep that.
- `tmp-` ids are never pushed (the existing toast stays).
- `beforeunload` (`guardUnload`) unchanged.

- [ ] **Step 1: Test list** (record results in the commit message; these are browser checks, writes stubbed):
  1. Calendar → event → Back: calendar, same scroll. Forward: the event again.
  2. Calendar → event A → ← Calendar → event B → Back → Back: the calendar, then A.
  3. Event on Eventbrite, edit Summary, Back: still on the page, URL still has `event=`, leave bar shows; **Keep editing** stays; Back again then **Close anyway**: calendar, and the edit was queued (button showed Saving… before leaving, stub then fails it, toast).
  4. Same as 3 with ← Calendar instead of Back.
  5. Fresh tab with `?event=<id>&section=notes` → Planning tab; ← Calendar → calendar (pushed URL, no `event=`); Back → the event again.
  6. `?event=nope` → toast, calendar, URL cleaned.
  7. `?event=<id>&section=listing` and `&section=publish` → the Listing tab.
  The create → replace path can't run under the write stub; it is checked by the reviewer in code and by Eric in live testing.
- [ ] **Step 2:** Implement the rules.
- [ ] **Step 3:** Run the test list; `./scripts/check.sh`; `npm test`.
- [ ] **Step 4:** Commit `feat(app): event page routing — Back, ← Calendar, deep links` (`Help: pending — Task 14`).

### Task 11: The Status & next step panel

**Files:**
- Rename `web/footer.js` → `web/status-panel.js` (update `index.html`, its header).
- Modify `web/status-panel.js`: `renderEditorFooter` → `renderStatusPanel()`; `footerStepsHTML` → `checklistStepsHTML(m, notes: string[])` (vertical list: done ✓ / current / to do, each with its `stepNotes` line), `footerMsgHTML` → `nextStepHTML(m)` (title, then `m.checklist` rows as ✓/✗ — each ✗ row is `<a href="#" data-focus-field="<field>">` with its `message`; ✓ rows show the `label`), the primary and ⋮ (`footerActsHTML` / `footerMenuHTML` unchanged, always "on Details" now: the panel shows on every tab), then `m.sub`. Containers (D1, all stable, filled with `paintInner`): `#edStatus` (steps), `#edChecks` (title + rows), `#edActs`, `#edMenu`, `#edSub`, `#edBars` (registrant-email offer and the conflict / needs-Eventbrite-cancel bars that today render in the footer or `#edBlock`), `#listingCard`, `#saveStatus` (failure only).
- Modify `web/field-markers.js` / `web/tabs-listing-planning.js`: `#listingCard` moves from the top of Listing into the panel on desktop (on phones it stays at the top of Listing — Task 12).
- Modify `web/editor-tabs.js`: the main column's heading `#epHead` shows the tab label and its one-line description (`SECTIONS[].foot`; add one for `details`: `What people see on Eventbrite. Edits save here first; push them with the button on the right.`). Rename the `details` label to `Listing` (pending Eric). The tab list marks Listing with a red dot (`.tab-dot`, `aria-label="Needs attention"`) when any `m.links` entry's field is on Listing (`FIELD_SECTION[field] || 'details'` is `'details'`); repainted by `renderStatusPanel`. No counts that need a fetch.
- Modify every caller: `grep -n "renderEditorFooter" web/*.js` must return nothing after this task; each call site now calls `renderStatusPanel()`.
- Modify `web/editor-close.js`: the `#mFoot` click listener (save retry, `data-focus-field`, `data-act`, ⋮) moves to `#epPanel` (and `#epPhoneBar`, Task 12); `focusField` switches tabs through `#epTabs`.
- Modify `web/styles.css`: panel cards; remove the footer's `.edsteps/.fsteps*` rules that nothing uses now.

**Interfaces:** Consumes `ListingRules.footerModel(...).checklist`, `PageRules.stepNotes`, `fmtDate`. Produces `renderStatusPanel(): void`.

- [ ] **Step 1:** Implement; every footer call site repoints.
- [ ] **Step 2:** `grep -n "renderEditorFooter\|#mFoot\|'mFoot'" web/*.js` — Expected: only the modal paths (create form, reference event) use `mFoot`; no `renderEditorFooter`.
- [ ] **Step 3:** `./scripts/check.sh`; `npm test`.
- [ ] **Step 4: Local smoke** (stubbed), one event per stage (find them with the List view): Draft — checklist shows step 1 current with "by <name>", primary **Propose to council**; Proposed as council — **Approve**; Approved with a missing end time — ✗ "Add an end time" row, clicking it switches to Listing and focuses End; red dot on Listing; Published — "N of M registered" once the live status loads; the panel is the same on Planning, Potluck and Attendees; ⋮ works from Attendees; Save failed — retry appears in the panel after a blocked save.
- [ ] **Step 5:** Commit `feat(app): Status & next step panel replaces the footer wizard` (`Help: pending — Task 14`).

### Task 12: Phones

**Files:** Modify `web/styles.css` (`@media (max-width:600px)` for `#eventPage`), `web/status-panel.js` (a phone status card and `#epPhoneBar`), `web/index.html` (`#epPhoneBar`).

**Rules** (spec 5.6): compact top bar (← and the title on one row; tag and badge on the next); a status card at the top of the main column showing `m.title`, the first failing checklist row as a link, and `Step N of 5 · see all steps` (a `<button aria-expanded>` that expands the same vertical checklist inline); the tab list becomes a horizontal scrollable strip (keep `wireScrollFade`); `#listingCard` renders at the top of the Listing tab; `#epPhoneBar` is a sticky bottom bar with the primary and ⋮ (≥44px), sharing the `#edActs`/`#edMenu` content (render the same HTML into `#epActsPhone`/`#epMenuPhone`, or move the two containers with CSS — builder's choice, but only one set of ids may exist in the DOM).

- [ ] **Step 1:** Implement.
- [ ] **Step 2:** `./scripts/check.sh`.
- [ ] **Step 3: Local smoke** at 390×844 (resize the window): open from the List; the status card, the strip, Listing card on top, sticky bar with the primary; ⋮ opens above the bar; Back returns to the List at the same scroll; the ☰ menu and floating + are hidden on the page.
- [ ] **Step 4:** Commit `feat(app): the event page on phones` (`Help: pending — Task 14`).

### Task 13: List view — Needs approval

**Files:** Modify `web/index.html` (a stable `#listBar` container directly above `#listView`), `web/calendar.js` (`renderList` filters when on; `listBarHTML(count, on)`), `web/state.js` (`prefs.needsApproval`, saved through `savePrefs` in `est-view-prefs`, try/catch as today), `web/styles.css`.

**Rules** (spec 5.8, 8.8): a toggle button **Needs approval** with a count (`PageRules.needsApproval` over `state.events` in the program year on screen, dated or not), `aria-pressed`; off by default; visible to everyone; when on, only Proposed planning events show (reference dates hidden too), grouped by day as now, Proposed ideas at the end of their month under Date TBD; months with nothing say `Nothing waiting for approval`. `#listBar` shows only when the List is the current view (`curView()==='list'`, so always on phones), as one row at the top of the list.

- [ ] **Step 1:** Implement.
- [ ] **Step 2:** `./scripts/check.sh`.
- [ ] **Step 3: Local smoke:** toggle on/off on desktop List and at 390px; the count matches the Proposed events in the year; reload keeps the toggle; changing year updates the count; switching to Overview hides the bar.
- [ ] **Step 4:** Commit `feat(app): Needs approval filter on the List view` (`Help: pending — Task 14`).

### Task 14: Help, docs, cleanup

**Files:** Modify `web/help/guide.md` (`#edit-details`, `#lifecycle`, `#planning-notes` (the spec's `#planning`; keep the id, links use it), `#field-markers`, `#publish`, `#publish-changes`, `#share-link` (Back and Copy link), and `#reading-the-calendar` or `#getting-around` gets a line on Needs approval), `web/help/whats-new.md` (a `## 2026-11-<day>` entry: the event opens as a page, the Status & next step panel, Back works, Listing (if renamed), Needs approval), `docs/app-map.md` (the page, the panel, routing, the new files), `docs/GLOSSARY.md` (Listing, Status & next step panel, checklist, Needs approval), `web/styles.css` (delete `.modal.ws`/workspace rules nothing uses; keep `.modal.create`).

- [ ] **Step 1:** Write the guide changes for a non-technical lead (writing guide at the top of `guide.md`); every `[[label]]` is exact on-screen text (e.g. `[[← Calendar]]`, `[[Needs approval]]`, `[[Status & next step]]` if that is the panel's on-screen heading, `[[Propose to council]]`).
- [ ] **Step 2:** `node scripts/check-help.mjs` and `node scripts/check-help.mjs --branch HEAD --base refactor/split-app` — Expected: no findings. `./scripts/check.sh` passes.
- [ ] **Step 3:** Help drawer: open each rewritten guide from its in-app entry point (page ?, status badge, create form ?) and read it on screen.
- [ ] **Step 4:** Commit `docs(help): the event page, the status panel and Needs approval`.

### Task 15: Whole-branch verification against the anti-goals

No new code unless a check fails (then fix in a commit of its own, reviewed).

- [ ] **Step 1:** `./scripts/check.sh`; `cd proxy && npm test` (record the count); `node scripts/check-help.mjs --branch HEAD --base refactor/split-app`.
- [ ] **Step 2: Anti-goals** (spec 4), stubbed: an edit survives leaving by ← Calendar, Back, opening another event, and closing the tab (`beforeunload` asks); the calendar keeps view, year and scroll after a round trip in all three views and at 390px; the page opens as fast as the modal did (time from click to first paint of the tab on a cached event, by eye or `performance.now()` around `openEventPage`; note the numbers); on every tab, a lead can see what's left without scrolling (the panel at 1280×800 and 1000×700; the status card at 390×844).
- [ ] **Step 3: Spec 9 risks:** Back with the leave bar (Task 10 cases 3–4 again); every repaint path (save, push stub error, role arriving after a fresh sign-in, Eventbrite status load) updates the panel; old deep links (`notes`, `planning`, `details`, `publish`, `attendance`).
- [ ] **Step 4:** Light and dark; Help open at ≥1000px; keyboard: Tab order through tabs → main → panel, ⋮ keys, Esc order.
- [ ] **Step 5:** Write the PR description (template's "How it was verified" with what was run and seen), push `feat/event-page`, open the PR with base `refactor/split-app`.

**Phase 2 review:** whole-branch review of `feat/event-page` vs `refactor/split-app` before Step 5.
