# 0004 — Auth is phased

**Date:** Aug 2026 · **Status:** in force (phase 2 live)

## Decision

- **Phase 1:** read-only Worker plus a CORS allowlist. No login.
- **Phase 2 (live):** Firebase Authentication in the app (Google + email magic-link).
  The app sends the Firebase ID token; the Worker verifies the JWT, matches the email to
  `EST People SRC`, and gates by role: write = Program Lead or Tribal Council, approve =
  Tribal Council. Writes inject the person as attribution.

## Why

Writes are what need gating; reads of planning data are low-stakes. Phasing let the read
path ship with near-zero auth code, and kept identity checks server-side when writes
arrived.

## Consequences

- Role checks that matter are in the Worker. UI-only locks (past events, #32) are
  conveniences, not security.
- Local sign-in needs `localhost` in Firebase's authorized domains.
- Details: `docs/phase2-plan-2b-i-auth-writes.md`.
