# 0008 — Coda applies writes ~28 s after accepting them

**Date:** measured 2026-11-16 · **Status:** a fact to design around

## Finding

Coda's API accepts a write at once (HTTP 202) and applies it 25–35 s later. Measured on
2026-11-16: a near-empty test doc had a median of 28.0 s; Mission Control 26.9 s. Doc size
is not the cause, so slimming the doc won't help.

## Consequences

- Saves are honest about it ([0005](0005-saved-means-applied.md)), so they look slow.
- Reads right after a write can miss it. The app keeps local copies (`_unsaved`,
  `_recent`) and reconciles later.
- An Eventbrite push inside the apply window must not create a duplicate event (R19).
- Proposed, not approved: a "fast writes" branch where the Worker remembers recent writes
  and serves reads with them applied (newer timestamp wins).
