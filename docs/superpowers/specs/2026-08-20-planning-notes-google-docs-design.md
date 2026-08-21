# Design — Planning Notes as per-row Google Docs

**Date:** 2026-08-20
**Status:** Approved (design); implementation plan pending
**Author:** Eric (with Claude)

## Problem

The two Coda **canvas** columns feeding the app — **Event Description** (public
promo) and **Planning Notes** (internal checklist) — surface as plain
`<textarea>`s ([`web/app.js:691`](../../../web/app.js), [`web/app.js:710`](../../../web/app.js)).
The proxy reads rows with `valueFormat=simpleWithArrays`
([`proxy/src/worker.js:162`](../../../proxy/src/worker.js)), which strips Coda's
rich canvas formatting to plain text, and the app writes them back as plain
strings. So any formatting authored in Coda's canvas is invisible/lost in the
app, and the app offers no doc-like authoring.

Goal (from brainstorming): a **nicer, doc-like authoring experience** for
**Planning Notes**, backed by real infrastructure — not a plain textbox.

## Decision summary

Move **Planning Notes** content out of Coda and into **Google Docs**, one doc
per planning event. Coda owns the *reference* (a URL cell); Google Docs owns the
*content* and provides the rich editor, collaboration, comments, and version
history for free. **Event Description stays in Coda** as today's plain textarea
(explicitly deferred — see Non-goals).

This was chosen over the two alternatives we explored:

- **Hand-rolled `contentEditable` Markdown WYSIWYG in-app** — rejected: the
  `contentEditable` + Markdown round-trip is a large bug surface to hand-roll.
- **Vendored single-file Markdown editor (e.g. TOAST UI Editor)** — viable and
  buildless-compatible, but delivers a *good* editor where Google Docs delivers
  the *best* one plus real multi-leader collaboration, which matters for a
  co-planned, volunteer-run org.

### Why this does **not** break the architecture

