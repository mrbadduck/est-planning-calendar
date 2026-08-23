# Design — Event workspace (section model) + Publish section

**Date:** 2026-08-22
**Status:** Design approved in brainstorming (2026-08-22). Branch: `feat/eventbrite-publish` (continues).
**Scope:** Restructure the event editor modal into a **section-model workspace** (left rail + section panel), split **internal vs public description**, add a **Publish** section housing the Eventbrite fields, add **URL deep-linking** (`?event&section`), and show a **"Coming soon…"** roadmap of future sections. Rich-text description is pinned for later; two Structured-Content bug fixes are folded in.

---

## 1. Context & goal

The event editor is becoming the surface for the whole event lifecycle, not just planning. Today it's a flat modal form; publish-specific fields (added this session) are mixed in with planning fields, and the "description" is mislabeled "public promo" when it's really internal copy. Eric's roadmap — budget/expenses, comms with registrants, volunteer/potluck coordination, attendance, feedback — confirms the editor needs to hold **many self-contained facets** without overwhelming a program lead.

**Goal:** adopt a **section model** (each facet = an isolated panel in a registry) so future facets are "add a section," not a redesign; ship it with **Planning** + **Publish** populated, a visible **Coming soon** roadmap, and shareable **deep links**.

## 2. Decisions settled in brainstorming (don't relitigate)

