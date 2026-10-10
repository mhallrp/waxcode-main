#!/usr/bin/env bash
# One-time bootstrap: make a box able to receive its AUDIO ENGINE over the air.
set -euo pipefail

TARGET="${1:-}"
if [ -z "$TARGET" ]; then
    echo "Usage: $0 <user@host>    e.g. $0 waxcode@waxcodedvs.local" >&2
    exit 1
fi

HERE="$(cd "$(dirname "$0")" && pwd)"
REPO="$(cd "$HERE/.." && pwd)"
BOX_USER="${TARGET%@*}"

echo "=== Bootstrapping $TARGET for over-the-air xwax ==="

echo "--- 1/6  installing xwax's build dependencies ---"
# The box compiles its own xwax now, so it needs the toolchain and every library the fork links against
ssh -t "$TARGET" "sudo apt-get install -y -q build-essential libasound2-dev librubberband-dev \
    libsdl2-dev libsdl2-ttf-dev libsamplerate0-dev libfftw3-dev"

echo "--- 2/6  copying the updater ---"
ssh "$TARGET" "mkdir -p ~/updater"
scp -q "$REPO/updater/release-manager.js" "$REPO/updater/cli.js" "$REPO/updater/semver.js" "$TARGET:~/updater/"

echo "--- 3/6  installing the unit file ---"
# Substituted the same way provision.sh does it, so the two cannot drift apart.
sed -e "s|__BOX_USER__|$BOX_USER|g" "$HERE/xwax@.service" > "/tmp/xwax@.service.$$"
scp -q "/tmp/xwax@.service.$$" "$TARGET:/tmp/xwax@.service.new"
rm -f "/tmp/xwax@.service.$$"

echo "--- 4/6  applying on the box ---"
ssh -t "$TARGET" "sudo install -m 644 /tmp/xwax@.service.new /etc/systemd/system/xwax@.service \
    && rm -f /tmp/xwax@.service.new \
    && sudo systemctl daemon-reload \
    && install -d ~/bin \
    && ln -sfn /usr/local/bin/xwax ~/bin/xwax"

echo "--- 5/6  installing the deck watchdog ---"
ssh "$TARGET" 'set -e
    link=$(readlink -f ~/bin/xwax || true)
    exec_start=$(systemctl cat xwax@.service | grep "^ExecStart=" | cut -d" " -f1)
    echo "  ExecStart : ${exec_start#ExecStart=}"
    echo "  ~/bin/xwax -> $link"
    [ -x "$link" ] || { echo "  FAILED: the symlink does not resolve to an executable" >&2; exit 1; }
    # Must be the HOME path. `*/bin/xwax` also matched /usr/local/bin/xwax, which is the exact
    # thing this check exists to reject, so it could not fail for the case that matters.
    case "$exec_start" in
        *"$HOME/bin/xwax"*);;
        *) echo "  FAILED: xwax@.service starts $exec_start, not $HOME/bin/xwax" >&2; exit 1;;
    esac
    for pkg in libasound2-dev librubberband-dev libsdl2-dev libsdl2-ttf-dev; do
        dpkg-query -W -f="\${Status}" "$pkg" 2>/dev/null | grep -q "install ok installed" \
            || { echo "  FAILED: $pkg missing - the on-box xwax build would fail" >&2; exit 1; }
    done
    echo "  ok - this box will take xwax from the next published release"'

# The watchdog lives in pi/ too, so a release cannot carry it either - see its own header.
sed -e "s|__BOX_USER__|$BOX_USER|g" "$HERE/deck-watchdog.sh" > "/tmp/pidvs-watchdog.$$"
sed -e "s|__BOX_USER__|$BOX_USER|g" "$HERE/pidvs-deck-watchdog.service" > "/tmp/pidvs-watchdog-unit.$$"
scp -q "/tmp/pidvs-watchdog.$$" "$TARGET:/tmp/deck-watchdog.sh"
scp -q "/tmp/pidvs-watchdog-unit.$$" "$TARGET:/tmp/pidvs-deck-watchdog.service"
rm -f "/tmp/pidvs-watchdog.$$" "/tmp/pidvs-watchdog-unit.$$"
ssh -t "$TARGET" "sudo install -m 755 /tmp/deck-watchdog.sh /usr/local/bin/pidvs-deck-watchdog \
    && sudo install -m 644 /tmp/pidvs-deck-watchdog.service /etc/systemd/system/pidvs-deck-watchdog.service \
    && rm -f /tmp/deck-watchdog.sh /tmp/pidvs-deck-watchdog.service \
    && sudo systemctl daemon-reload \
    && sudo systemctl enable --now pidvs-deck-watchdog.service"

echo "--- 6/6  verifying ---"
ssh "$TARGET" 'set -e
    [ "$(systemctl is-active pidvs-deck-watchdog)" = active ] \
        || { echo "  FAILED: the deck watchdog is not running" >&2; exit 1; }
    echo "  ok - deck watchdog running"'

echo
echo "Done. Decks keep running the binary they already started; they pick the new one up"
echo "on their next start (the server starts them on demand, so just reload a track)."
