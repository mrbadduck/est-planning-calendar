# Handoff: event page (2026-11-16)

Start here in a new session. Read this file first, then the spec, then CLAUDE.md.

## Where things stand

- **PR #35** (`feat/publish-wizard`, worktree `.worktrees/publish-wizard`) is open, pushed and green, at 57 commits plus fixes (head `24ecb18`).
  - It covers the publish wizard, honest saves, Details/Planning split, Ticketing/Free tickets, Preview at every stage, the single sync icon, and the compact editor.
  - **Do not merge.** Eric wants to release #35 and the event page together.
- **This branch, `feat/event-page`** (worktree `.worktrees/event-page`), is stacked on `feat/publish-wizard`. It is not pushed and holds only the spec so far.
  - **Spec:** `docs/superpowers/specs/2026-11-16-event-page-design.md`. Agreed direction; Eric revised it to **keep tabs** (not one scrolling page).
  - **Design canvas:** https://claude.ai/artifact/AeaeVySLeUM866d1emm8Ct, page "Full page + drawer (Nov 16)", boards A1–A3. Note the boards still show one scrolling page; the spec's tabs win. The drawer (B) is dropped. Council review is a **Needs approval filter on the List view**.
- **Next step:** write the implementation plan (superpowers:writing-plans) from the spec, get Eric's OK, then build with superpowers:subagent-driven-development. Each task gets a fresh implementer plus a reviewer, then a whole-branch review. Then push and either open a stacked PR or add to #35, whichever Eric prefers.

## Plan shape (agreed with Eric)

**Phase 1: split `web/app.js` (about 3,600 lines) into small, focused, documented files, before any event-page work.**

- Move code only, no behavior changes. Verify each step with tests, `node --check`, the help guard and a read-only local click-through.
- Stay buildless: plain `<script>` files sharing globals, the pattern of `save-queue.js` and `listing-readiness.js`, loaded in order in `web/index.html`. Converting shared globals (`editing`, `_form`, `state`, …) to imports can come later, gradually.
- Split along the existing seams:
  - the data layer (`CodaSource`, `planningRowToEvent`/`eventToCodaCells`)
  - the save system (saveQueue wiring, `applied`/`pendingFor`, `_unsaved`/`_recent`, reconcile)
  - the editor shell (open/close, ctx, sections, leave guard)
  - the per-tab renderers (Details/Listing, Planning, Potluck, Attendees, Coming soon)
  - the field builders
  - status/footer rendering
  - preview
  - the calendar views (overview/months/list)
  - help
  - auth and the app shell (header, phone menu, layers, tooltips)
- Each file starts with a short header saying what it owns and which globals it reads or writes.
- CLAUDE.md's "How the app is built" becomes a short file map.
- Watch `scripts/check-help.mjs`: it scans app code for help ids and `[[labels]]`, so point it at every `web/*.js` it needs.
- **Phase 2:** the event page (spec), which then mostly replaces the editor shell and the footer files.

## Open question for Eric

- The **Details** tab is renamed **Listing** in the spec, as in the mockup. Eric hasn't confirmed; ask before building.

## How the last branch was run (keep doing this)

- **R1, no live writes from implementers.** No deploys, no Worker uploads, no writes to prod Coda or Eventbrite. Verify with `cd proxy && npm test` (308 passing at #35's head), `node --check web/*.js`, `node scripts/check-help.mjs --branch <branch>`, `./scripts/sync-shared.sh --check`, and local read-only browser checks with DB writes stubbed.
- **Test lock** (one test run machine-wide): `until mkdir /tmp/jest.lock 2>/dev/null; do sleep 5; done; trap 'rmdir /tmp/jest.lock' EXIT`.
- **Help ships with the change.** Guide and whats-new are updated in the same branch, and `[[labels]]` must match on-screen text.
- **Commit trailer:**
  ```
  Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_01Br5hmA4jyj8Pfpc3hhrW7K
  ```
  Use the new session's own session link if it has one.
- **Reviews caught real bugs every round** (duplicate Eventbrite events, false conflict notices, home addresses going public, the address parser). Don't skip them.
- **Live testing setup** (when Eric OKs it):
  - App: `npx -y live-server web --port=8080 --no-browser`, run from a worktree.
  - Worker: `cd proxy && npx wrangler dev --port 8787 --ip 127.0.0.1`. It needs `proxy/.dev.vars`; copy it from the main checkout, where it is gitignored.
  - Point the app at the local Worker: in the browser console, `localStorage.setItem('est-proxy-base','http://127.0.0.1:8787')`.
  - Eric signs in himself. Never click Publish. To test as a lead, Eric allowed temporarily setting his Leadership Status to Program Lead in EST People SRC; restore it afterwards. The local Worker caches roles, so restart it after a role change and wait about 30 s for Coda.

## Still running (from the #35 walkthrough)

- live-server on :8080 (listener PID 2307), serving `.worktrees/publish-wizard/web`.
- wrangler dev on :8787 (listener PID 22781, launcher 22746).
- Eric is using them for hands-on testing. Stop them by PID only, once he's done.

## Facts learned (don't re-learn them)

- **Coda's API applies every write 25–35 s after accepting it**, even in a near-empty doc. Measured on Nov 16: tiny doc median 28.0 s; Mission Control median 26.9 s. Doc size is not the cause.
  - The proposed fix, the "fast writes" branch, is not approved yet: the Worker remembers recent writes (D1 or a Durable Object) and serves reads with them applied; the newer timestamp wins.
- `/rows` returns full rows, including Created by, Approved by, Approved at (a date), Last published at (ISO text) and Last EB push at (ISO text).
- Venue `Address` strings in Coda were free text with repeated cities. The Worker now parses them (`parseUsAddress`). Eric fixed Inglewood Lounge's address by hand.

## Open items (not this branch)

- **Clear the cached Eventbrite venue on Inglewood Lounge** (EST Venues SRC). Ask Eric first.
- **Follow-up branches** to queue:
  - "Venues": address columns (Street/City/State/ZIP) plus adding a venue from the app. Leads allowed or not is still open.
  - "Fast writes": as above.
- **Eric to do:**
  - delete the personal Coda token at coda.io/account
  - rotate the Coda key committed in eventbrite-coda-pack `.coda.json`
  - delete the old Eventbrite token once the new one has been in use for a while
- **The test doc "Coda latency test (safe to delete)"** (https://docs.superhuman.com/d/_dIvHcJ6JYpv) can be deleted with Eric's OK. `~/.coda-latency-token` can be removed.
- **"Rosh Chodesh"** is at a private home with Address on listing set to Public. Eric was told; nothing was changed.
