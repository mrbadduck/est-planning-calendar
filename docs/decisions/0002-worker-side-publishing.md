# 0002 — Tokens and publishing live in the Worker

**Date:** Aug 2026 (revised from "downstream lives in Coda automations") · **Status:** in force

## Decision

No API token ever reaches the browser. The Coda token (doc-scoped) and the Eventbrite
private token are Worker secrets. Publishing to Eventbrite runs in the Worker through
role-gated routes (`POST /publish/eventbrite`, `/cancel/eventbrite`, …). The app asks;
the Worker checks the user's role and the shared readiness rules
(`web/listing-readiness.js`), then acts.

## Why

- Anything in client-side JS is readable, embed or standalone.
- Publishing through a Coda pack action was janky: Coda's apply lag made a synchronous
  Publish button unreliable. Direct from the Worker is immediate.
- Coda still owns aggregation and observability: the `eventbrite-coda-pack` syncs
  Eventbrite into `EST Events SRC`, and every publish attempt is logged to the
  `Publish Log` table.

## Consequences

- Never deploy the Worker or upload versions from an agent session; CI deploys on merge
  (`.github/workflows/deploy-proxy.yml`). `.claude/settings.json` denies the commands.
- `web/listing-readiness.js` is bundled into the Worker, so it must stay free of browser
  globals (checked by `scripts/check.sh`), and editing it redeploys the Worker.
- Design: `docs/superpowers/specs/2026-08-22-eventbrite-publish-design.md`.
