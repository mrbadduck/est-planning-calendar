# 0006 — Nothing read from Eventbrite is written to Coda (D4)

**Date:** Nov 2026 (PR #35) · **Status:** in force

## Decision

The form always shows Coda's values. Nothing read from Eventbrite is put into the form or
written. Whether a field is in step with Eventbrite is decided by comparing the form with
the **pushed snapshot** (`Last EB pushed values` → `ev.pushed`), which only the Worker
writes, when it pushes. Live Eventbrite data (registrants, "edited on Eventbrite") is
read for display only.

## Why

The old flow re-seeded fields from the live listing and autosaved them ("Eventbrite is the
truth"). It wiped Capacity (F11). Eventbrite's `summary` is write-only and its description
comes back as normalized HTML, so comparing with live data was never reliable.

## Consequences

- A conflict (the listing was edited on Eventbrite) is shown as a notice before the user
  pushes; the Worker still refuses with 409.
- Spec: `docs/superpowers/specs/2026-11-14-publish-flow-footer-wizard-design.md`.
