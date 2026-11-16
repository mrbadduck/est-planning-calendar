# CLAUDE.md — East Side Tribe Planning Calendar

Loaded on every task, so it holds only what must always hold. Everything else is one
hop away (see **Where to look**).

## What this is

A full-year program-planning calendar for **East Side Tribe (EST)**, a lay-led Jewish
community org. Live at `plan.eastsidetribe.org` (Netlify). It reads and writes EST's
**Mission Control** doc in **Superhuman Docs** (this is Coda, renamed July 2026;
`coda.io` links redirect and the API is still `coda.io/apis/v1`) through a Cloudflare
Worker. Program leads draft events, Tribal Council approves them, and the Worker
publishes approved events to Eventbrite.

## Repo map

| Path | What | Deploys to |
|------|------|-----------|
| `web/` | The calendar app: `index.html` + `styles.css` + plain `<script>` files, vanilla JS, **no build step**. `web/listing-readiness.js` is also bundled into the Worker | Netlify (`plan.eastsidetribe.org`) |
| `web/help/` | In-app help: `guide.md`, `whats-new.md`, `help-lib.js` | Netlify (with `web/`) |
| `gather/` | Member sign-up app (potluck/volunteer slots), buildless, code-complete | Netlify (`gather.eastsidetribe.org`, site not created yet) |
| `shared/` | Browser code both apps use; committed mirrors in `web/` + `gather/` (`scripts/sync-shared.sh`) | mirrored |
| `proxy/` | Cloudflare Worker: holds the tokens, gates by role, publishes to Eventbrite | Cloudflare Workers (CI, on merge) |
| `scripts/` | `check.sh` (the fast checks), `check-help.mjs` (help guard), `sync-shared.sh` | — |
| `docs/` | app map, glossary, decisions, roadmap, deployment, specs/plans | — |

## Where to look

- **How the app is built:** `docs/app-map.md` (read it before changing `web/`).
- **What a word means** (on screen ↔ Coda column ↔ code): `docs/GLOSSARY.md`.
- **Why something is the way it is:** `docs/decisions/` (one page each).
- **Deploying, local dev:** `docs/deployment.md`. Local: `npx -y live-server web
  --port=8080 --no-browser`; reads work against the live Worker.
- **What shipped, what's next, open questions:** `docs/roadmap.md`.
- **Specs and plans:** `docs/superpowers/specs/`, `docs/superpowers/plans/`; session
  handoffs in `docs/superpowers/handoffs/`.

## Non-negotiables (don't relitigate without reason)

Each has a page in `docs/decisions/`.

1. **Coda is the single source of truth** (0001). The app owns no data and reads/writes
   only through the Worker. Coda rows become one normalized event shape via
   `planningRowToEvent` / `eventToCodaCells` in `CodaSource`; **the UI must not learn
   the Coda row shape.** Browser storage holds only caches and per-device UI state.
2. **No token in the browser; publishing is server-side** (0002). Coda and Eventbrite
   tokens are Worker secrets; Eventbrite pushes run in role-gated Worker routes.
3. **DNS stays at Hover — never move the nameservers** (0003). The domain also carries
   the marketing site and Google email. Only ever add subdomain records.
4. **Auth is phased** (0004): Firebase sign-in; the Worker verifies the JWT, matches
   `EST People SRC` and gates by role (write = Program Lead/Tribal Council, approve =
   Tribal Council).
5. **"Saved" means Coda applied the write** (0005, D3), **nothing read from Eventbrite is
   written back** (0006, D4), **no silent fallbacks** (0007, D7).

## Hard constraints (learned the hard way)

- **Coda applies writes ~28 s after accepting them**, whatever the doc size (0008).
  Never act on a read right after a write without waiting for it to apply.
- **`web/listing-readiness.js` is bundled into the Worker**: no DOM or browser globals
  (checked), and editing it redeploys the Worker.
- **D1: render into stable containers with `innerHTML`; no `outerHTML` swaps** (checked).
- **Reference Coda columns by stable id, not name** (`proxy/src/coda-columns.js`) in new
  code; the planning seam is still name-keyed (`docs/app-map.md` → Gotchas).
- **Coda `valueFormat=rich` fences text in triple backticks**: unwrap every rich read
  with `stripRich` (`proxy/src/gather.js`).
- **A Worker route that changes planning rows must bust `ROWS_KV_KEY`** (reads are
  cached in KV, stale-while-revalidate).
- **The Coda API does not expose row layouts**: build forms from column metadata plus our
  own layout, and deep-link to the doc for rich editing.
- Calendar grid columns are `minmax(0,1fr)`, never bare `1fr`. The month grid is
  `.mgrid`, the modal body `.mbody`; keep them distinct.

## Conventions

- **Small stacked PRs.** `main` is always deployable. Work on branches (in a worktree if
  a dev server is watching the checkout), PR into `main`, fill in the PR template's "How
  it was verified". Related PRs can stack and release together.
- **Checks in the loop.** `./scripts/check.sh` runs `node --check` on `web/*.js`, the
  shared-mirror check, the help guard and structural rules (Worker-bundled file stays
  DOM-free, no `outerHTML`, `web/*.js` ≤ 800 lines). A Claude Code Stop hook runs it and
  blocks "done" on failure; CI runs it on every PR. Unit tests: `cd proxy && npm test`,
  one run machine-wide (`~/.claude/CLAUDE.md` → test lock).
- **No live writes from a session without Eric's OK.** No Worker deploys or version
  uploads, no `gh pr merge`, no force-push (`.claude/settings.json` denies them); no
  writes to prod Coda or Eventbrite. Verify locally with writes stubbed. Never click
  Publish.
- **Help ships with the change.** Any change a program lead could notice — a new,
  renamed, moved or removed button, tab, field, step or rule — updates
  `web/help/guide.md` and adds a dated line to `web/help/whats-new.md` **in the same
  branch**; implementation plans for user-facing work include an "Update help" task.
  Write for a non-technical lead (writing guide at the top of `guide.md`) and put exact
  on-screen text in `[[ ]]` — the guard checks it still exists. A branch that touches
  the screens (top-level `web/*.js|html`) with nothing lead-visible records
  `Help: none — <reason>` in a commit message. `scripts/check-help.mjs` enforces this:
  a PreToolUse hook blocks `git merge <branch>` into `main` and `gh pr create` on
  findings, and CI runs it on PRs. By hand: `node scripts/check-help.mjs [--branch <ref>]`.
- **Use the glossary's words** in code, copy, commits and docs. Add a term there when
  you introduce one.
- **Never commit secrets.** Tokens live in Worker secrets / `proxy/.dev.vars`
  (gitignored; template `proxy/.dev.vars.example`). Secrets: `CODA_API_TOKEN`,
  `EVENTBRITE_TOKEN`. To rotate: the Coda key committed in `eventbrite-coda-pack`'s
  `.coda.json`.
- **Stay buildless** unless there's a strong reason to add tooling.
