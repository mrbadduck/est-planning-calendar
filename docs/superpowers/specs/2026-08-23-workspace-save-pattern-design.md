# Design — Workspace save-pattern redesign

**Date:** 2026-08-23 · **Branch:** `feat/eventbrite-publish` · **Area:** `web/app.js`, `web/styles.css`

Replaces the confusing global **Save/Cancel** footer in the multi-section event
workspace with a two-flow model: a one-shot **create** form, and an
**auto-saving** workspace for existing events. Supersedes handoff §A
(`docs/superpowers/specs/2026-08-22-workspace-savepattern-and-publish-handoff.md`).

## Problem

The workspace is a rail + section panel (Planning / Publish / coming-soon). A
single global **Save** in the footer is wrong here: a lead edits in one section,
switches to another, and it's unclear what a later Save persists. Current code
papers over it with capture-on-switch (`Object.assign(ev, readForm())`), but the
mental model is still "one big form with one Save" — which the section layout
contradicts. New events also open the full workspace immediately, inviting
half-filled rows.

## The two flows

### 1. Create (new event) — one-shot Planning modal

A brand-new event opens a **simple modal** (no rail): just the Planning form,
reusing `renderPlanning` / `wirePlanning`, with a clear **Cancel / Create**
footer. There is **no auto-save** — nothing exists to save into yet.

- **Create** runs the existing optimistic create path (`applyLocal` → `DB.create`
  → swap temp id → real id), then transitions straight into the workspace via
  `openEditor(savedEvent)`. The lead lands in the just-created event's workspace.
- **Cancel** closes; nothing persists. This is the whole point of splitting it
  out — no premature empty rows, and a clean answer to "when does a new row first
  persist" (on the deliberate Create).

Entry points repointed to the create form: `newEventOn(date)`,
`newIdeaInMonth(mkey)`, and the day-picker "+ New on this day".

### 2. Edit (existing event) — full workspace, auto-save

`openEditor(existing)` keeps the rail + sections. Changes:

- **Every editable field auto-saves on blur**, debounced (~800 ms), across
  **both** Planning and Publish. Public copy auto-saving to the Coda row is
  intentional — that is *not* the live Eventbrite listing.
- **Footer**: the global Save/Cancel is removed. Keep **Delete** (left) and a
  **save-status indicator** (right). Dismissal is via the top-right ✕, Esc, or
  scrim click (all already wired to `close()`).
- **Header**: unchanged — status select + Approve/Reopen + Copy link. **Approve
  stays a deliberate action** (`saveEditor(true)`).

## Components

### `openNewEventForm(seed)` (new)

