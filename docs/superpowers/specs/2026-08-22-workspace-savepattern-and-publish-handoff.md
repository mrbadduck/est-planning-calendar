# Handoff — save-pattern redesign + publish-update SC error

**Date:** 2026-08-22 · **Branch:** `feat/eventbrite-publish` (NOT merged; ~31 commits since `main`).
Read this cold and you can continue. Two open items (§A design/build, §B bug). Everything else in this branch is built, deployed (proxy), and verified.

---

## Where things stand (context you're inheriting)

This branch shipped, in order (all on `feat/eventbrite-publish`):
1. **Eventbrite publish-out v1** — direct-from-Worker `POST /publish/eventbrite`; create→venue→ticket→structured-content→publish; role-gated (canWrite + Approved + exact date/time); observability = Coda `Publish Log` (`grid-CJNl0A1OGZ`) + planning-row status fields + in-app errors. **Verified end-to-end**: a **draft** publish of the test event succeeded (create/venue/ticket/description → Draft). Registrants-only safety (coarse `Nashville, TN` venue, structured city/region/country, no street/host-name leak) works.
2. **Event workspace (section model)** — editor modal is now a **rail + section panel**. Live sections **Planning** + **Publish**; muted **Coming soon** group (Budget/Comms/Volunteers/Attendance/Feedback). Internal description (Planning) vs **Public summary/Public description** (Publish → Eventbrite). `openEditor(ev, section)`; `readForm()` null-guards every field.
3. **URL deep-links** `?event&section` (`syncUrl`/`clearUrl`/`openFromUrl`) + header **Copy link**. Verified.
4. **Feedback/Ideas board** — votable, global header CTA (`#feedbackBtn`) + context board in each coming-soon section. Coda `Roadmap Feedback` (`grid-pP5rwauO2j`); Worker `GET/POST /feedback` + `POST /feedback/:id/vote`. Shows status pills, optimistic insert on submit. Verified rendering + live list.
5. **Layout fixes** — workspace modal = fixed height (`.modal.ws` 760px), `.mbody.ws` flex, rail pinned, only `.wpanel` scrolls, field spacing restored. Verified.

**Proxy is DEPLOYED** (`est-planning-proxy.eastsidetribe.workers.dev`); app is **local-only** (deploys to `plan.eastsidetribe.org` on merge to `main`). Config: `EVENTBRITE_TOKEN` (secret, set), vars `EVENTBRITE_ORG_ID=1080997994263`, `EVENTBRITE_TZ`, `EVENTBRITE_COUNTRY/AREA_CITY/AREA_REGION`, `CODA_PUBLISH_LOG_TABLE=grid-CJNl0A1OGZ`, `CODA_FEEDBACK_TABLE=grid-pP5rwauO2j`.

**Docs:** designs `docs/superpowers/specs/2026-08-22-eventbrite-publish-design.md` + `…-event-workspace-section-model-design.md`; plans `docs/superpowers/plans/2026-08-22-eventbrite-publish.md` + `…-event-workspace.md`. **Memory:** `eventbrite-publish.md`.

**Coda ids** (doc `DYAz_wCVfv`): planning table `grid--gYIvdD-cE` (Public summary `c-z_vizJhFiU`, Public description `c-FPf9UlI_8n`, + publish/status cols from the eventbrite spec); venues `grid-foC40iAOaX` (`Eventbrite Venue ID` `c-8q1sI7FT2R`, `Eventbrite Private Venue ID` `c-KPZs1NHQFF`); people `grid-X316Eql8dE`; `Publish Log` `grid-CJNl0A1OGZ`; `Roadmap Feedback` `grid-pP5rwauO2j`.

**Test event:** `i-JndSN9Ji7U` ("testing"), Eventbrite event `1998656522461` (a DRAFT — delete when done; nothing public).

**Local dev:** `npx -y live-server web --port=8080 --no-browser`; sign in as a lead (Eric) — the app hits the deployed proxy. `localhost:8080` IS a whitelisted Google OAuth origin.

---

## §A — Save-pattern redesign (Eric's decision — build this)

The current global **Save/Cancel** footer is confusing in a multi-section workspace (edit in one section, switch, hit Save). Current code already does **capture-on-switch** (`Object.assign(ev, readForm())` in the rail handler) so edits survive navigation — but the pattern itself is wrong. **Replace it with the model Eric specified:**

