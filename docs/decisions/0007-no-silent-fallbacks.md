# 0007 — No silent fallbacks (D7)

**Date:** Nov 2026 (PR #35) · **Status:** in force

## Decision

When required data is missing or a step can't do what was asked, fail with a message the
user can act on. Don't quietly substitute something else.

## Why

Two silent fallbacks shipped wrong listings: a missing venue fell back to an "online"
event, and a missing public description fell back to the internal description, which is
private (F13).

## Consequences

- Readiness checks block the push and link to the field instead.
- The Worker returns a reason (and logs rejections to `Publish Log`); the app shows it.
- Spec: `docs/superpowers/specs/2026-11-14-publish-flow-footer-wizard-design.md`.
