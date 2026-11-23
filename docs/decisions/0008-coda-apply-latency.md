# 0008 — Coda applies writes ~28 s after accepting them

**Date:** measured 2026-11-16 · **Status:** a fact to design around; the Worker covers it
for its own reads since [0012](0012-write-through-overlay.md) (2026-11-23)

## Finding

Coda's API accepts a write at once (HTTP 202) and applies it 25–35 s later. Measured on
2026-11-16: a near-empty test doc had a median of 28.0 s; Mission Control 26.9 s. Doc size
is not the cause, so slimming the doc won't help.

## Consequences

- Saves are honest about it ([0005](0005-saved-means-applied.md)). With the write overlay
  live, an edit counts as saved once the overlay holds it, so it no longer looks slow; a new
  event, and any save when the overlay is off, still waits ~28 s.
- Reads through the Worker right after a write no longer miss it: the overlay is merged into
  them. Coda-side readers (Coda's UI, formulas, pack syncs) and the sync runners
  (`eb-sync-run.js`, `gcal-run.js`) still do. The app still keeps local copies (`_unsaved`,
  `_recent`) and reconciles later, which covers an overlay outage.
- An Eventbrite push inside the apply window must not create a duplicate event (R19).
- Fast writes, where the Worker remembers recent writes and serves reads with them applied
  (newer timestamp wins): adopted, see [0012](0012-write-through-overlay.md).
