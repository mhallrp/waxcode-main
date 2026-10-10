#!/bin/bash
# Copies this repo and the xwax fork onto a box, for provisioning or for updating source by hand.

set -euo pipefail

TARGET="${1:-}"
DEST="${2:-\$HOME/src}"

if [ -z "$TARGET" ]; then
    echo "usage: $0 <user@host> [remote-dir]" >&2
    exit 1
fi

HERE="$(cd "$(dirname "$0")" && pwd)"
REPO="$(cd "$HERE/.." && pwd)"
PARENT="$(cd "$REPO/.." && pwd)"
XWAX="$PARENT/xwax"

if [ ! -f "$XWAX/xwax.c" ]; then
    echo "No xwax fork at $XWAX - it must sit beside this repo." >&2
    exit 1
fi

# The box has no .git (excluded below), so it cannot resolve its own version - it uses whatever
# .version we send. Refreshed here, or the box reports whatever this Mac last happened to have.
( cd "$XWAX" && ./mkversion -r 2>/dev/null ) || true

echo "Sending $(basename "$REPO") and xwax to $TARGET:$DEST (xwax $(cat "$XWAX/.version" 2>/dev/null || echo unknown))"

# server/node_modules IS included deliberately
COPYFILE_DISABLE=1 tar -czf - \
    --exclude='.git' \
    --exclude='.DS_Store' \
    --exclude='._*' \
    --exclude='tools/node_modules' \
    `# Compiler output from the BUILDER'S MAC. make only rebuilds what is older than its source, so` \
    `# a Mach-O object sails through every compile step and dies at the link - cues.o as "file format` \
    `# not recognized", and qmtempo/.build/libqmdsp.a as undefined references, because an ar archive` \
    `# full of Mach-O reads fine and yields no ELF symbols (2026-10-09, first trixie card).` \
    --exclude='*.o' \
    --exclude='*.d' \
    --exclude='*.a' \
    --exclude='.build' \
    --exclude='desktop-prep' \
    -C "$PARENT" "$(basename "$REPO")" xwax \
  | ssh "$TARGET" "mkdir -p $DEST && tar -xzf - -C $DEST"

echo "Verifying..."
ssh "$TARGET" "
    junk=\$(find $DEST -name '._*' | wc -l)
    echo \"  AppleDouble files: \$junk (must be 0)\"
    [ -f $DEST/xwax/riaa.c ] && echo '  xwax fork: yes (riaa.c present)' || echo '  xwax fork: NO - upstream, not the fork!'
    [ -d $DEST/waxcode/server/node_modules ] && echo '  server deps: present' || echo '  server deps: MISSING'
    [ -x $DEST/waxcode/pi/provision.sh ] && echo '  provision.sh: executable' || echo '  provision.sh: not executable'
"

echo
echo "Next, on the box:"
# SERVER_VERSION deliberately absent: it stamps a version onto the CURRENT code
echo "  cd $DEST/waxcode/pi && sudo BOX_USER=waxcode ./provision.sh"
echo
echo "Or skip both steps and use ../pi/build-card.sh, which does this, provisions, reboots and verifies."
