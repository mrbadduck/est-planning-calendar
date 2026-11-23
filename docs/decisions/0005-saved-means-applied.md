# 0005 — "Saved" means the Worker's planning reads return the write (D3)

**Date:** Nov 2026 (PR #35) · **Status:** amended by [0012](0012-write-through-overlay.md)
(2026-11-23)

## Decision

The app shows a change as saved only once reads through the Worker return it (the planning
routes, gather, slots, claims, the roster and venues), never merely because Coda accepted it
(HTTP 202).
That means one of two things:

- **Overlaid:** Coda accepted the write and the Worker's write overlay holds it
  ([0012](0012-write-through-overlay.md); the response says `overlaid: true`). The save
  shows as done when the request returns (~1 s). Its confirm still runs in the background
  (`confirmLater` in `web/save.js`, polling `GET /mutation/:id`).
- **Not overlaid** (`OVERLAY_MODE = "off"`, the overlay unreachable, or a write it can't
  record): Coda has *applied* it (`mutationStatus.completed`, polled through the Worker's
  `GET /mutation/:id` by `CodaApplied` in `web/coda-applied.js`), as before 0012.

A new event always waits for Coda to apply its insert, whichever case applies: Coda refuses
writes to a row it hasn't created. Until a save counts as saved, the primary button reads
**Saving…** (`pendingFor`), and **Still saving…** after 20 s; a new event's reads
**Creating… (about half a minute)**. A step that reads the row after a save (an Eventbrite
push, a transition) waits until nothing is pending, which for an overlaid write is as soon as
its request returns.

A write that never confirms is shown, never hidden. `/mutation` reports `failed` once an
overlaid write is 120 s old and still not applied; the app treats that like any unconfirmed
save: **Save failed — retry**, the edit put back with a toast, or a toast naming the step.

## Why

Acting right after an accepted-but-unapplied write read stale data (F1, F2, F4 in the
PR #35 spec): pushes sent old values, transitions raced edits. The overlay removes the stale
read for everything that reads through the Worker, so the wait is needed only where it
isn't overlaid.

## Consequences

- With the overlay live, an edit is saved as soon as its request returns. With it off, or for a new event,
  saves still take ~28 s ([0008](0008-coda-apply-latency.md)), and the help is worded to be
  true either way.
- Coda's own readers (its UI, formulas, pack syncs) and the sync runners still see a write
  only once Coda applies it ([0008](0008-coda-apply-latency.md)).
- Spec: `docs/superpowers/specs/2026-11-14-publish-flow-footer-wizard-design.md`; the
  overlay: `docs/superpowers/specs/2026-11-23-write-through-overlay-design.md`.
