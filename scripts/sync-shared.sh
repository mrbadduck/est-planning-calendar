#!/usr/bin/env bash
# One source of truth for browser code both apps use: shared/*.
# Mirrors shared/ into each app dir so both buildless sites can <script src> it.
#
#   ./scripts/sync-shared.sh          # copy shared/* into web/ and gather/
#   ./scripts/sync-shared.sh --check  # verify the mirrors are in sync (CI / pre-merge); non-zero if drifted
#
# The mirrors (web/auth-firebase.js, gather/auth-firebase.js) are committed so
# neither Netlify site depends on a build step to have the file — this script
# just keeps them identical to the canonical shared/ copy. Run it after editing
# anything under shared/. `node --test` in proxy/ does NOT cover this; the
# --check mode is the drift guard (wire it into CI or run before merging).
set -euo pipefail
cd "$(dirname "$0")/.."

apps=(web gather)
check=0
[[ "${1:-}" == "--check" ]] && check=1

fail=0
for f in shared/*; do
  name="$(basename "$f")"
  for app in "${apps[@]}"; do
    dest="$app/$name"
    if [[ "$check" == 1 ]]; then
      if ! cmp -s "$f" "$dest"; then
        echo "drift: $dest differs from $f (run ./scripts/sync-shared.sh)" >&2
        fail=1
      fi
    else
      cp "$f" "$dest"
      echo "synced $dest"
    fi
  done
done
exit "$fail"
