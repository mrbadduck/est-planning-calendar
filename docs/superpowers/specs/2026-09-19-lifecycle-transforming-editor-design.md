# Lifecycle-transforming event editor — design

**Date:** 2026-09-19
**Status:** Design approved, pending spec review → implementation plan
**Area:** `web/app.js` (event editor / `SECTIONS`, `renderSection`,
`renderPlanning`, `renderPublish`), `web/styles.css`

## Problem

The editor's rail presents **parallel tabs**, but some of those "tabs" are really
**lifecycle stages** wearing the costume of parallel sections:

- **Details** is effectively a *draft* editor — direct edit of the pre-publish
  planning record.
- **Publish**, pre-publish, is the *workflow* to push the draft into Eventbrite.
- **Publish**, post-publish, becomes a half-baked surface for editing the live
  listing details that are supposed to *supersede* the draft.

Yet **Details** stays the permanent "home screen" even after an event is live,
which is confusing: the published event — the thing that now actually matters —
is buried one tab over, while the draft it superseded remains the front door.

The mental model we want: **publishing is an action, not a place.** The event has
one home that **transforms** as it moves through its lifecycle — from "the thing
I'm planning" to "the thing that's live" — so the stage is self-evident from what
the surface shows, not encoded in a status badge alone.

## Model (decided)

**One transforming home surface**, not a set of tabs reordered by stage. A single
**Details** tab whose lower half changes with lifecycle stage. Chosen over
"discrete tabs with shifting emphasis" because a surface that literally *looks
different* per stage is more intuitive than making the user map tabs to stages.

### Field ownership (the reason a single surface works)

Normalized event fields split into three buckets:

| Bucket | Fields | Lifecycle behavior |
|--------|--------|--------------------|
| **Shared core** | Title, Program(s), When (scheduling/date/time/all-day/window/month), Where (venue type/venue/other) | Editable at every stage. When + Where also map to Eventbrite. Never hidden. |
| **Internal-only** | Internal (event) description, Leads | Editable forever; never sent to Eventbrite. |
| **Public listing** | Public summary, Public description, Capacity, Address visibility (ticketing/banner later) | Eventbrite-mapped. Staged pre-publish, mirrored post-publish. |

Key insight: **Title, When, and Where are shared** — they live on the draft *and*
become the core of the Eventbrite listing. They are exactly the fields that must
feel *continuous* across the transform, not "replaced." That's why the surface
can't literally "become the Eventbrite listing" — the shared core and the
internal-only fields persist through publish.

### Source-of-truth stance (decided: Model Y)

Post-publish, when/where and public fields **hand off to the listing as a *sync
relationship*, not by hiding the editors**:

- The **Coda planning row stays the single editable truth**; Eventbrite is a
  downstream mirror (consistent with the project's architecture decisions #1/#3).
- Draft fields remain editable and autosave to Coda as today.
- Editing any **Eventbrite-mapped field** (When, Where, public summary/
  description, capacity, address visibility) after publish marks the live listing
  **out of sync**.
- An explicit **Publish updates** action pushes the divergence to Eventbrite; the
  read-only reflection then catches up.

Rejected **Model X** (edit the live listing directly): it creates a *second*
editable surface, forces reconciling two truths (Coda still needs the values for
aggregation/observability and other automations read from it), and makes
consequential changes — e.g. moving a date after people register — feel as casual
as fixing a typo. Model Y also *generalizes the mechanic already in the app*
(`_ebDirty` + push-on-demand), rather than inventing a new one.

## Design

### 1. Tab structure

Editor rail:

- **Details** — the transforming surface (absorbs the old Publish tab)
- **Planning Notes** — unchanged, own tab
- **Potluck & Volunteers** — slots, unchanged
- **Attendees** — unchanged
- *Coming soon: Budget, Comms, Feedback — unchanged*

The standalone **Publish tab is removed.** There is no place called "Publish";
there is a publish *action* that lives with the public-listing fields.

### 2. The Details surface — two stacked sections

**Top — "Event" (shared core + internal, always editable, all stages):**
Title, Program(s), Leads, Internal description, When, Where. Never hidden, never
handed off.

**Bottom — public listing & publish (transforms by stage):**

- **Before approval:** rendered **muted-but-visible** — an inert
  "Available once approved" state. The structure is always present so the flow is
  teachable, but no action is possible yet.
- **Approved, not yet published:** public-listing staging fields (public summary,
  public description, capacity, address visibility) + the **Create draft /
  Publish** action.
- **Published (live):** a read-only **live-listing reflection card** (with the
  Eventbrite link) on top; the editable public fields; a **sync/drift
  indicator**; and the **Publish updates** action shown when the draft has
  diverged. Includes unpublish/cancel handling as today.

**Section heading tracks the stage:** "Public listing" while staging (pre-
publish) → **"Published listing"** once live. Same section, label matches reality.

### 3. Actions & lifecycle placement

- **Lifecycle transitions stay in the footer** (Propose / Approve / Cancel /
  Reopen / Delete), gated by role/state exactly as today. Pure state changes with
  no attached form.
- **Publish / Publish updates is an action inside the bottom section**, adjacent
  to the fields it acts on — not the footer. This is the "publish is an action"
  resolution: a button contextual to the listing data, not a destination.

### 4. Sync / drift behavior (the handoff)

Generalize the existing `_ebDirty` mechanic from *only* the public-listing fields
to **all Eventbrite-mapped fields** — i.e. add the shared core's **When** and
**Where** to the set that marks the listing dirty.

- Draft fields (top + bottom) remain the editable truth; autosave to Coda
  unchanged.
- Post-publish, editing any Eventbrite-mapped field marks the listing **out of
  sync**. The reflection card shows the live values; a banner in the bottom
  section reads *"Live listing is behind your latest edits"* with the **Publish
  updates** button.
- Publishing pushes to Eventbrite; the read-only reflection catches up.

### 5. Removals / cleanup

- **Remove the Volunteers relation field** from the editor — the slots/claims
  system ("Potluck & Volunteers" tab) supersedes it. The Coda `Volunteers` column
  may remain; the form simply stops surfacing and writing it. (Verify no other
  reader depends on the form writing it before removing the write.)
- **Attribution** (Created by / Edited by) — confirm it is already out of the UI;
  remove any remnant. (Attribution injection on write, server-side, is untouched.)
- **Delete the standalone Publish section/tab**: `renderPublish` / `wirePublish`
  fold into the Details renderer's bottom section; remove `publish` from
  `SECTIONS`. Preserve the back-compat deep-link map so an old
  `?section=publish` link resolves to `details`.

## Non-goals

- No change to the data layer / proxy routes, the status state machine's
  transitions, or role gating.
- No change to Planning Notes, Slots, or Attendees.
- Ticketing/banner remain out of the app form (Coda/Eventbrite only) for now.
- No change to how attribution is injected server-side on write.

## Open items for the plan

- Exact autosave wiring so When/Where edits set the dirty flag only when the
  event is published (pre-publish edits must not spuriously flag drift).
- Deep-link back-compat: `?section=publish` → `details` (and land on / scroll to
  the bottom section).
- Confirming the Volunteers-field removal has no downstream reader.
- Styling for: muted-but-visible inert state, the reflection card, and the
  drift banner (reuse existing `locknote` / status-pill patterns where possible).