CLAUDE.md non-negotiables say Coda is the single source of truth (#1), the app
owns no data (#4), and **orchestration/automation lives in Coda, not the app**
(#3). This design honors #3 directly: **the doc-generation logic lives in a Coda
row button** (Copy Doc + write-back), not in the app; the app only reads the
resulting URL cell and *triggers* the button through the proxy. The app stays a
thin view layer. The one departure is that Planning-Notes *content* now lives in
Google Docs rather
than a Coda cell — an accepted, scoped trade for internal notes only. Event
Description, which flows **downstream** through Coda automations
(Eventbrite/Mailchimp), stays in Coda precisely because pulling it out would
break that flow.

## Verified constraints (checked during brainstorming, 2026-08-20)

1. **Editable Google Docs cannot be embedded in a third-party iframe.**
   `docs.google.com` sends `X-Frame-Options: SAMEORIGIN` / CSP
   `frame-ancestors 'self'` to block third-party framing of the editor.
   → Editing therefore happens in a **new tab**; the app embeds a **read-only
   preview** only.
2. **A privately-shared doc's `/preview` URL *can* be iframed** for a viewer who
   is signed into a Google account with access — it respects sharing
   permissions, so we do **not** have to publish notes publicly. A viewer not
   signed into Google (in that browser) sees a request-access/sign-in state
   instead → the "Edit in Google Docs" button is the reliable fallback.
3. **Coda's official Google Drive pack** has a **Copy Doc** action that copies a
   template Doc into a chosen Drive folder and returns the new doc's URL. This is
   the provisioning mechanism. **Verified working 2026-08-20** — pack installed,
   a template Doc + target folder created, and a canvas button running Copy Doc
   tested successfully. (This supersedes the earlier third-party Document
   Generation Pack candidate — the official pack removes the third-party-vetting
   and pricing concerns.)
   - Target Drive folder: `https://drive.google.com/drive/folders/1fZXRHWwKMD0FJFLWLUrw7r7kIWG_5sds`

Sources captured in the brainstorming transcript (X-Frame-Options behavior;
`/preview` vs publish-to-web; Document Generation Pack capabilities).

## Non-goals

- **Event Description richer editing** — stays the current plain textarea.
  Deferred, not part of this work.
- **Two-way rich sync with Coda's canvas** — notes live in Google Docs; the old
  Coda `Planning Notes` canvas column is no longer the content home.
- **Migrating existing plain-text notes into Google Docs** — existing text is
  displayed read-only if present; no bulk migration.
- **Any Google API integration in the Worker** — provisioning is Coda-side.

## Responsibility model

| Concern | Owner |
|---|---|
| Planning-notes **content** | Google Docs (one doc per event) |
| Notes doc **reference** (URL) | Coda `Notes Doc` column on the planning table |
| Notes doc **provisioning** | Coda row button (Copy Doc + write-back), pushed via the proxy |
| Notes doc **template/checklist** | A template Google Doc (holds `NOTES_TEMPLATE`) |
| **Rendering** preview + edit link | The app (thin view layer) |
| Auth / role gating + button push | Worker proxy (small new role-gated `POST /notes-doc` route) |

## Coda-side setup (one-time, no app code)

1. A **template Google Doc** containing the current `NOTES_TEMPLATE` checklist
   (see [`web/app.js:24`](../../../web/app.js), `NOTES_TEMPLATE`). **Done** — a
   template Doc exists in the target folder.
2. A Drive **folder shared with the org** (edit access for leaders) so generated
   docs inherit permissions and `/preview` works for signed-in viewers. **Done** —
   folder `1fZXRHWwKMD0FJFLWLUrw7r7kIWG_5sds` created. *Remaining: confirm its
   sharing is org-edit so leaders inherit access and `/preview` works (spike #2).*
3. **Official Google Drive pack — Copy Doc** action, copying the template into
   that folder and returning the URL. **Verified** via a canvas button.
4. On `EST Planning Events SRC` (`grid--gYIvdD-cE`):
   - **`Notes Doc`** — URL/text; the generated doc link.
   - **`Create notes doc`** — a **button column** whose action runs **Copy Doc**
     (template → target folder) and writes the returned URL into
     `thisRow.[Notes Doc]`. (The tested Copy Doc button, moved to a row button +
     write-back.)
5. **No separate automation rule and no trigger flag** — the app pushes this
   button via the proxy (see *Provisioning-trigger* below).

## App behavior (the actual code change)

The editor's Planning Notes section (`web/app.js` around the `f_notes` textarea,
line ~710; conversion in `planningRowToEvent`/`eventToCodaCells`, lines ~249,
~323) becomes a small **Notes panel** driven by the `Notes Doc` URL:

- **Doc present** → inline read-only `/preview` iframe **+ "Edit in Google Docs"**
  button (opens `…/edit` in a new tab). A fallback line ("Sign in to Google to
  preview, or open in Google Docs") covers the not-Google-authed viewer.
- **Doc absent** → a **"Create notes doc"** button. On click:
  1. Call the **proxy button-push route** (`POST /notes-doc` with the row id),
     role-gated exactly like other writes; the proxy pushes the row's Copy Doc
     button via the Coda API.
  2. Show a **loading indicator** ("Setting up your notes doc…").
  3. **Temporarily fast-poll** (~3s interval) for `Notes Doc` to populate, then
     swap to the preview. Resume the normal 60s poll afterward.
  4. **Timeout + retry**: if the URL hasn't landed after a bounded window (e.g.
     ~90s), stop fast-polling, show a "still working / retry" affordance rather
     than spinning forever.
- **Legacy notes:** if a row still has plain text in the old `Planning Notes`
  column, show it read-only beneath the panel; new events use the doc. The
  `NOTES_TEMPLATE` seeding of the textarea is retired (the template now lives in
  the template Google Doc).

### Data-layer seam

Per CLAUDE.md #4, the UI reads only normalized events. Add a normalized field
`notesDocUrl`, populated in `planningRowToEvent` from the `Notes Doc` cell
(**done** in the spike). Provisioning is **not** a cell write in
`eventToCodaCells` — it's a distinct action: the app calls the proxy's
`POST /notes-doc` (row id) to push the button. The UI must not learn the Coda
column/button names directly.

## Provisioning-trigger (chosen: push the row button via the Coda API)

**Chosen 2026-08-20:** the app calls a **small, role-gated proxy route** that
**pushes a row button** via the Coda API
(`POST /docs/{docId}/tables/{tableId}/rows/{rowId}/buttons/{columnId}`). The
button's action runs **Copy Doc** and writes the returned URL into
`thisRow.[Notes Doc]`. The push returns a request id; the app then fast-polls the
row until `Notes Doc` populates.

**Why this over the alternatives we considered:**

| | Flag cell + row-change automation | Webhook automation | **Push button via API (chosen)** |
|---|---|---|---|
| Worker change | none | new route **+ new webhook secret** | new route, **no new secret** (reuses the existing doc-scoped token) |
| Trigger latency | slowest (row-change cadence) | prompt | prompt |
| Row targeting | flag column on the row | `rowId` in payload + `ParseJSON` | **native** (push on that row) |
| Coda config | automation + flag column + clear step | webhook automation + payload parse | **just a row button** (≈ the tested Copy Doc button) + write-back |

The push-button route reuses the **same doc-scoped Coda token the proxy already
holds** (no new secret — honors CLAUDE.md #2), is natively row-scoped (no flag
column, no payload parsing), and needs the least Coda-side config. It does mean a
**small role-gated Worker addition** (the button-push route, gated like other
writes: Program Lead / Tribal Council).

**Note:** pushing the button (like any Coda button action) executes
asynchronously server-side — the API returns a request id, not the doc URL — so
the fast-poll for `Notes Doc` remains the mechanism that surfaces the result.

## Verification spikes (do these before building on the assumptions)

1. ~~**Document Generation Pack** vetting~~ — **DONE 2026-08-20.** Resolved by
   using the **official** Google Drive pack (Copy Doc), tested working. No
   third-party pack; no pricing/vetting concern. Remaining sub-item folded into
   spike #2: confirm the target folder's **sharing** (org-edit) so leaders
   inherit access and `/preview` works.
2. ~~**`/preview` embed + folder sharing**~~ — **DONE 2026-08-20.** Spiked in the
   app (additive Notes-doc panel in the editor). Confirmed: Google `/preview`
   embeds in our iframe with **no `X-Frame-Options` refusal**; a real doc from the
   target folder, shared to a non-owner viewer, **renders inline** in that
   viewer's authed browser; the not-Google-authed state degrades to Google's own
   frame + our "Edit in Google Docs" fallback. Spike code lives on
   `feat/planning-notes-google-docs` (`notesDocPanelHTML` etc. in `web/app.js`),
   additive — legacy notes textarea preserved.
3. ~~**Row button: Copy Doc + write-back, pushed via API**~~ — **DONE 2026-08-20.**
   Verified live: two planning rows carry real provisioned URLs
   (`https://docs.google.com/document/d/{id}/edit?usp=drivesdk`) in the `Notes Doc`
   column, so the button's action both copies the template **and writes the URL
   back**. The `/document/d/{id}/edit?usp=drivesdk` shape parses cleanly through
   `_gdocId`/`gdocPreviewUrl` → the `/preview` embed renders. (Final in-app
   Create-button click while signed in as a leader is the last confirmation.)
4. ~~**Proxy button-push route**~~ — **DONE 2026-08-20.** `POST /notes-doc` is
   deployed and role-gated: an unauthenticated push returns **403** (no
   `Authorization` header → `authIdentity` null → `!id`); the read path also
   works — `GET /rows` now injects `notesDocUrl` on every row.
   **Bug caught & fixed by this gate:** `columnName()` originally used Coda's
   single-column GET, which returned non-ok with the doc-scoped token, so
   `notesDocUrl` was never injected. Switched to the list-columns endpoint
   (`?limit=200`, find by stable id) — the same family the `/ref` reads use.

## Risks

- **Automation latency** worse than expected → mitigated by loading indicator +
  timeout/retry, and by the button-push escape hatch.
- ~~Third-party pack on the org's Drive~~ → resolved: using the **official**
  Google Drive pack (Copy Doc), tested working 2026-08-20. Remaining: confirm
  folder sharing (spike #2).
- **Viewer not Google-authed** → preview degrades to the edit-in-tab button (still
  functional).
- **Doc lifecycle** (row delete/duplicate → orphaned or shared docs) →
  out of scope for v1; note as a follow-up. Duplicating a row copies the URL,
  pointing two rows at one doc — acceptable for v1, flag in the plan.

## Success criteria

- A leader can, from inside the planning app, create a per-event Google Doc
  seeded with the checklist template, see a read-only preview inline, and click
  through to edit it in Google Docs.
- The Worker/proxy gains no Google API surface.
- The app reads only normalized events; no Coda column names leak into the UI.
- Event Description is unchanged.
