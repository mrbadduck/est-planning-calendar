# Design + Plan — Status state machine + editor refinements

**Date:** 2026-08-23 · **Branch:** `feat/eventbrite-publish` · Follows the
save-pattern redesign. Driven by Eric's review feedback (7 items).

## Quick refinements (1,2,4,6,7)

1. **Modal height parity** — the compact create modal is content-height while the
   workspace is a fixed 760px, so Create→workspace visibly jumps. Give the create
   modal the same fixed shell (`.modal.create` = `height:min(760px,100dvh-96px)`,
   `max-width:740px`); its body stays the normal scrolling grid.
2. **Header title = event title** — in the workspace, `#mTitle` shows the event's
   title (falling back to "Untitled"/"New event"), not the literal "Edit event".
3. **Drop the "Done" button** — folded into the footer redesign (item 5).
4. **Copy link → icon button** — replace the text "Copy link" with an icon button
   next to the ✕ (same treatment), `title="Copy link"`.
6. **Feedback/Ideas → next to the avatar** — move `#feedbackBtn` from row2 into
   row1, just before `#authSlot`.
7. **Signing-in indicator** — between returning from Google and `/me` resolving,
   `#authSlot` shows a "Signing in…" spinner instead of the (stale) sign-in
   button. New `state.authPending` flag set at the start of `onCredential` and the
   boot `fetchMe` (when a stored token exists), cleared when `fetchMe` settles.

## Status state machine (item 5)

Replaces the `idea/draft/confirmed/approved` dropdown with an **action-driven**
lifecycle. **Status stores only four states**; "Live" and "Past" are derived.

**States (Coda `Status`):** `Draft`, `Proposed`, `Approved`, `Cancelled`.
**Derived badges (not stored):** *Live* = Approved + Eventbrite `publishStatus`
=Published; *Past* = event date < today and not Cancelled.

**Transitions** — at any point: one forward action, or bail to Cancelled;
Cancelled can be reopened by Council.

| From | Forward (who) | Bail (who) | Reopen (who) |
|------|---------------|-----------|--------------|
| Draft | **Propose** → Proposed (writer) | **Cancel** → Cancelled (writer) | — |
| Proposed | **Approve** → Approved (**Council**) | **Cancel** → Cancelled (writer) | — |
| Approved | **Publish** (writer, Publish section) | **Cancel** → Cancelled (writer; tears down the EB listing) | — |
| Cancelled | — | — | **Reopen** → Draft (**Council**) |

- **Delete** is **Council-only**, available in any state (hard row removal). Leads
  get **Cancel** in that spot; Council sees both Cancel and Delete.
- **Roles:** `writer` = Program Lead or Council (`canWrite`); `Council` =
  `canApprove`. Leads never see Approve.

**Footer layout:** transition actions on the **left** (Propose/Approve/Cancel/
Reopen + Delete), **save-status on the right**. **Header:** derived status badge +
copy-link icon (no dropdown, no approve button — those are footer actions now).

**Locked (fields read-only + autosave off):** `Cancelled` (everyone — reopen to
edit) OR `Approved` and not Council (leads can't edit an approved event, as today).
Council can still edit an Approved event. Cancel/Reopen/Delete remain available
even when the fields are locked.

### Cancel → Eventbrite teardown

New role-gated Worker route **`POST /cancel/eventbrite {rowId}`** (writer):
1. Read the row. If it has an `Eventbrite Event ID`:
   - `POST /events/{id}/unpublish/` (reverts to draft — clean/silent, works for
     free events with no orders).
   - If unpublish fails (orders/registrants), `POST /events/{id}/cancel/`
     (Eventbrite marks it cancelled + notifies registrants).
2. Set `Status=Cancelled` (+ reflect `Publish status`), append to the Publish Log.
3. No `Eventbrite Event ID` → just set `Status=Cancelled`.

Same write gate + logging posture as `/publish/eventbrite`.

### Other Worker changes

- **Delete** row: gate raised from `canWrite` to `canApprove`.
- **Approve** (Status→Approved) gate unchanged (Council).
- **Reopen** (Cancelled→Draft) is a plain Status write, **app-gated** to Council
  (server still allows a writer to set Status; acceptable for v1's trusted leads).

### App changes

- `STATUSES = ['draft','proposed','approved','cancelled']`; `newEventOn`/
  `newIdeaInMonth` seed `draft`. `planningRowToEvent` default `draft`;
  `eventToCodaCells` writes `cap(status)`.
- **Chip coloring** (`.chip/.gchip/.qchip`): `draft`→dashed (was idea/draft),
  `proposed`→tint+solid (was confirmed), `approved`→filled+lock (unchanged),
  `cancelled`→struck/greyed (new). Badges `.b-draft/.b-proposed/.b-approved/
  .b-cancelled/.b-live/.b-past`.
- Header `statusBadge(ev)` → derived label. Footer `footerActions(ev,canWrite,
  canApprove)` → the role/state button set. `transitionTo(status)` saves + rebuilds
  the editor (`openEditor(editing, activeSection)`); Cancel calls
  `DB.cancelEventbrite`. Remove the `#f_status` select + header approve/reopen;
  remove the workspace footer "Done".
- `DB.cancelEventbrite(rowId)` → `POST /cancel/eventbrite`.

### Coda migration (one-time)

Update `Status` select options to `Draft/Proposed/Approved/Cancelled` and remap
existing rows: `Idea→Draft`, `Draft→Draft`, `Confirmed→Proposed`,
`Approved→Approved`.

## Verification

`node --check web/app.js`; `node --test` in `proxy/`. Browser preview for the
signed-out shell (create-modal height parity, header title, copy-link icon,
feedback placement, signing-in spinner render). Authed transition/cancel paths
need a signed-in lead + council to confirm end-to-end.

## Non-goals

- Attendee-facing cancellation comms beyond Eventbrite's own cancel email.
- gCal teardown on cancel (future downstream work).
