# 0010 — The Worker is the only writer of Google Calendar

**Date:** 2026-11-22 · **Status:** in force

## Context

EST's Google Calendar was kept by a Zapier Zap (Eventbrite to calendar) and a Coda rule
("Daily Event Freshen Up"). Between them, events were doubled, dates went stale, and
cancelled events stayed up. Only events that were on Eventbrite reached the calendar at all.

## Decision

The Worker keeps the calendar in step with the planning table (spec §6). Nothing else writes
to it once the cutover is done.

- **One writer.** The Worker, through a service account EST owns. The Zap and the Coda rule
  are switched off at cutover.
- **Stored ids.** Each planning row keeps its calendar event id in `gCal Event ID`. A new
  event is inserted with a deterministic id derived from the row id (`gcalEventIdFor`:
  hex of the row id's bytes), so two inserts for one row end in a 409, never a duplicate.
  The Worker also keeps `{id, hash, date}` per row in KV to skip unchanged rows.
- **Full replace, not patch.** An update sends the whole event (PUT). No field survives
  from an earlier version, so a cleared date or venue really clears. An update Google no
  longer has is inserted again.
- **Delete on cancel.** A row that is not approved, dated and exact leaves the calendar.
  A delete the calendar no longer has counts as done.
- **Sync window: yesterday onward.** The sweep only looks at rows dated yesterday or later,
  so history is never touched. A past event stays as it was; a row whose date moves out of
  the window is deleted only if its last written date was still inside it.
- **Its own cron and call budget.** `3,18,33,48 * * * *`, apart from the Eventbrite sweep.
  A run makes at most 15 changes and stops early when it would pass the 50 outbound calls
  a free-plan invocation allows. A cursor resumes the next run where this one stopped.
  A lead's Publish, Cancel or Unpublish updates its row right away; the sweep catches the rest.
- **Modes (`GCAL_MODE`).** `off` does nothing (default; also when `GCAL_CALENDAR_ID` is
  unset). `shadow` works out every change and records it in the Publish Log (target
  `Google Calendar`) without calling Google. `live` calls Google. Shadow runs for a week so
  the Worker's plan can be compared with what the Zap and the rule did.

## Consequences

- Every approved dated event reaches the calendar, on Eventbrite or not. The description
  reads "Registration on Eventbrite coming soon" until published, then the Eventbrite link.
- Registrants-only events show only the area as location.
- Existing calendar events are linked first (`scripts/link-gcal-ids.mjs`), so the Worker
  updates them instead of adding second ones.
- Edits made by hand on the calendar are overwritten on the next change to the row.
- Deployment and cutover steps are in `docs/deployment.md` (Google Calendar sync).
