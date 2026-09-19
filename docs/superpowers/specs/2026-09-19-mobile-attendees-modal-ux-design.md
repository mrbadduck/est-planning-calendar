# Mobile: modal full-height + Attendees roster UX — design

**Date:** 2026-09-19
**Status:** Design approved, → implementation
**Area:** `web/styles.css`, `web/app.js` (`renderAttendees`/`wireAttendees`)

## Problem

Three unrelated mobile/UX rough edges in the event editor:

1. **The opened event modal leaves a gap at the bottom on narrow screens.** The
   workspace modal caps its height ~96px short of the viewport instead of
   filling it.
2. **The Attendees filter pills dominate the screen on narrow widths.** Segments
   are 6 fixed chips + **one per distinct sign-up slot**; an event with many
   slots (e.g. the break-fast) produces 15–25 chips that `flex-wrap` into a tall
   stack, pushing the actual roster off-screen.
3. **Attendees selection controls are non-standard.** The select-all checkbox
   sits in the footer instead of the list header, and the Copy/Email footer is
   always visible (disabled at 0 selected) rather than appearing on selection.

## Design

### 1. Modal fills the screen on mobile (CSS only)

The `@media (max-width:600px)` block already sends plain `.modal` to full height,
but `.modal.ws` / `.modal.create` override it (`height:min(760px, calc(100dvh -
96px))`) with no mobile counterpart. Add, inside that media block:

```css
.modal.ws,.modal.create{height:100dvh;max-height:100dvh;max-width:none}
```

No JS change.

### 2. Filter pills → single horizontal-scroll row on narrow screens (CSS only)

`.roster-wrap` is already `container-type:inline-size`. Add a container query
(≤480px) that turns `.roster-segs` from a wrapping cluster into a one-line,
horizontally-scrollable bar: `flex-wrap:nowrap; overflow-x:auto`, chips
`flex:0 0 auto`, hidden scrollbar (touch momentum). Desktop keeps the wrap. Chips
keep their labels, counts, and active state — just confined to one swipeable row.
Chosen over a dropdown so per-slot counts stay visible at a glance (standard
mobile filter-chip pattern).

### 3. Select-all moves into the table header

Remove the select-all checkbox from the footer. Render it in the roster table's
header row, first cell (above the per-row checkbox column) — the conventional
list/table position. Because the table body is re-rendered by `paintRows`, the
select-all element is recreated each render; `paintFoot` must **re-query** it
(`wrap.querySelector('[data-selall]')`) rather than hold a stale reference, and
guard for its absence in the empty-segment state (no table → no select-all). The
existing delegated `change` handler (`e.target.matches('[data-selall]')`) already
survives re-render, so no new listener is needed.

### 4. Footer appears only on selection

The footer (`.roster-foot`) holds the selected-count + Copy emails + Email. Hide
it entirely when 0 rows are selected; show it at ≥1. Implemented by toggling
`foot.hidden` in `paintFoot` (`foot.hidden = chosen().length===0`) plus an
explicit `.roster-foot[hidden]{display:none}` rule (needed because `.roster-foot`
sets `display:flex`). The footer no longer contains the select-all; the
selected-count label (`data-selcount`) stays. The clipboard-fallback insertion
that anchors on `.roster-foot` still works (the node exists, just hidden).

## Non-goals

- No change to what data the roster shows, the segment logic (`RosterLib`), or
  the copy/mailto behavior.
- No change to desktop layout for any of the four.
- No new dependencies; stays buildless.

## Verification

`node --check web/app.js` after JS edits; live browser pass at mobile width
(375px): modal fills height; pills scroll horizontally in one row; select-all in
the header selects the visible segment; footer hidden until a row is checked,
then Copy/Email work.
