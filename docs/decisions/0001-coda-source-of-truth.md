# 0001 — Coda is the source of truth

**Date:** Aug 2026 · **Status:** in force

## Decision

Superhuman Docs (Coda) holds every planning event, in `EST Planning Events SRC`
(`grid--gYIvdD-cE`) in the Mission Control doc (`DYAz_wCVfv`). The app is a thin view
layer that owns no data. It reads and writes only through the Worker (`proxy/`).

Inside the app, every Coda row is converted to one normalized event shape by
`planningRowToEvent`, and back by `eventToCodaCells`, inside `CodaSource`. The UI reads
only normalized events and must not learn the Coda row shape.

Planning rows live in a new table (not a status field on `EST Events SRC`): the app
originates events, inverting the old Eventbrite-first flow.

## Why

A planning event is a rich relational record (program, leads, venue, ticketing,
promotion) that the rest of EST already runs from Coda: automations, metrics and the
Eventbrite sync pack. A second store would drift. Browser storage holds only caches and
per-device UI state.

## Consequences

- Reads are as fresh as Coda (see [0008](0008-coda-apply-latency.md)) and the Worker's
  KV cache.
- Reference Coda columns by stable id, not name, where it has been done
  (`proxy/src/coda-columns.js`); the planning seam is still name-keyed.
- Details: `docs/phase2-planning-table.md`, `docs/architecture.md`.
