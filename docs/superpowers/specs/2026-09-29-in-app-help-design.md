# Design — In-app help: Welcome, guides, and keeping them current

**Date:** 2026-09-29
**Status:** Design approved in brainstorming (2026-09-29). Ready for spec review → writing-plans.
**Scope:** A **Help drawer** in the plan app (`web/`) with a first-sign-in
**Welcome**, 13 task-based **guides**, a **What's new** feed, and contextual entry
points — plus a dev-cycle mechanism (**rule + guard + blocking Claude Code hook +
GitHub check**) that keeps the guides current as the app changes. Plan app only;
`gather/` is out of scope.

---

## 1. Context & goal

Program leads are mostly non-technical. They need to know what the app is for, how
it works, and how to do specific things (add an idea, propose it, publish it, email
attendees) without having to ask someone.

Today the only help is the round **i** "Legend & key" modal (`openInfo` /
`legendHTML` in `web/app.js`), and it has already drifted: it lists a **Confirmed**
status the lifecycle dropped in Aug 2026, and says reference calendars are toggled
"in the sidebar" (they're in the top strip). The header tagline still says "no
eventbrite/gCal required", though Eventbrite publishing now lives in the app. The UI
changes often (the Publish tab folded into Details on 2026-09-19), so any help that
isn't tied to the development cycle will rot the same way.

**Goal:** help that is simple for leads, reachable from wherever they are, and kept
current **automatically** — updated in the same branch as the change that would make
it stale, with a deterministic guard that blocks merges that forget.

**Development context that shapes the mechanism:** nearly every commit is authored in
a Claude Code session (spec → plan → execution), and merges into `main` happen both
via GitHub PRs and locally (`git merge`, e.g. `bff2384`). A PR-only check would miss
local merges, so enforcement lives in the Claude workflow itself, with a GitHub check
as the backstop.

## 2. Decisions settled in brainstorming (don't relitigate)

1. **Onboarding = Welcome + Help drawer.** Not a guided spotlight tour (brittle
   against layout changes, awkward on phones) and not a help button alone. The
   Welcome is a guide that opens automatically once, on first sign-in.
2. **Content ships with the code** — Markdown in `web/help/`, rendered in the app.
   Not a Superhuman Docs page (outside the dev cycle, so it drifts; leads may lack doc
   access; it can't power the Welcome or contextual links). Not an AI doc-bot in CI
   (per-PR API cost, an API-key secret, and it misses local merges) — that stays an
   upgrade path if other developers start contributing; it would reuse these files.
3. **Freshness = rule + guard + blocking hook.** A CLAUDE.md rule makes help updates
   part of every lead-visible change; `scripts/check-help.mjs` verifies it; a Claude
   Code hook runs the guard before merging into `main` or opening a PR and **blocks**
   on findings (Claude resolves the block itself — no extra prompts for the user). A
   GitHub check runs the same script on PRs and pushes to `main`.
4. **No screenshots.** On-screen names render as button-shaped chips (`[[Propose]]`)
   and the calendar key is drawn live with the app's own CSS — visuals that can't go
   stale. Guides refer to things by name; a coarse, stable place ("at the top of the page") is fine, but never left/right, corners or color.
5. **One audience, role notes inline.** Guides are written for a program lead;
   Member / Tribal Council differences are called out inline ("Tribal Council
   only"). No role-filtered content.
6. **Welcome / What's-new state is per device** (`localStorage`), not stored in Coda.

## 3. Scope

**In:**
- The Help drawer, its entry points, the Welcome, the What's new dot, and
  `?help=<id>` deep links (§5).
- Initial content: 13 guides + a What's new backfill (§4).
- `web/help/help-lib.js` parser/renderer (§6); `scripts/check-help.mjs` guard (§7);
  the hook + GitHub workflow (§8); the CLAUDE.md rule (§9).
- **Removals / fixes:** the **i** button, `openInfo()` and `legendHTML()` (the key
  moves into the "Reading the calendar" guide as a live embed); the stale header
  tagline becomes "East Side Tribe · plan the year's programming together".

**Out (non-goals):** help for `gather/` (the same mechanism can extend to it later);
screenshots or video; a guided tour; role-filtered content; server-side "seen"
state; an AI doc-bot; editing help outside the dev cycle; usage analytics; a
periodic AI "help audit" of guides vs. the running app (possible later).

## 4. Content

### Files
- `web/help/guide.md` — every guide, in one file (one fetch, one search index, one
  place to edit).
- `web/help/whats-new.md` — dated, plain-language change notes, newest first.

These are public static files (the sign-in gate is client-side), so they must never
hold private information — no member names or emails, no internal links. The tribe
contact address already shown on the sign-in screen is fine.

### `guide.md` format — a deliberately small Markdown subset
- `# Group name` — a group in the drawer's index: *Getting started*, *Planning an
  event*, *After approval*, *Help*.
- `## Guide title {#guide-id}` — starts a guide. Ids are kebab-case, unique, and
  **permanent once shipped** (they appear in shared links).
- Inside a guide: paragraphs; `### Subheading`; `- ` bullets; `1. ` numbered steps
  (one level, no nesting); `**bold**`, `*italic*`; links `[text](https://…)`,
  `[text](mailto:…)`, and `[text](#guide-id)` to another guide.
- `[[Label]]` — an on-screen name (button, tab, field, badge). Renders as a
  button-shaped chip and is **checked by the guard** (§7). Chip only text that
  appears literally in the UI; dynamic text (e.g. counts) stays plain.
- `> Tip: …` — a tip callout.
- `{{legend}}` on a line of its own — a live embed rendered by the app (the only
  embed in v1).
- `<!-- … -->` — comments, not rendered. The top of the file holds the writing guide.
- Everything else is escaped text. **No raw HTML.**

### Writing guide (kept as a comment at the top of `guide.md`)
Write for a program lead who isn't technical: "you", short sentences, task-first
titles ("Add an event or idea"). Numbered steps for anything with more than one
action. Things people click, pick or fill in go in `[[ ]]`; things they only read
(statuses, badges) in **bold**. Refer to things by name (a coarse place like "at the
top of the page" is fine; never left/right or color). No internal names (Coda,
Superhuman Docs, Worker, proxy, row, sync, API). Say who can do role-limited things,
and warn before anything with no undo. About 150 words per guide (~250 for one with
warnings, or the FAQ) — link to another guide rather than repeat it.

### Initial guides
| Group | Guide ids — what each covers |
|---|---|
| Getting started | `welcome` — what the app is for; the Idea → Propose → Approve → Publish path; who can do what (Member / Program Lead / Tribal Council) · `getting-around` — Overview vs. Calendar, the Sep–Aug program year, holiday & partner layers, refresh · `reading-the-calendar` — color = program, chip style = status, undated ideas, the Past / Live badges; contains `{{legend}}` |
| Planning an event | `add-event` — New event; exact day / date range / month · `edit-details` — the tabs, automatic saving, the save pill · `lifecycle` — Propose, Approve (Council), Cancel, Reopen (Council), Delete (Council); why fields lock · `planning-notes` — the event's Google Doc · `signups` — potluck & volunteer slots; how members sign up in gather |
| After approval | `publish` — the Public listing fields, Eventbrite draft vs. publish, the Update draft / Update published event buttons that appear after an edit, what cancelling does to the listing · `attendees` — the roster, segments, Copy emails, Email from your own account · `share-link` — copying a link and what it opens |
| Help | `troubleshooting` — can't sign in (link in spam; use Google), can't edit (role — ask Tribal Council), can't find an event (refresh, program year, layers), changes not showing · `feedback` — the Feedback / Ideas board |

**What's new** appears in the drawer as its own entry (reserved id `whats-new`,
backed by `whats-new.md`). Every step in every guide is verified against the running
app and the code before shipping — the content is the real deliverable.

### `whats-new.md` format
`## YYYY-MM-DD` headings, newest first, each with one or more `- ` bullets written as
`**Short headline.** One or two plain sentences.` Backfilled from September 2026: the
Attendees tab (2026-09-16); Publish folded into Details as the Public listing, and the
phone layout improvements (2026-09-19). `whats-new.md` is **not** label-checked —
history legitimately names UI that no longer exists.

## 5. The Help drawer (app)

**Shape.** A panel docked on the right (~400px) on desktop; full screen at phone
widths (≤600px). No scrim — whatever is behind stays usable: on wide screens (1000px
and up) an open editor shifts left to sit beside the drawer (the modal's scrim is inset
by the drawer width while it's open); narrower, the drawer overlays it; the calendar is
simply overlapped; on phones the drawer
covers the screen and closing it returns to whatever was open. Layered above the editor modal and the
sign-in gate (both `z-index:60`) and below toasts (`100`). `role="dialog"`, labelled
"Help"; focus moves in on open and returns to the opener on close. **Esc closes the
drawer first**; the editor stays open until the next Esc.

**Views.**
- **Index:** a search box (case-insensitive match on guide titles and text); guides
  listed under their group; then **What's new** (with a dot if unseen).
- **Guide:** "← All guides", the title, the rendered body, and a footer "Still
  stuck? Email us" (`mailto:eastsidetribenashville@gmail.com`, the address already on
  the sign-in screen).
- **No search matches:** "No guides match — try other words, or email us."

**Entry points.**
1. A **?** button in the header's right-hand cluster, next to Feedback / Ideas, at
   all widths (it replaces the **i**, so the phone header gains no width) → index.
2. **Welcome** auto-opens once: when a signed-in identity resolves, and
   `localStorage['est-help-welcomed']` is unset, and the URL has no `event` or `help`
   param. It's decided once per page load; the flag is set when it auto-opens (a
   reload won't repeat it), and What's new is marked seen for a brand-new user (no
   cached rows yet — a returning user keeps the dot).
3. **Event editor header ?** (next to copy-link) → the guide for the active tab, via
   a new `help:` field on each `SECTIONS` entry: `details` → `edit-details`, `notes`
   → `planning-notes`, `volunteers` → `signups`, `attendees` → `attendees`, the
   coming-soon tabs → `feedback`.
4. **New event form header ?** → `add-event`.
5. A planning event's **status badge** in the editor header (Draft / Proposed /
   Approved / Live / Cancelled) becomes a button titled "What does this mean?" →
   `lifecycle`. Reference-event badges are unchanged.
6. **Sign-in screen:** "New here? See how it works" → `welcome` (works signed out).
7. **`?help=<id>`** in the URL opens that guide on load, signed in or not (an unknown
   id opens the index). While a guide is open the URL carries `?help=<id>`
   (`replaceState`, coexisting with `?event=` / `&section=`); closing removes it.
8. **What's new dot** on the header **?** when the newest `whats-new.md` date is
   later than `localStorage['est-help-seen']`; opening What's new sets it.

**Loading.** `guide.md` is fetched on the first drawer open, so it never slows the
calendar. `whats-new.md` (tiny) is fetched after first paint to compute the dot. App
code refers to a guide **only** through `openHelp('<id>')`, a `help:'<id>'` field, or
a `data-help="<id>"` attribute — the three forms the guard checks.

**Live legend.** `{{legend}}` renders sample chips using the calendar's real chip
classes for the four statuses the calendar renders today (`draft`, `proposed`,
`approved` with its lock, `cancelled`) plus a reference-calendar chip, and shows program swatches from the live program
list (active programs only); the guide's own text explains the **Live** and **Past** badges.
It replaces `legendHTML()`, whose Idea / Confirmed rows are legacy (those CSS classes
remain in `styles.css` but are no longer rendered).

**Failure behavior.** If the help files fail to load, the drawer shows "Help couldn't
load" with Retry and the email link; the calendar is unaffected. If `localStorage` is
unavailable, there is no Welcome auto-open and no dot (never nag on every load);
everything else works.

## 6. `web/help/help-lib.js`

A plain browser script that attaches `globalThis.HelpLib` (the same pattern as
`web/roster-lib.js`), so the app, the unit tests and the guard share one parser. Pure
functions — no DOM, no I/O:

- `parseGuide(md)` → `{ guides: [{ id, title, group, body, line }], errors: [...] }`
  (errors for a missing, malformed or duplicate id).
- `renderGuide(body, { embed })` → safe HTML. All text is escaped; only the §4 syntax
  becomes markup; `[[Label]]` always renders as `<span class="uichip">`; `embed(name)`
  is supplied by the caller.
- `uiLabels(md)`, `guideLinks(md)`, `embeds(md)` → `[{ …, line }]`, for the guard.
- `parseWhatsNew(md)` → `{ entries: [{ date, line, items }], errors }`;
  `renderWhatsNew(entries)` → safe HTML.
- `searchGuides(guides, query)` → the guides containing every word.

## 7. The guard — `scripts/check-help.mjs`

Plain Node, no dependencies; loads `help-lib.js`. **"Screens"** = the top-level
`web/*.js` and `web/*.html` files (so `web/help/`, `web/embed-test/` and CSS are
excluded).

**Content checks** (always):
1. Every `[[label]]` in `guide.md` appears in the screens code **as on-screen
   text** — between tags (`>Label<`), as a whole quoted string, or as a JS string /
   template chunk (a one-pass scanner reads the JS), after decoding `&amp;` and
   folding curly apostrophes. Code comments don't count.
   Finding: `guide.md:42 [[Publish]] no longer appears on screen`.
2. Guide ids are unique and kebab-case; `(#id)` links between guides resolve; every
   `openHelp('…')`, `help:'…'` and `data-help="…"` in the screens code names an
   existing guide (or `whats-new`); every `{{embed}}` is a known embed.
3. `whats-new.md` has dated `## YYYY-MM-DD` headings, newest first, each with at
   least one bullet.

**Branch check** (`--branch <ref> [--base main]`): if `<base>...<ref>` changes any
screens file but none of the help text (`web/help/*.md` — not its renderer), it fails — unless a commit message in
`<base>..<ref>` contains a line `Help: none — <reason>`. The guard accepts any dash,
hyphen or colon after `none` (`Help: none - typo fix` is fine) but requires a
non-empty reason. In
branch mode (and in the hook) the content checks read the tree the merge would
produce (`git merge-tree --write-tree`; on a conflict, `<ref>`'s own tree) — i.e.
what would actually be merged.

**Output / exit codes.** Findings print one per line, each with its fix ("update
`web/help/guide.md`, or add a commit with `Help: none — <reason>`").
- CLI / CI mode: findings → exit 1; an internal error (git failure, crash) → exit 1
  too, so it gets noticed.
- Hook mode: findings → exit 2 (blocks); an internal error → reported as a warning
  with exit 1 (non-blocking), so a bug in the guard can never stop work.

## 8. Where the guard runs

- **Claude Code hook** — a committed `.claude/settings.json` with a `PreToolUse` hook
  on `Bash` → `node scripts/check-help.mjs --hook` (reads the tool-call JSON on
  stdin). It acts only on:
  - `git merge <ref>` into `main` (the current branch, or one the same command
    switches to first, e.g. `git checkout main && git merge <ref>`) — the ref is the first
    non-option argument (options that take a value, like `-m`, are skipped with it);
    `--abort` / `--continue` / `--quit` pass → content + branch check of `<ref>` vs
    `main`;
  - `gh pr create` → content + branch check of the current branch vs `--base` / `-B`
    (default `main`).

  It also stands aside unless the command runs in this repository (compared by git
  common dir, so worktrees count; `git -C`, a leading `cd` and `gh -R/--repo` are
  understood) and ignores `git merge-base/-tree/-file`. Every other command exits 0
  immediately. On findings it exits 2: the command is
  blocked, Claude sees the findings, fixes the guide (or records `Help: none — …`)
  and retries.
- **GitHub workflow** `.github/workflows/check-help.yml` — on `pull_request`: content
  + branch check against the PR base (checkout with full history); on `push` to
  `main`: content checks (this catches hand merges). It also runs the `help-lib` unit
  tests. Free — the repo is public.
- **By hand:** `node scripts/check-help.mjs [--branch <ref>]`.

**Known gap:** a behavior change with unchanged labels (e.g. approval needing two
Council members) isn't mechanically detectable. The rule (§9) plus the branch check's
forced decision cover it: Claude must either update the guide or say why not.

## 9. CLAUDE.md changes

- **Conventions — "Help ships with the change":** any change a program lead could
  notice (a new, renamed, moved or removed button, tab, field, step or rule) updates
  `web/help/guide.md` and adds a dated line to `web/help/whats-new.md` **in the same
  branch**. Implementation plans for user-facing work include an "Update help" task.
  A branch that touches the screens with nothing lead-visible records `Help: none —
  <reason>` in a commit message. The hook enforces this before merge / PR.
- **Repo map:** a `web/help/` row. **App structure:** the Help drawer, its entry
  points and `SECTIONS[].help`; the `openInfo()` legend bullet is removed.

## 10. Testing

- **Unit** (`node --test`, `proxy/test/help-lib.test.js` beside
  `roster-lib.test.js`): guide parsing (groups, ids, line numbers, duplicate and
  missing ids); rendering (escaping — HTML in content renders as text; chips; links
  between guides; tips; lists); `uiLabels`; `parseWhatsNew`.
- **Guard:** passes on the real repo; fails on fixtures — a missing label, a label
  present only in a comment, a dead `openHelp` id, a duplicate id, an unknown embed, a
  screens change without a help change; and passes with a `Help: none — …` trailer.
  Hook mode with sample stdin: `git merge feat/x` on `main` (checked), `git merge
  main` on a feature branch (passes), `git merge --abort` (passes), `gh pr create`
  (checked), an unrelated command (passes).
- **In the local preview** (`live-server`): the drawer at desktop and phone widths,
  dark mode, search, every entry point, `?help=` while signed out, Esc layering over
  the editor, the Welcome auto-opening exactly once, and the dot.
- **Content accuracy:** each guide's steps walked through against the running app and
  the code before shipping.

## 11. Rollout

`web/` redeploys on Netlify on merge to `main`. No Worker code changes; the new tests
live in `proxy/test/`, so this one merge re-runs the Worker deploy workflow with
unchanged code (later test-only edits don't — `deploy-proxy.yml` now ignores
`proxy/test/**`). No new services, no secrets. The GitHub workflow is new but free.

## Open item for the plan

- Confirm the current Claude Code hook contract (stdin JSON shape, exit-code
  semantics, `$CLAUDE_PROJECT_DIR`) when wiring `.claude/settings.json`, and test the
  hook live in a session before relying on it.
