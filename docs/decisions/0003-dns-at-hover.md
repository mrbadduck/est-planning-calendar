# 0003 — DNS stays at Hover; deploy standalone

**Date:** Aug 2026 · **Status:** in force

## Decision

`eastsidetribe.org`'s nameservers stay at Hover. We only ever add subdomain records:
`plan` → Netlify (`web/`), and later `gather` → Netlify (`gather/`). The app is deployed
standalone, not embedded in Mission Control.

## Why

The domain also carries the Strikingly marketing site (apex/`www`) and live Google
Workspace email (`MX`, DKIM). Moving the nameservers risks both. Adding a subdomain
record can't disturb them.

## Consequences

- Cloudflare Access is off the table: it needs the whole zone on Cloudflare.
- The Worker runs on `workers.dev`, with no Cloudflare zone, so the Cache API is a no-op
  there; the Worker caches in KV instead.
- Hosting moved from GitHub Pages to Netlify without changing this.
- Embedding stays possible later; validate `web/embed-test/` first.
- Details: `docs/deployment.md`.
