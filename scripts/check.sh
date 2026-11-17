#!/usr/bin/env bash
# The fast checks every change must pass. Run by hand, by the Claude Code Stop
# hook (.claude/settings.json) and in CI (.github/workflows/check.yml).
#
#   ./scripts/check.sh           # all checks; non-zero + a list of problems on failure
#   ./scripts/check.sh --hook    # Stop-hook mode: exit 2 (blocks "done") on failure
#
# Checks:
#   1. node --check on every web/*.js (syntax)
#   2. shared/ mirrors are in sync (scripts/sync-shared.sh --check)
#   3. the help guard's content check (scripts/check-help.mjs)
#   4. web/listing-readiness.js and web/venue-address.js stay free of browser globals — the Worker bundles them
#   5. no outerHTML assignments in web/ (decision D1: stable containers, inner HTML only)
#   6. web/*.js files stay under MAX_LINES (small, focused files)
#
# Unit tests (cd proxy && npm test) are not here: they take longer and need the
# machine-wide test lock. Run them for any change to proxy/ or the shared modules.
set -uo pipefail
cd "$(dirname "$0")/.."

hook=0
[[ "${1:-}" == "--hook" ]] && hook=1

MAX_LINES=800
# Files allowed past MAX_LINES (none: app.js was split into small files).
OVERSIZE_OK=()

problems=()
add() { problems+=("$1"); }

# 1. Syntax
for f in web/*.js; do
  out=$(node --check "$f" 2>&1) || add "syntax: $f
$out"
done

# 2. shared/ mirrors
out=$(./scripts/sync-shared.sh --check 2>&1) || add "shared mirrors drifted:
$out"

# 3. Help guard (content: labels, links, ids, What's new)
out=$(node scripts/check-help.mjs 2>&1) || add "help guard:
$out"

# 4. listing-readiness.js and venue-address.js are bundled into the Worker: no DOM/browser globals.
out=$(grep -nE '\b(document|window|localStorage|sessionStorage|navigator)\b' web/listing-readiness.js web/venue-address.js) && add "web/listing-readiness.js or web/venue-address.js uses a browser global (the Worker bundles both files):
$out"

# 5. D1: no outerHTML assignments (a swap that carries its own wrapper nested labels once).
out=$(grep -rnE '\.outerHTML[[:space:]]*\+?=[^=]' web --include='*.js' --include='*.html') && add "outerHTML assignment in web/ (D1: render into a stable container with innerHTML):
$out"

# 6. File size ceiling
for f in web/*.js; do
  n=$(wc -l < "$f" | tr -d ' ')
  if (( n > MAX_LINES )); then
    allowed=0
    # ${a[@]+...}: an empty list is safe under bash 3.2 + set -u
    for ok in ${OVERSIZE_OK[@]+"${OVERSIZE_OK[@]}"}; do [[ "$f" == "$ok" ]] && allowed=1; done
    (( allowed )) || add "$f is $n lines (ceiling $MAX_LINES): split it along a seam, see docs/app-map.md"
  fi
done

if (( ${#problems[@]} == 0 )); then
  (( hook )) || echo "check.sh: all checks passed"
  exit 0
fi

{
  echo "check.sh found ${#problems[@]} problem(s):"
  for p in "${problems[@]}"; do echo "- $p"; done
  echo "Fix these before calling the work done (scripts/check.sh lists the checks)."
} >&2
(( hook )) && exit 2
exit 1