1. **Creating a new event = a one-shot Planning form in its OWN simple modal** (reuse the same Planning form component — `renderPlanning`/`wirePlanning`), with clear **Cancel / Save**. It is NOT the workspace (no rail) — just the planning fields.
2. **On save (create), transition to the full workspace modal** (`openEditor(savedEvent)` with the rail) so the lead lands in the workspace for the just-created event.
3. **Opening any EXISTING event uses the full workspace modal** (rail + sections), as now.
4. **Auto-save-capable fields auto-save on blur**, with a **save-status indicator in the modal header** (e.g. "Saved" / "Saving…" / "Unsaved changes"). The Planning fields are the natural auto-save candidates (title, program(s), leads, when, venue, volunteers, internal description).
5. **Fields/sections that do NOT auto-save get clear dirty-state visualization + action buttons local to that form/section.** The **Publish** section is the prime example: public summary/description/capacity/address are staged, then the deliberate **Create draft / Publish** buttons act on them — show a dirty indicator there, don't auto-save into a live listing.

Implementation notes / gotchas:
- The app already has optimistic-save machinery: `saveEditor(approve)`, `applyLocal`, `_recent` guard, `scheduleReconcile`, and Coda's read-after-write lag handling. Reuse it for the on-blur auto-save (debounce; use the `_recent` guard so a reconcile can't revert an optimistic save).
- New-event first-save: the one-shot create modal solves the "when does a new row first persist" problem cleanly (it persists on the create Save; no premature empty rows) — that's *why* Eric split it out. Honor that.
- Approve stays in the header; Publish/Create-draft stay in the Publish section. The footer's generic Save/Cancel goes away for the workspace (existing events); keep **Delete** + the save-status indicator.
- Files: `web/app.js` (`openEditor`, `saveEditor`, section framework, a new `openNewEventForm()` or similar, on-blur wiring), `web/styles.css`. Keep it buildless; `node --check web/app.js` after edits.
- Consider a short brainstorm/spec pass before building — this reshapes the create + save flows.

---

## §B — Publish-UPDATE structured-content error (INVESTIGATE + fix)

**Symptom:** publishing **updates** to the test event (re-running publish/create-draft on `i-JndSN9Ji7U`, which already has Eventbrite event `1998656522461`) throws an error mentioning **structured content**. The FIRST draft publish succeeded; the error is on a SUBSEQUENT update/re-publish.

**Eric's read:** likely the (not-yet-implemented) rich-description formatting — but note the description field is still **plain text**, so this is most likely the **Structured-Content write on update**, not rich text. Investigate before assuming.

**How to investigate:**
- Read the **Publish Log** (`grid-CJNl0A1OGZ`) — the row's `Action`/`Message`/`HTTP status` capture the verbatim Eventbrite error. And/or `cd proxy && npx wrangler tail` while reproducing.
- The SC write path (in `proxy/src/worker.js` `/publish/eventbrite`, step 4): `GET /events/{id}/structured_content/` → `const pv = sc.body && sc.body.page_version_number; const ver = (typeof pv === 'number') ? pv + 1 : 0;` → `POST /events/{id}/structured_content/{ver}/` with `structuredContentBody(publicDescription||internal, ver)` = `{publish:true, modules:[{type:'text',data:{body:{text, alignment:'left'}}}]}`.
- **Likely culprits** (from the SC research, `…-event-workspace-section-model-design.md` §research + the eventbrite design spec):
  - `PAGE_VERSION_DISCONTINUITY` — the version we write doesn't match Eventbrite's expected current+1. After the first draft, the event has a published SC version; on update, `GET structured_content/` may return only the latest **published** version, and our `+1` may be off (e.g. off-by-one, or GET returns nothing and we write 0 again → discontinuity). **Most probable.** Fix: log what `GET structured_content/` returns on the second run and compute the version from the true current.
  - The `{publish:true}` body flag or the `alignment` field being rejected/ignored — less likely (first draft worked), but confirm the *update* path uses the same builder (it does).
- The SC-fix commit `8ee6435` (alignment + version-0) was deployed; the update error suggests the **version computation on re-write** still needs work. Reproduce, read the exact message, then fix the version logic (and add a `PAGE_VERSION_DISCONTINUITY` retry: re-GET and write current+1).
- Unit-test the fix in `proxy/test/eventbrite.test.js` where possible (the version logic is testable if extracted); verify end-to-end by re-publishing the test event twice.

---

## Suggested resume order
1. Reproduce §B, read the Publish Log error, fix the SC version-on-update logic + deploy — quick, unblocks re-publishing.
2. Brainstorm → spec → build §A (create-form-then-workspace + on-blur auto-save + save-status + dirty states).
3. Finish the branch: verify signed-in (submit idea/vote; publish with distinct public copy shows the *public* text on Eventbrite), then PR → merge (deploys the app).
