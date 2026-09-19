# Lifecycle-Transforming Event Editor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Collapse the editor's parallel **Details** and **Publish** tabs into a single transforming **Details** surface — a stable "Event" section on top and a stage-aware "Public listing / Published listing" section below — so publishing reads as an action, not a destination.

**Architecture:** Pure front-end/presentational refactor of `web/app.js` + `web/styles.css`. The Coda planning row stays the single editable truth; Eventbrite remains a downstream mirror synced via the existing `_ebDirty` drift mechanic (already covers Title/When/Where — no data-layer change). The old `renderPublish` body is wrapped into a new `renderListingSection` and rendered beneath `renderPlanning` inside the `details` section; the `publish` rail entry is removed with a deep-link back-compat mapping.

**Tech Stack:** Buildless vanilla JS (no bundler, no DOM test harness — per the project's non-negotiable buildless constraint). Verification is `node --check web/app.js` after every JS edit (the documented sanity check) plus a live browser pass with `live-server`. Introducing a jsdom/jest harness is out of scope — it would violate the buildless decision for a presentational change.

---

## Context for the implementer

Read these before starting:

- Spec: `docs/superpowers/specs/2026-09-19-lifecycle-transforming-editor-design.md`
- `CLAUDE.md` → "How the app (`web/index.html`) is built" (the editor section-model and save pattern).

**Current structure in `web/app.js` (line numbers approximate — grep to confirm):**

- `SECTIONS` registry (~L656): array of `{id,label,live}`. `details`, `notes`, `volunteers`, `publish`, `attendees`, then coming-soon.
- `sectionId` back-compat map (~L668): `{planning:'details', attendance:'attendees'}`.
- `renderSection(id, ev, canEdit, locked, canApprove)` (~L1115): routes each section id to its renderer. `publish` → `renderPublish`+`wirePublish`; the default (`details`) → `renderPlanning`+`wirePlanning`.
- `renderPlanning` / `wirePlanning` (~L1129 / L1165): the top-of-funnel draft fields (Title, Internal description, Program(s), Leads, When, Where). **No Volunteers field is rendered here** (already removed from UI); **no attribution field is rendered** (already out).
- `renderPublish` / `wirePublish` (~L1245 / L1256): bottom-of-funnel. Returns a locknote when `ev.status!=='approved'`, otherwise `publishFieldsHTML` (public summary/description/capacity/address) + `publishPanelHTML` (the Eventbrite draft/publish/live-sync panel). `wirePublish` wires copy-internal, address toggle, and `wirePublishPanel`.
- `publishFieldsHTML` (~L1230), `publishPanelHTML` (~L764), `loadEbLive`/`seedLiveFields`/`wirePublishPanel` (~L818-861): the live-listing reflection + dirty-gated push. **Do not modify these** — they are reused verbatim.
- `readForm` (~L1668): reads every field with `editing.<field>` fallback when the element is absent. Contains a dead `f_vols` read (~L1680) — the only Volunteers remnant.
- `EB_PUBLIC_KEYS` (~L1764): `['publicSummary','publicDescription','capacity','addressVisibility','title','date','start','end','venue']` — already the full drift set. No change needed.

**Styling context in `web/styles.css`:**

- `.wpanel` (~L498): `flex;flex-direction:column;gap:12px;overflow-y:auto` — the scrolling section panel. Direct-child width rules at ~L499 (`.wpanel > .fld.full,.wpanel > .fld{width:100%}`).
- `.fieldgroup-h` (~L329): the uppercase muted small-caps heading style to echo for subsection headers.
- `.locknote` (~L371): muted info box, reused for the pre-approval "available once approved" state.

## File structure

- **Modify `web/app.js`** — add `renderDetails`, `wireDetails`, `renderListingSection`; repoint the `details` route; remove the `publish` route and `SECTIONS` entry; add `publish:'details'` back-compat; delete the dead `f_vols` read.
- **Modify `web/styles.css`** — add `.wsub` / `.wsub-h` / `.wsub.muted` subsection styles.
- **Modify `CLAUDE.md`** — update the editor description to reflect the merged section (Publish is no longer a tab).

No files are created. No proxy/data-layer files change.

---

## Task 1: Subsection styles

**Files:**
- Modify: `web/styles.css` (after the `.wpanel` rules, ~L499)

- [ ] **Step 1: Add the subsection CSS**

Insert immediately after the `.wpanel > .fld.full,.wpanel > .fld{width:100%}` line (~L499):

```css
  /* Details tab = two stacked subsections: "Event" (always) + the stage-aware
     public/published listing. Each behaves like the panel's own child context. */
  .wsub{display:flex;flex-direction:column;gap:12px}
  .wsub > .fld.full,.wsub > .fld{width:100%}
  .wsub-h{font-size:11px;font-weight:600;letter-spacing:.05em;text-transform:uppercase;color:var(--muted);border-bottom:.5px solid var(--hair);padding-bottom:6px;margin-bottom:2px}
  .wsub.muted{opacity:.55}
```

- [ ] **Step 2: Sanity-check CSS is well-formed (no syntax breakage in the file)**

Run: `node --check web/app.js`
Expected: no output beyond the command succeeding (this checks JS; the CSS edit can't break JS, but run it now so the baseline stays green before Task 2). CSS has no linter in this repo; a visual check happens in Task 5.

- [ ] **Step 3: Commit**

```bash
git add web/styles.css
git commit -m "style(web): subsection styles for the two-part Details tab

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 2: Merged Details renderer (Event + stage-aware listing)

This is the core change. `renderPublish` is replaced by `renderListingSection` (same body, wrapped with a stage-tracked heading and a muted pre-approval state), and a new `renderDetails`/`wireDetails` composes the Event subsection on top of it. The `details` route is repointed to them. The `publish` route is left in place for now (removed in Task 3) so nothing breaks mid-refactor.

**Files:**
- Modify: `web/app.js` — replace `renderPublish` (~L1245-1255) and `wirePublish` (~L1256-1262); add `renderDetails`/`wireDetails`; repoint the `details` line in `renderSection` (~L1123).

- [ ] **Step 1: Replace `renderPublish` with `renderListingSection`**

Find (~L1245-1255):

```javascript
function renderPublish(ev, canEdit, locked){
  if(ev.status!=='approved') return `<div class="fld full"><div class="locknote">Approve this event under Planning to publish it to Eventbrite.</div></div>`;
  const dis=(!canEdit||locked)?'disabled':'';
  const staged={summary:ev.publicSummary||'', description:ev.publicDescription||'', capacity:ev.capacity, addressVisibility:ev.addressVisibility};
  if(!ev.eventbriteId)
    return `${publishFieldsHTML(staged, dis, false)}${publishPanelHTML(ev, canEdit && !locked)}`;
  // linked: live card first; fields wait for the live values (staged shown
  // dimmed meanwhile) unless the viewer can't edit at all.
  return `${publishPanelHTML(ev, canEdit && !locked)}
    ${publishFieldsHTML(staged, dis, dis==='')}`;
}
```

Replace with:

```javascript
// Bottom subsection of the Details tab. Heading tracks the stage: "Public
// listing" while staging, "Published listing" once the event is live on
// Eventbrite. Muted-but-visible before approval so the flow stays teachable.
function listingHeading(ev){
  return (ev.eventbriteId && ev.publishStatus==='Published') ? 'Published listing' : 'Public listing';
}
function renderListingSection(ev, canEdit, locked){
  const h=`<div class="wsub-h">${listingHeading(ev)}</div>`;
  if(ev.status!=='approved')
    return `<div class="wsub muted">${h}<div class="locknote">Available once approved — public summary, description, capacity, and the Eventbrite publish action live here. Approve the event below to unlock it.</div></div>`;
  const dis=(!canEdit||locked)?'disabled':'';
  const staged={summary:ev.publicSummary||'', description:ev.publicDescription||'', capacity:ev.capacity, addressVisibility:ev.addressVisibility};
  const body = !ev.eventbriteId
    ? `${publishFieldsHTML(staged, dis, false)}${publishPanelHTML(ev, canEdit && !locked)}`
    // linked: live card first; fields wait for the live values (staged shown
    // dimmed meanwhile) unless the viewer can't edit at all.
    : `${publishPanelHTML(ev, canEdit && !locked)}${publishFieldsHTML(staged, dis, dis==='')}`;
  return `<div class="wsub">${h}${body}</div>`;
}
```

- [ ] **Step 2: Rename the wiring hook and add the composed Details wiring**

Find (~L1256-1262):

```javascript
function wirePublish(panel, ev, canEdit, locked){
  const ci=panel.querySelector('[data-act="copy-internal"]');
  if(ci) ci.addEventListener('click', ()=>{ const t=panel.querySelector('#f_pubdesc'); if(t){ t.value=(editing&&editing.description)||''; t.dispatchEvent(new Event('input',{bubbles:true})); scheduleAutosave(); } });
  const av=panel.querySelector('#f_addrvis');
  if(av && canEdit && !locked) av.addEventListener('click', e=>{ const b=e.target.closest('button[data-addrvis]'); if(!b) return; [...b.parentElement.children].forEach(x=>x.setAttribute('aria-pressed', x===b)); scheduleAutosave(); });
  wirePublishPanel(panel.querySelector('#f_publish'));
}
```

Replace with (renamed to `wireListingSection`, guarded so it only wires when the approved fields exist):

```javascript
function wireListingSection(panel, ev, canEdit, locked){
  if(ev.status!=='approved') return;                 // muted state has no controls
  const ci=panel.querySelector('[data-act="copy-internal"]');
  if(ci) ci.addEventListener('click', ()=>{ const t=panel.querySelector('#f_pubdesc'); if(t){ t.value=(editing&&editing.description)||''; t.dispatchEvent(new Event('input',{bubbles:true})); scheduleAutosave(); } });
  const av=panel.querySelector('#f_addrvis');
  if(av && canEdit && !locked) av.addEventListener('click', e=>{ const b=e.target.closest('button[data-addrvis]'); if(!b) return; [...b.parentElement.children].forEach(x=>x.setAttribute('aria-pressed', x===b)); scheduleAutosave(); });
  wirePublishPanel(panel.querySelector('#f_publish'));
}

// The Details tab: stable "Event" subsection (draft/internal fields) on top,
// stage-aware listing subsection below. One surface that transforms by stage.
function renderDetails(ev, canEdit, locked, canApprove){
  return `<div class="wsub"><div class="wsub-h">Event</div>${renderPlanning(ev, canEdit, locked, canApprove)}</div>${renderListingSection(ev, canEdit, locked)}`;
}
function wireDetails(panel, ev, canEdit, locked, canApprove){
  wirePlanning(panel, ev, canEdit, locked, canApprove);
  wireListingSection(panel, ev, canEdit, locked);
}
```

- [ ] **Step 3: Repoint the `details` route in `renderSection`**

Find the last line of `renderSection` (~L1123):

```javascript
  panel.innerHTML=renderPlanning(ev, canEdit, locked, canApprove); wirePlanning(panel, ev, canEdit, locked, canApprove);
```

Replace with:

```javascript
  panel.innerHTML=renderDetails(ev, canEdit, locked, canApprove); wireDetails(panel, ev, canEdit, locked, canApprove);
```

- [ ] **Step 4: Verify JS still parses**

Run: `node --check web/app.js`
Expected: command succeeds with no output. (If it reports an error, a bracket/paren is unbalanced in the replaced block — re-check Step 1/2.)

- [ ] **Step 5: Commit**

```bash
git add web/app.js
git commit -m "feat(web): merge Publish into a transforming Details tab

Event subsection (draft/internal) on top; stage-aware Public/Published
listing subsection below (muted-but-visible before approval). Reuses the
existing publish fields + Eventbrite sync panel verbatim.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 3: Remove the standalone Publish tab

Now that `details` renders the listing, drop the `publish` rail entry, its `renderSection` route, and add the deep-link back-compat so old `?section=publish` links resolve to `details`.

**Files:**
- Modify: `web/app.js` — `SECTIONS` (~L656), `sectionId` (~L668), `renderSection` publish branch (~L1119).

- [ ] **Step 1: Remove the `publish` entry from `SECTIONS`**

Find (~L657-661):

```javascript
  { id:'details',   label:'Details',              live:true },
  { id:'notes',     label:'Planning Notes',       live:true },
  { id:'volunteers',label:'Potluck & Volunteers', live:true },
  { id:'publish',   label:'Publish',              live:true },
  { id:'attendees', label:'Attendees',            live:true },
```

Replace with (drop the `publish` line):

```javascript
  { id:'details',   label:'Details',              live:true },
  { id:'notes',     label:'Planning Notes',       live:true },
  { id:'volunteers',label:'Potluck & Volunteers', live:true },
  { id:'attendees', label:'Attendees',            live:true },
```

- [ ] **Step 2: Add the `publish → details` deep-link back-compat**

Find (~L668):

```javascript
const sectionId = id => ({ planning:'details', attendance:'attendees' }[id] || id);
```

Replace with:

```javascript
// Back-compat: Details was formerly 'planning'; Attendees was the 'attendance'
// stub; the Publish tab folded into Details (2026-09) → 'publish' opens Details.
const sectionId = id => ({ planning:'details', attendance:'attendees', publish:'details' }[id] || id);
```

- [ ] **Step 3: Remove the `publish` route from `renderSection`**

Find (~L1119):

```javascript
  if(id==='publish'){ panel.innerHTML=renderPublish(ev, canEdit, locked); wirePublish(panel, ev, canEdit, locked); return; }
```

Delete this entire line.

- [ ] **Step 4: Verify no lingering references to the removed functions**

Run: `grep -n "renderPublish\|wirePublish\b\|'publish'\|id==='publish'" web/app.js`
Expected: **no matches** for `renderPublish`, `wirePublish` (the function is now `wireListingSection`), or `id==='publish'`. A match for `publish:'details'` in `sectionId` is fine and expected; if grep shows it, that's the back-compat map, not a leftover route. (`publish-eb-draft`/`publish-eb-publish` data-act strings inside `publishPanelHTML` are unrelated and must remain.)

- [ ] **Step 5: Verify JS parses**

Run: `node --check web/app.js`
Expected: command succeeds with no output.

- [ ] **Step 6: Commit**

```bash
git add web/app.js
git commit -m "feat(web): remove standalone Publish tab (folded into Details)

Drops the SECTIONS entry and renderSection route; old ?section=publish
deep-links now resolve to Details.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 4: Cleanup — dead Volunteers read

The Volunteers field and attribution are already absent from the rendered editor. The only remnant is a dead `f_vols` read in `readForm` that always falls through to `editing.volunteers` (there is no `#f_vols` element). Removing it is a safe simplification and does **not** change what gets written: `readForm` still returns `volunteers` from `editing.volunteers`, and `eventToCodaCells` still round-trips the existing value.

**Files:**
- Modify: `web/app.js` — `readForm` (~L1680).

- [ ] **Step 1: Simplify the Volunteers read**

Find (~L1680):

```javascript
  const volunteers=g('f_vols') ? chipIds('#f_vols .ta-chip') : ((editing&&editing.volunteers)||[]);
```

Replace with:

```javascript
  const volunteers=(editing&&editing.volunteers)||[];   // no editor field — slots/claims supersede it; value round-trips untouched
```

- [ ] **Step 2: Verify JS parses**

Run: `node --check web/app.js`
Expected: command succeeds with no output.

- [ ] **Step 3: Commit**

```bash
git add web/app.js
git commit -m "refactor(web): drop dead Volunteers-field read in readForm

The editor no longer renders a Volunteers picker (slots/claims replace
it); the stored relation still round-trips via editing.volunteers.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 5: Live browser verification across lifecycle stages

No DOM test harness exists, so verify the transform manually in the browser. This is the real correctness gate for a presentational change.

**Files:** none (verification only).

- [ ] **Step 1: Start the dev server**

Run: `npx -y live-server web --port=8080 --no-browser`
(Or use the browser-preview tooling to open `http://localhost:8080`.)
Expected: server starts; the calendar loads against live data. Sign in as a Program Lead / Council member (local sign-in needs `localhost` in Firebase authorized domains — see `docs/deployment.md`; if unavailable, verify the read-only rendering and note the auth-gated actions were not exercised).

- [ ] **Step 2: Verify the rail no longer shows Publish**

Open any event's editor.
Expected: the rail shows **Details, Planning Notes, Potluck & Volunteers, Attendees** (+ Coming soon group). **No "Publish" item.**

- [ ] **Step 3: Verify a DRAFT event's Details tab**

Open a Draft event.
Expected: top **"Event"** subsection with Title, Internal description, Program(s), Leads, When, Where — all editable. Below it, a **muted "Public listing"** subsection with the "Available once approved" note and no controls.

- [ ] **Step 4: Verify an APPROVED, not-yet-published event**

Open (or Approve, via the footer, an event you can) an Approved event with no Eventbrite link.
Expected: heading reads **"Public listing"**; the public summary/description/capacity/address fields render editable; the **"Create Eventbrite draft"** action shows in the panel. Footer still shows lifecycle transitions (Cancel; Council also Delete).

- [ ] **Step 5: Verify a PUBLISHED (live) event**

Open an event already published to Eventbrite (`publishStatus==='Published'`).
Expected: heading reads **"Published listing"**; the live-listing reflection card loads on top ("Live Eventbrite listing…"); public fields seed from live; editing a public field OR the Title/When/Where reveals the dirty-gated **"Update published event"** push button. The Eventbrite link opens the listing.

- [ ] **Step 6: Verify deep-link back-compat**

Navigate to `http://localhost:8080/?event=<a real rowId>&section=publish`.
Expected: the editor opens on the **Details** tab (not an error, not a blank panel), scrolled/rendered with both subsections.

- [ ] **Step 7: Verify autosave + drift still work**

On an existing event, edit the Title, blur, and watch the save-status pill go Saving… → Saved. On a published event, confirm the "Update published event" button appears after the edit (drift flagged).
Expected: autosave persists; drift button appears only post-publish.

- [ ] **Step 8: Check the console for errors**

Expected: no uncaught exceptions in the browser console during Steps 2-7.

- [ ] **Step 9: Stop the dev server.** No commit (verification only). If any step fails, return to the relevant task, fix, re-run `node --check web/app.js`, and re-verify.

---

## Task 6: Update project docs

**Files:**
- Modify: `CLAUDE.md` — the editor bullet under "How the app (`web/index.html`) is built".

- [ ] **Step 1: Update the editor description**

Find the passage describing the editor sections (the bullet beginning "**Editor = a section-model workspace**"). Update the live-sections list and the Publish description to reflect the merge. Replace the phrase listing live sections — currently:

```
live sections **Details**, **Planning Notes**, **Potluck & Volunteers**, **Publish**
(`renderPublish`/`wirePublish`, gated on approved) and **Attendees**
```

with:

```
live sections **Details** (a transforming surface — a stable **Event**
subsection of draft/internal fields on top, and a stage-aware
**Public listing → Published listing** subsection below via
`renderListingSection`/`wireListingSection`, muted-but-visible until approved,
that holds the public fields + Eventbrite publish action — the old standalone
Publish tab folded in here 2026-09), **Planning Notes**, **Potluck & Volunteers**
and **Attendees**
```

- [ ] **Step 2: Commit**

```bash
git add CLAUDE.md
git commit -m "docs: describe the merged transforming Details tab

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Done criteria

- Editor rail shows no Publish tab; Details renders Event + stage-aware listing subsections.
- Heading reads "Public listing" pre-publish, "Published listing" once live.
- Pre-approval bottom section is muted-but-visible; approved shows publish action; published shows live reflection + dirty-gated update.
- `?section=publish` deep-links resolve to Details.
- Autosave and Eventbrite drift/push behavior unchanged and working.
- `node --check web/app.js` clean; no console errors in the browser pass.
- `CLAUDE.md` updated.
