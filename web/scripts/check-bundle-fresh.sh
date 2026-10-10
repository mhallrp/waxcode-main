#!/bin/bash
# The built UI is committed, because the box never runs npm install - so it can silently fall
# behind the source it came from, and a release would then ship old UI with new server code.
# Builds, and fails if that changed anything that is tracked.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
cd "$HERE/.."

npx vite build >/dev/null

if ! git diff --quiet -- ../server/web; then
    echo "server/web/ is out of date - the committed bundle does not match the source." >&2
    echo "Changed:" >&2
    git diff --name-only -- ../server/web | sed 's/^/  /' >&2
    echo "Commit the rebuild." >&2
    exit 1
fi
echo "server/web/ matches the source."
