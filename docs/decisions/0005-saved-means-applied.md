# 0005 — "Saved" means Coda applied the write (D3)

**Date:** Nov 2026 (PR #35) · **Status:** in force

## Decision

The app shows a change as saved only once Coda has *applied* it
(`mutationStatus.completed`, polled through the Worker's `GET /mutation/:id` by
`CodaApplied` in `web/coda-applied.js`), not when Coda accepts it (HTTP 202). Until then
the primary button reads **Saving…** (`pendingFor`), and **Still saving…** after 20 s.
Anything that reads Coda after a save (an Eventbrite push, a transition) waits until
nothing is pending.

## Why

Acting right after an accepted-but-unapplied write read stale data (F1, F2, F4 in the
PR #35 spec): pushes sent old values, transitions raced edits.

## Consequences

- Saves look slow, because Coda applies writes ~28 s after accepting them
  ([0008](0008-coda-apply-latency.md)). The fix being considered is "fast writes" in the
  Worker, not weakening this rule.
- Spec: `docs/superpowers/specs/2026-11-14-publish-flow-footer-wizard-design.md`.
