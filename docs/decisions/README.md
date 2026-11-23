# Decisions

One page per decision that shapes the code: what we decided, why, and when. Read the
relevant one before changing what it covers. To reverse a decision, add a new record
that supersedes it rather than editing history.

| # | Decision | Date |
|---|---|---|
| [0001](0001-coda-source-of-truth.md) | Coda (Superhuman Docs) is the source of truth; the app owns no data | Aug 2026 |
| [0002](0002-worker-side-publishing.md) | Tokens and publishing live in the Worker, never the browser | Aug 2026 |
| [0003](0003-dns-at-hover.md) | DNS stays at Hover; deploy standalone on Netlify | Aug 2026 |
| [0004](0004-phased-auth.md) | Auth is phased: read-only first, then Firebase sign-in + role gate for writes | Aug 2026 |
| [0005](0005-saved-means-applied.md) | D3: "Saved" means every read through the Worker returns the write: overlaid, else applied (amended by 0012) | Nov 2026 |
| [0006](0006-nothing-from-eventbrite-written-back.md) | D4: nothing read from Eventbrite is written to Coda (superseded by 0009) | Nov 2026 |
| [0007](0007-no-silent-fallbacks.md) | D7: no silent fallbacks | Nov 2026 |
| [0008](0008-coda-apply-latency.md) | Coda applies writes ~28 s after accepting them, whatever the doc size (the Worker covers its own reads since 0012) | Nov 2026 |
| [0009](0009-eventbrite-edits-flow-into-plan.md) | Eventbrite edits flow into plan, field by field (supersedes 0006) | Nov 2026 |
| [0010](0010-worker-is-the-gcal-writer.md) | The Worker is the only writer of Google Calendar: stored ids, full replace, delete on cancel, shadow mode | Nov 2026 |
| [0012](0012-write-through-overlay.md) | A write-through overlay (a Durable Object) covers Coda's apply delay for Worker reads; `OVERLAY_MODE` switch | Nov 2026 |

Smaller rules from PR #35 (D1 stable containers, D2 one `ctx`, D5 one shared rules
module, D6 footer model, D8 no mid-push confirm) are in
`docs/superpowers/specs/2026-11-14-publish-flow-footer-wizard-design.md`, the
"Decisions" table. D1 is enforced by `scripts/check.sh`.
