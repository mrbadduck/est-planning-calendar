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
(#3). This design honors #3 directly: **provisioning is a Coda automation**, and
the app stays a thin view layer that reads a URL cell like any other field. The
one departure is that Planning-Notes *content* now lives in Google Docs rather
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
| Notes doc **provisioning** | Coda automation + Document Generation Pack |
| Notes doc **template/checklist** | A template Google Doc (holds `NOTES_TEMPLATE`) |
| **Rendering** preview + edit link | The app (thin view layer) |
| Auth / role gating for the trigger write | Existing Worker proxy (unchanged surface) |

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
4. Two new columns on `EST Planning Events SRC` (`grid--gYIvdD-cE`):
   - **`Notes Doc`** — URL/text; the generated doc link.
   - **`Create Notes Doc`** — boolean trigger flag.
5. A **Coda automation**: *when `Create Notes Doc` becomes true AND `Notes Doc`
   is empty* → run the pack to generate the doc → write the URL into `Notes Doc`
   → clear `Create Notes Doc`.

## App behavior (the actual code change)

The editor's Planning Notes section (`web/app.js` around the `f_notes` textarea,
line ~710; conversion in `planningRowToEvent`/`eventToCodaCells`, lines ~249,
~323) becomes a small **Notes panel** driven by the `Notes Doc` URL:

- **Doc present** → inline read-only `/preview` iframe **+ "Edit in Google Docs"**
  button (opens `…/edit` in a new tab). A fallback line ("Sign in to Google to
  preview, or open in Google Docs") covers the not-Google-authed viewer.
- **Doc absent** → a **"Create notes doc"** button. On click:
  1. Write `Create Notes Doc = true` via the **existing proxy write path**
     (role-gated exactly like other writes).
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
(e.g. `notesDocUrl`) populated in `planningRowToEvent` from the `Notes Doc` cell,
and have `eventToCodaCells` write the `Create Notes Doc` flag. The UI must not
learn the Coda column names directly.

## Provisioning-trigger trade-off (chosen, with an escape hatch)

**Chosen:** trigger via a **flag cell + Coda automation** — keeps the Worker's
surface untouched. **Caveat:** the real latency floor is Coda's automation
cadence, not our poll rate, so the loading wait is bounded by Coda, not by us.
The fast-poll + loading indicator manage the *perceived* wait; they cannot beat
the automation's own latency.

**Escape hatch (only if the spike shows automation latency is unacceptable):**
trigger a Coda **button via the API** (`PushButton`) wired to the pack action,
which fires more promptly. This requires a **small, role-gated Worker addition**
(a button-push route) and is therefore a deliberate, separate decision — not
taken now.

## Verification spikes (do these before building on the assumptions)

1. ~~**Document Generation Pack** vetting~~ — **DONE 2026-08-20.** Resolved by
   using the **official** Google Drive pack (Copy Doc), tested working. No
   third-party pack; no pricing/vetting concern. Remaining sub-item folded into
   spike #2: confirm the target folder's **sharing** (org-edit) so leaders
   inherit access and `/preview` works.
2. **`/preview` embed + folder sharing**: confirm an org-shared (private) doc in
   the target folder renders in an iframe for a signed-in viewer, and confirm the
   degraded state when the viewer is not Google-authed.
3. **Copy Doc in an automation, on API write**: the canvas-button test proves the
   action works; confirm the same **Copy Doc action runs inside a Coda
   automation** triggered by an **API-driven** cell change (the proxy flag
   write), and **measure the automation latency** — this sets the loading-wait
   expectation and decides whether the button-push escape hatch is needed.
4. **Trigger write path**: confirm the app can write the `Create Notes Doc` flag
   through the existing role-gated proxy write path.

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
