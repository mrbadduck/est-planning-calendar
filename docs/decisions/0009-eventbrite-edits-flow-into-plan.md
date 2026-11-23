# 0009 — Eventbrite edits flow into plan, field by field

**Date:** 2026-11-18 · **Status:** in force · supersedes [0006](0006-nothing-from-eventbrite-written-back.md)

## Context

Events get built directly on Eventbrite, and that route is permanent. Decision 0006 kept
plan blind to those edits, so an event made or changed on Eventbrite never reached plan
or gather. The F11 wipe that led to 0006 came from re-seeding the whole form from the live
listing, not from copying a single changed field.

## Decision

The Worker copies what changed on Eventbrite into the planning row, field by field
(spec §5.3, `docs/superpowers/specs/2026-11-18-eventbrite-sync-gcal-one-event-table-design.md`):

- A field is copied only when its live Eventbrite value differs from the pushed snapshot
  (`Last EB pushed values`). The snapshot holds what Eventbrite holds, normalized, and is
  refreshed after every push, import and flow-in.
- An unpushed plan edit is never overwritten. When the row and Eventbrite both changed a
  field, plan's value stays and the lead gets the existing "changed on Eventbrite" notice
  before they push.
- Synced: title, date, start, end, capacity, public description, venue, publish state.
  Never synced: the public summary, tickets and price, address visibility, except that
  when the venue itself changes on Eventbrite, the matched venue's own address visibility
  (public or private Eventbrite venue) comes with it.
- Only the Worker writes the snapshot, `Source` and `Last from Eventbrite`. The app
  reads them (`ev.origin`, `ev.lastFromEb`) and shows "Imported from Eventbrite" and
  "Updated from Eventbrite: …".

## Consequences

- 0006 is superseded. The app still never writes what it read from Eventbrite; the
  Worker does, under the rules above.
- Events made on Eventbrite appear in plan and gather within about 10-25 minutes (a
  15-minute sweep that skips events under 10 minutes old). Changes to an event already in
  plan usually arrive within about a minute (webhook). Right after a push from plan, the
  push's ebpending marker makes the sync skip that event for 10 minutes, so an Eventbrite
  edit then can take up to ~25 minutes (the next sweep after the marker expires).
- A plan Cancel is plan-owned: the sync never sets Status back over a Cancelled row
  unless Eventbrite says canceled, and a deleted listing on a Cancelled row changes nothing.
- Leads see what came in on the event page and in the help.
