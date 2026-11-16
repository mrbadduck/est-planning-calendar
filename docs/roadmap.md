# Roadmap and history

Moved out of CLAUDE.md on 2026-11-16. What has shipped, what's next, and the decisions
still open. Settled decisions are in `docs/decisions/`.

## Shipped

- **Live at `plan.eastsidetribe.org`** (Netlify), on live data through the Worker.
  Leaders sign in with Firebase (Google + email magic-link) and create, edit, approve and
  publish planning events that persist to `EST Planning Events SRC`, with
  server-verified identity, role gating and person attribution.
- **Publish flow (PR #35, Nov 2026, not yet merged):** footer wizard, honest saves (D3),
  Details/Planning split, Free tickets, Preview at every stage.
- **Registrant comms v1 (Sep 2026):** Attendees roster + copy/mailto.
- **gather** (member sign-up app): code-complete, all 5 slices (Aug 2026); site not
  created yet — see `docs/gather-deploy-runbook.md`.

## History of the phases

**Phase 1 — stand up the spine (deploy + read-only) — ✅ DONE (Aug 2026).**
App live at `plan.eastsidetribe.org` (Netlify) → Worker
`est-planning-proxy.eastsidetribe.workers.dev` (read-only) → Coda. See
`docs/deployment.md`.

**Phase 2 — writes + auth. Resolved: planning rows live in a NEW table,
`EST Planning Events SRC` (`grid--gYIvdD-cE`) — the app originates events
(inverting the old Eventbrite-first flow). See `docs/phase2-planning-table.md`.**

4. **Plan 1 — ✅ DONE (Aug 2026):** table created + seeded; proxy repointed; app
   reads it read-only.
5. **Plan 2a — ✅ DONE (Aug 2026):** proper types (native time; Month=`Date`=1st);
   `/ref/:name` endpoints; refresh (button/focus/60s poll).
6. **Plan 2b-i — ✅ DONE (Aug 2026):** Firebase sign-in (Google + magic-link) +
   Worker JWT verify + email→`EST People SRC` match + role gate (write = Program
   Lead/Tribal Council; approve = Tribal Council); role-gated writes inject
   person attribution; scalar create/edit/approve persist. See
   `docs/phase2-plan-2b-i-auth-writes.md`.
7. **Plan 2b-ii — editor relation pickers + full create-with-relations:**
   - **2b-ii-a — ✅ DONE (Aug 2026):** real program palette + generated colors from
     `/ref/programs`; multi-program editor picker (writes the `Program(s)`
     relation); crossover `+N` marker.
   - **2b-ii-b — ✅ DONE (Aug 2026):** slim `/ref/people` `{id,name,lead}`
     projection (1128 rows → ~100KB); **Leads** chip list (write-authorized only:
     Program Lead/Tribal Council); **Volunteers** typeahead over all people (new
     `Volunteers` relation column added to the planning table); **Venue** cascade
     (Venue Type → filtered Venue, hides closed) + `Venue (other)`; **Planning
     Notes** template seeded on new events. All persist as relations. See
     `docs/phase2-plan-2b-ii-b-relations.md`.

8. **Plan 2b-iii — Planning Notes as per-row Google Docs (Aug 2026, deployed):**
   internal notes moved out of the Coda `Planning Notes` canvas column into a
   **per-event Google Doc**. Coda provisions it via a **row button** (official
   Google Drive pack *Copy file*, template → shared folder) — the app triggers it
   through a role-gated `POST /notes-doc` proxy route that **pushes the button by
   its stable id** (`CODA_NOTES_BUTTON_ID`), then fast-polls until the URL lands.
   The editor shows a read-only `/preview` iframe + "Edit in Google Docs". The URL
   read is **anchored to the column id** (`CODA_NOTES_COL_ID`), resolved to the
   current name server-side via list-columns — rename-proof. Legacy `Planning
   Notes` text is read-only-if-present, no longer written. Design +
   plan: `docs/superpowers/specs/2026-08-20-planning-notes-google-docs-design.md`,
   `docs/superpowers/plans/2026-08-20-planning-notes-google-docs.md`.

**Later:**

- **Registrant comms v1 — ✅ DONE (Sep 2026):** Attendees roster + copy/mailto.
  Worker-side sending, a Comms Log, and the EST Memberships SRC-backed member rule
  are the follow-ups. Design:
  `docs/superpowers/specs/2026-09-16-attendees-roster-design.md`.
8. **References live:** Hebcal JSON for Jewish holidays; shared Google Calendars
   synced into Superhuman Docs and read via the proxy.
9. **Downstream automations** in Superhuman Docs (approved → Eventbrite/gCal/
   Mailchimp/socials).
10. **Polish:** real mobile layout; active conflict warnings; per-person
    layer-toggle persistence. Consider a 2-token split (read-only doc token +
    planning-write token) to tighten the Worker's write scope.
11. **(Optional) Embed** inside Mission Control — validate `web/embed-test/` first.


## Open decisions

- Weeknight/weekend grain in Overview vs. splitting Friday out from the weekend.
- Endpoint of the inversion: eventually replace `EST Events SRC` vs. coexist
  (deferred — "design the table first"; see `docs/phase2-planning-table.md`).

Resolved (Aug 2026): standalone hosting on **GitHub Pages** at
`plan.eastsidetribe.org` (not Cloudflare Pages/Access — keeps DNS at Hover); moved
to **Netlify** in the same standalone posture (two static sites, one repo — `web/`
→ `plan.eastsidetribe.org`, `gather/` → `gather.eastsidetribe.org`) without
disturbing that DNS-at-Hover decision. Auth
is **phased** (read-only + CORS now, Firebase sign-in + allowlist for writes);
planning rows live in a **new table** `EST Planning Events SRC` (not a status
field on `EST Events SRC`) — the app originates events, inverting the flow.