1. **Section model.** The editor renders a **registry** of sections `{ id, label, icon, gate, render, wire }`. Each section owns its fields/data and its readiness gate. Chrome = a **left rail** in the modal.
2. **Stays a modal** (no full-page graduation now). Two live sections fit fine; the model makes a future shell swap cheap if ever needed.
3. **Live sections now: Planning, Publish.** Everything else is **Coming soon** (visible, disabled, teaser).
4. **Internal ≠ public description.** Planning holds the **internal** description (reframed from today's mislabeled field); Publish holds the **public** listing copy + summary. The Worker sends the *public* copy to Eventbrite, never the internal one.
5. **URL deep-linking.** `?event=<rowId>&section=<sectionId>`, two-way synced — opening a link deep-links to that event + section; navigating updates the URL; leads share links directly.
6. **Coming-soon rail doubles as a feedback engine.** Disabled future sections are shown under a "Coming soon…" header; clicking shows a teaser + a lightweight feedback prompt.
7. **Rich-text description pinned for later.** Public description is a plain textarea for now (Eventbrite wants a narrow HTML allowlist; a markdown→allowlisted-HTML editor slots into the Publish section later — see `2026-08-22-eventbrite-publish-design.md` research notes).
8. **Two Structured-Content bug fixes** ship here: text modules need a required `alignment` (`"left"`); a brand-new description writes **version 0** (not 1).

## 3. The section model

A single source of truth in `web/app.js`:

```
SECTIONS = [
  { id:'planning', label:'Planning', icon:'clipboard-list', live:true,  render, wire },
  { id:'publish',  label:'Publish',  icon:'external-link',   live:true,  gate:'approved', render, wire },
  { id:'budget',    label:'Budget & expenses',   icon:'receipt',       live:false },
  { id:'comms',     label:'Comms',               icon:'speakerphone',  live:false },
  { id:'volunteers',label:'Volunteers & potluck',icon:'users-group',   live:false },
  { id:'attendance',label:'Attendance',          icon:'checkbox',      live:false },
  { id:'feedback',  label:'Feedback',            icon:'message-heart', live:false },
]
```

- The editor modal renders a **left rail** listing live sections, then a **"Coming soon…"** header and the `live:false` items (muted, non-selectable → teaser).
- The **panel** on the right renders the active section's `render(ev)` and runs its `wire(ev)` for event handlers (same "innerHTML then attach handlers by id" pattern the editor already uses).
- **Gate:** a section may be gated (e.g. Publish requires `ev.status==='approved'`); a gated-unavailable section still shows but its panel explains the gate ("Approve this event to publish").
- Reference (read-only) events and unsaved new events show only what's relevant (Planning; Publish appears once saved + approved).

**Isolation:** each section's `render`/`wire` is self-contained and reads/writes only the normalized `ev` + `readForm()`-style collectors — no section reaches into another. Adding Budget later = append one registry entry + its render/wire.

## 4. Fields by section

**Planning** (core; mostly today's form):
- Title, Program(s), Leads, When (date/time), Where (venue cascade + venue-other), Volunteers, **Internal description** (reframed label + hint "internal planning copy — not shown publicly"), Planning notes doc, Status control + Approve/Reopen.

**Publish** (gate: approved):
- **Public summary** — plain text, ≤140 (Eventbrite `event.summary`).
- **Public description** — plain textarea for now (rich-text later); the Eventbrite listing body. Starts blank with a **"Copy from internal description"** helper (since the copy genuinely differs); if left blank at publish time, the Worker falls back to the internal description so a publish never ships an empty body.
- **Capacity**, **Ticket** (free v1), **Address on listing** (public / registrants-only) — moved here from Planning.
- **Publish actions**: Create draft → Publish → Open in Eventbrite ↗ + status badge (the panel built this session, relocated).

**Coming soon** (Budget & expenses, Comms, Volunteers & potluck, Attendance, Feedback): no fields; a teaser panel — one line describing the facet + a **"What would you want here?"** feedback affordance (v1: a `mailto:`/note or a simple prompt; see §8).

## 5. Data model (Coda) changes

Add to `EST Planning Events SRC` (`grid--gYIvdD-cE`):
- **`Public summary`** — text (≤140; app-enforced).
- **`Public description`** — text (listing body; plain for now).

Reframe (no schema change): the existing **`Event Description`** is the *internal* description — relabel in the app only. `planningRowToEvent` maps `Public summary`/`Public description` → `ev.publicSummary`/`ev.publicDescription`; `eventToCodaCells` writes them.

Worker `POST /publish/eventbrite`:
- `event.summary` ← `ev.publicSummary` (≤140), else stripped-first-140 of the public/internal description.
- Structured Content body ← `ev.publicDescription`, falling back to `ev.description` (internal) if blank.

## 6. URL deep-linking

- **State → URL:** when the editor opens for an event, set `?event=<rowId>` (+ `&section=<id>`) via `history.replaceState` (no reload). Switching sections updates `section`. Closing the editor clears both params. Use `replaceState` for section switches (no history spam), `pushState` on open/close so Back closes the editor.
- **URL → state:** on load (after events load) and on `popstate`, parse `event`/`section`; if the row is in `state.events`, open its editor to that section; if not found (bad id / no access / not yet loaded), ignore silently (and once events finish loading, retry once).
- **Share:** a small "Copy link" affordance in the editor header copies the current `?event&section` URL. Recipients open the app → auto-open (subject to sign-in/permissions — reads are public, so the event opens read-only for non-leads).
- Param names: `event` (Coda rowId, e.g. `i-JndSN9Ji7U`) and `section` (section id). rowIds are URL-safe.

## 7. Editor chrome (modal)

- Modal gains a **left rail** (~180px): live sections, then a muted **"Coming soon…"** group. Active section highlighted.
- The section **panel** fills the rest, scrolls independently if long.
- Header keeps the title stripe + ✕ close; add a **Copy link** icon.
- Mobile (<600px): the rail collapses to a top **section chip row** (horizontal scroll) above the panel — same section model, compact chrome. (Two live sections keep this trivial now.)

## 8. Feedback / Ideas board (a real, votable board — baked into the roadmap)

A lightweight ideas board wired into the workspace. Two entry points, one shared board, upvoting to surface priorities.

**Entry points**
- **Global "Feedback / Ideas" CTA in the page header** — submit a general idea/suggestion (context = `General`) and browse all ideas.
- **Per coming-soon section** — each `live:false` section panel shows a **context-aware** mini-form whose submissions are tagged with that section's id (e.g. `budget`), and **below the form, the list of ideas already submitted for that context**, each with a **+1** affordance. So a lead opening "Budget & expenses" sees "here's what's coming, tell us what you'd want, and +1 what others already asked for."

**Voting**
- Each idea shows a vote count + a **+1** button that **toggles** the current person's vote (no double-voting). Lists sort by votes desc, then recency.
- The signed-in person's own vote state is reflected (`votedByMe`), so the button reads as pressed/unpressed.
- Submitting and voting require a **matched, signed-in identity** (a known `EST People SRC` person) — low friction (any signed-in lead), attributed, spam-resistant. Reads (browsing ideas) are open like `/rows`.

**Coda `Roadmap Feedback` table** (new):
| Column | Type |
|---|---|
| Idea | text (the suggestion) |
| Context | SelectList (`General`, `planning`, `publish`, `budget`, `comms`, `volunteers`, `attendance`, `feedback`) |
| Submitted by | relation → `EST People SRC` |
| Submitted at | text (ISO) |
| Voters | relation → `EST People SRC` (multiple) — who +1'd; count = votes |
| Status | SelectList (`New`, `Planned`, `Shipped`, `Declined`) — council triage (display-only in app) |

**Worker routes** (reuse existing token + `authIdentity`):
- `GET /feedback[?context=<id>]` — list ideas (optionally by context), sorted by vote count. **Auth-aware:** if a Google token is sent, resolve the person and mark `votedByMe` per idea (same optional-token pattern as `/me`). Returns `{ id, idea, context, submittedByName, votes, votedByMe, status }[]`.
- `POST /feedback` — body `{ idea, context }`; requires a matched identity; injects `Submitted by` + `Submitted at`; `context` defaults to `General`.
- `POST /feedback/:id/vote` — toggles the caller's person in `Voters`; requires a matched identity; returns the new `{ votes, votedByMe }`.

**App**
- Header CTA opens a small **Ideas** modal: a submit box (context `General`) + the full list with +1.
- Each coming-soon section renders: teaser line → mini submit form (context = section id) → that context's idea list with +1. Reuses one `feedbackBoardHTML(context)` + `wireFeedback(context)` component for both the modal and the section panels.
- The app already knows the current user (`state.identity`); it sends the Google token on `GET /feedback` so `votedByMe` is authoritative.

This turns the "Coming soon" rail from a static teaser into a **prioritized, self-serve feedback stream** the council can triage in Coda.

## 9. Non-goals / later

- Rich-text editor for the public description (markdown→allowlisted-HTML) — pinned; slots into the Publish section.
- Building any Coming-soon section's real functionality.
- Full-page graduation of the event view.
- Banner image, paid tickets, gCal (tracked in the publish design spec).

## 10. Test plan

- **App `node --check`** after each change.
- **Section rendering:** each live section renders and wires without error; switching sections preserves entered (unsaved) values where practical (or documents that switching commits to the in-memory `ev`).
- **Internal/public split:** a planning event with distinct internal vs public copy → publish sends the *public* copy to Eventbrite (verify via the Publish Log / the draft), internal never leaves; blank public falls back to internal.
- **URL deep-linking:** load `…/?event=<id>&section=publish` → editor opens to Publish; switching sections updates the URL; Back closes; a bad `event` id is ignored; Copy link yields a URL that reopens the same state.
- **Coming-soon:** disabled sections show the teaser; feedback affordance works.
- **SC fixes:** publish sends `alignment:'left'`; a brand-new event's description writes version 0 (re-verify the draft description renders on Eventbrite).
- **Browser smoke test** (signed out) that the editor renders the rail + Planning; and (signed in, if feasible) Publish section + a draft publish still works end-to-end.

## 11. Build sequence (for writing-plans)

1. Coda: add `Public summary` + `Public description` columns.
2. App model: `planningRowToEvent`/`eventToCodaCells` for the new fields; reframe internal-description label.
3. App: section registry + modal rail + panel host; move existing fields into Planning; assemble Publish section (summary, public description + copy-from-internal, capacity, ticket, address, publish panel).
4. App: URL param sync (open/close/section) + deep-link-on-load + Copy link.
5. App: Coming-soon rail group + teaser panels.
6. Worker: publish route reads `Public summary`/`Public description` (fallbacks); SC `alignment` + version-0 fixes.
7. **Feedback board** (own phase): create the Coda `Roadmap Feedback` table; Worker `GET/POST /feedback` + `POST /feedback/:id/vote`; app `feedbackBoardHTML(context)`/`wireFeedback(context)` reused by the header Ideas modal and each coming-soon section.
8. Verify (browser + a draft publish + submit/vote round-trip) + docs.

Phases 1–6 are the workspace/publish core; phase 7 (feedback board) is a cohesive add-on that can land right after — same branch.