Renders the create modal. Reuses `renderPlanning` for markup and `wirePlanning`
for field wiring (typeaheads, when-control, program chips). Footer = `Cancel`
(`close()`) + `Create` (`createFromForm()`). No rail; modal is *not* in `.ws`
workspace mode (so it's the compact modal, not the fixed-height workspace). The
notes-doc panel shows its "Save the event first…" empty state (already handled by
`notesDocPanelHTML` when `!ev.id`).

`createFromForm()` mirrors `saveEditor`'s new-event branch: read the form,
optimistic `applyLocal`, `DB.create`, swap temp→real id, `markRecent`, then
`openEditor(savedEvent)` to enter the workspace. On failure: revert + toast, keep
the create modal open so the lead doesn't lose their input.

### `autosaveEditor()` (new)

The in-place save for the workspace. Unlike `saveEditor`, it does **not**
`close()` the modal or tear down the editor — it saves the current `editing`
event and leaves the modal open.

- Guard: if a debounced save is pending or in flight, coalesce (see scheduler).
- `tokenExpMs()` dead → `sessionExpired()`, abort (don't lose the edit to a
  revert).
- `f = readForm()`; if `f` equals the last-saved snapshot (`_lastSavedSnap`),
  skip — no-op saves are wasteful. Equality via a normalized JSON compare of the
  fields `readForm` returns.
- Merge onto `editing`: `Object.assign(editing, f)` (+ `editedBy = me`).
- Optimistic: `applyLocal(editing)`, `markRecent(editing.id, {e: editing})`,
  rerender the **calendar behind** the modal (`rerender()` — the modal DOM is
  separate and stays open), update the save-status to `Saving…`.
- `await DB.update(editing)` → `Saved`, `_lastSavedSnap = f`, `scheduleReconcile()`.
- Catch: status `Save failed — retry`; on 401 `sessionExpired()`. Keep the edit
  in `editing` (do not revert the modal — the user is still looking at it).

### `scheduleAutosave()` + debounce (new)

A single debounced entry point (~800 ms). Called from:

- a `focusout` listener on `#wpanel` (text inputs + textareas — blur doesn't
  bubble, `focusout` does), and
- the existing mutation handlers that change state via click/change: program
  chips, when-segment + all-day, venue-type segment, address-visibility segment,
  and the typeahead add/remove (leads, volunteers, venue). Each calls
  `scheduleAutosave()` after mutating.

Debounce resets the timer on each call; fires `autosaveEditor()` when it settles.
`flushAutosave()` (await-able) cancels the timer and runs the save immediately —
used before an Eventbrite push so Coda has the latest copy.

### Save-status indicator (new)

A small element in the footer-right. A `setSaveStatus(state)` helper renders one
of: `Saved` (clean/idle), `Unsaved changes` (dirty, debounce pending),
`Saving…`, `Save failed — retry` (click retries `flushAutosave()`). Only shown in
the workspace (existing-event) mode, never in the create modal.

### Eventbrite dirty state

`wirePublishPanel` gains: Create-draft / Publish first `await flushAutosave()`
(so the Worker reads the freshest `Public description` / `Public summary` /
capacity / address from the Coda row), then push as today.

A session-local `editing._ebDirty` flag: set when any public-facing field
(publicSummary, publicDescription, capacity, addressVisibility, title, date,
start, end, venue) changes *after* a successful push; cleared on the next
successful push. When set and the event is linked, `publishPanelHTML` shows a
"Draft is behind your latest edits" hint and emphasizes **Update draft**.

**Limitation (accepted):** `_ebDirty` is session-local. On reload it resets to
clean, since detecting "Coda edited after last Eventbrite push" robustly would
need an `Edited at` timestamp column on the planning table (+ Worker write) to
compare against `Last published at`. Deferred as YAGNI; noted here so it isn't
mistaken for a bug.

## Data flow

```
Create:  entry point → openNewEventForm(seed) → [Create] → createFromForm()
         → DB.create → openEditor(savedEvent)              → workspace (auto-save)

Edit:    openEditor(existing) → workspace
         field blur / control change → scheduleAutosave() → (debounce)
         → autosaveEditor() → readForm → DB.update → setSaveStatus('Saved')

Publish: [Create draft|Publish] → flushAutosave() → DB.publishEventbrite
         → clear _ebDirty → repaint publish panel
```

## Error handling

- **Autosave failure**: status → `Save failed — retry`; the in-modal edit is kept
  (not reverted — the user is still editing). Retry re-runs `flushAutosave()`. 401
  → `sessionExpired()`.
- **Create failure**: revert optimistic insert, toast, keep the create modal open.
- **Dead token before save**: `sessionExpired()` before any optimistic mutation.
- **No-op saves**: skipped via snapshot compare, so blur-without-change is silent.

## What stays the same

- `readForm()` (already null-guards every field), `applyLocal`, `markRecent` /
  `_recent`, `scheduleReconcile`, `DB.*`, the reference/read-only and day-picker
  paths, Approve (`saveEditor(true)`), Reopen, Delete.
- The `.modal.ws` fixed-height workspace styling; the create modal uses the plain
  `.modal` (non-ws) compact styling.

## Testing / verification

- `node --check` on `web/app.js` after every edit (buildless invariant).
- Browser preview (`live-server web --port=8080`): verify the create→workspace
  transition, blur→`Saving…`→`Saved`, persistence across reload, Publish-copy
  auto-save, flush-before-publish, Approve, Delete. Authed writes need a signed-in
  lead (Eric) for the final confirmation; UI states + reads verify without auth.

## Non-goals

- Rich-text description (still plain text — pinned).
- Cross-reload Eventbrite-dirty detection (needs an `Edited at` column).
- Field-level (partial) PATCH — autosave PUTs the whole event, as today.
