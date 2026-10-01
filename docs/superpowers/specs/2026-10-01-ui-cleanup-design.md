# UI cleanup batch — design

**Date:** 2026-10-01 · **Status:** approved in conversation · **Branch:** `feat/ui-cleanup`

Eight small fixes to the planner's UI (`web/`), raised by the user after using the
new-event form and the calendar. One branch, one PR. Help ships with it.

## 1. Venue type: a dropdown instead of a wrapping segmented control

The six venue types under **Where** wrap onto two rows in a half-width card and the
segmented borders break. Replace the `#f_vtype_seg` buttons with one labeled native
select: label **Venue type**, options **Any** (value `""`) plus each venue type
(value = its row id). It sits above **Search venues…** and keeps today's behavior:

- changing it filters the venue search (`initVenuePicker`'s pool reads the select);
- picking a venue sets the select to that venue's type;
- `readForm()` reads the select's value as `venueType`;
- a change schedules an autosave.

When the relations show read-only (`relationsReady`), the select isn't rendered and
`readForm()` falls back to the event's own value, as it does today. The When and
Address controls (2–3 options) stay segmented.

## 2. The new-event form sizes to its content

`.modal.create` has a fixed height (`min(760px, 100dvh − 96px)`), which leaves a
tall empty band above the footer. Give it `height:auto` with the same value as a
`max-height`, so the body scrolls only when it must. Phones (≤600px) stay
full-screen. The workspace (`.modal.ws`) keeps its fixed height: its tabs switch
between panels of different heights.

## 3. Past approved or live events: Details is read-only, no Cancel/Delete

New helper `isHistory(ev)`: `isPastEvent(ev) && ev.status === 'approved'` (Approved
or Live, date gone by). For such an event, `openEditor`:

- renders **Details** read-only. Every field is disabled and the publish panel is
  hidden. The lock note reads "🔒 This event has happened, so its details are
  locked." No save label shows, and the form isn't bound for autosave;
- shows no footer actions (`footerActionsHTML` returns nothing). An approved
  event's only actions were Cancel and Delete;
- leaves **Planning Notes**, **Potluck & Volunteers** and **Attendees** exactly as
  they behave today. Notes keeps using the existing `locked` flag, not the
  history lock.

Past drafts and proposals are unaffected, so they can still be rescheduled,
cancelled or deleted. Cancelled events are never "past" (`isPastEvent` excludes
them).

## 4. Instant tooltips on icon buttons

A small shared tooltip for any element with `data-tip`. One fixed-position bubble,
placed below the element, shows at once on pointer hover and on keyboard focus. It
hides on leave, blur, scroll, click or Escape. It's fixed-position so it isn't
clipped by the modal. Applies to:

- the event header's **?** (Help for this tab), **View in gather**, **Copy link**
  and **×** (Close);
- the page header's **?** (Help), **↻** and **⚙**.

These elements drop their `title` (no double tooltip) and keep `aria-label`. Touch
screens get no tooltip (no hover); the labels still serve screen readers.

## 5. The Help drawer pushes the page aside on wide screens

On windows ≥1000px, `body.help-open` gets `padding-right: var(--help-w)`. The
sticky header and the calendar then narrow beside the drawer instead of sitting
under it, so the page stays visible, scrollable and clickable. The modal scrim
already reserves the drawer's width on these screens, so an open event still sits
beside it. Opening or closing the drawer re-runs `layoutSticky()`, because the
header's height can change when it narrows.

From 601 to 999px the drawer keeps overlaying, since pushing would leave too
narrow a page. Phones (≤600px) keep the full-screen drawer.

## 6. Tooltip text

- **↻**: "Refresh event data" (was "Refresh from Coda").
- The **Planning events** toggle loses its wrong "Your planning events (always
  shown)" title. In the settings panel, the **Show on calendar** heading says it.

Both are items in #26.

## 7. Only a "+" button adds an event

- **Calendar view:** each day cell gets a small **+** button in its top-right
  corner (`aria-label` "Add an event on <date>"). Today's faint `+` hint becomes
  this button. Only the button opens the new-event form for that date; clicking
  elsewhere in the cell does nothing, and the cell loses its pointer cursor.
- **Ideas column:** each month's Ideas cell gets the same **+** button for a
  whole-month idea. The cell itself no longer adds.
- **Overview:** each weeknight and weekend lane gets a hover highlight and its own
  **+** button. Only the button adds.

Event chips keep opening their events. The buttons show on hover and on keyboard
focus. On touch screens (`hover: none`) they show faintly all the time.

## 8. A settings panel replaces the layers strip

- The layers strip under the header (`#layers`: "Your plans / Reference") is removed
  from the page.
- Its toggles move permanently into the existing pop-over panel (`#ovfPanel`),
  under the heading **Show on calendar**.
- The panel opens from a flat **⚙** button (`#ovfBtn`, styled like ↻, tooltip
  "Calendar settings") at every width.
- The year picker always stays in the header. `applyHeaderMode` no longer moves it
  into the panel on phones.
- The header's right side becomes **↻**, **⚙**, **+ New event**, in that order.
- On phones, **+ New event** shows just **+** so the row fits next to the view
  switch and year picker. The full text stays in the markup for the help guard and
  screen readers.

## Help

Update `web/help/guide.md` wherever these surfaces are described:

- *Read the calendar*: the layers live under **⚙**, and the "⋯ menu" sentence goes.
- *Add an event*: hover over a day or lane and click its **+**; the Ideas column has
  a **+** too.
- *Lifecycle*: Cancel is available until an approved event's date has passed. A
  past approved event's details lock, while Notes, sign-ups and Attendees still
  work.
- *Troubleshooting*: "make sure **Planning events** is on under **⚙**".

Add a dated `web/help/whats-new.md` entry. `node scripts/check-help.mjs` must pass.

## Testing

`node --check web/app.js`, `cd proxy && npm test`, and the help guard. Each item is
checked in the local preview at desktop (≥1000px), tablet (768px) and phone (375px)
widths, with screenshots for the visual items (1, 2, 5, 7, 8). Item 3 is checked
with a simulated identity on a past approved event, with writes stubbed. No Worker
change and no deploy before merge.
