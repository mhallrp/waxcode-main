#!/bin/bash
# Strips everything personal from a box before it goes to someone else.

set -euo pipefail

BOX_USER="${BOX_USER:-waxcode}"
BOX_HOME="/home/$BOX_USER"

if [ "$(id -u)" -ne 0 ]; then
    echo "Run with sudo." >&2
    exit 1
fi

echo "=== Preparing $(hostname) for shipping ==="
echo

# --- WiFi ---
echo "WiFi profiles:"
found=0
while read -r name; do
    [ -z "$name" ] && continue
    nmcli connection delete "$name" >/dev/null 2>&1 && echo "  removed $name"
    found=1
done < <(nmcli -t -f NAME,TYPE connection show 2>/dev/null | awk -F: '$2=="802-11-wireless"{print $1}')
[ "$found" -eq 0 ] && echo "  none"

# --- SSH access -------------------------------------------------------------
# A leftover key lets the previous owner back in.
echo "SSH authorized keys:"
if [ -s "$BOX_HOME/.ssh/authorized_keys" ]; then
    keys=$(wc -l < "$BOX_HOME/.ssh/authorized_keys")
    : > "$BOX_HOME/.ssh/authorized_keys"
    echo "  cleared $keys"
else
    echo "  none"
fi

# Host keys are regenerated so two boxes from one card image are not identical, and so nobody has a key fingerprint from the build machine.
echo "SSH host keys:"
rm -f /etc/ssh/ssh_host_*
dpkg-reconfigure openssh-server >/dev/null 2>&1 || ssh-keygen -A >/dev/null 2>&1
echo "  regenerated"


# --- Accumulated state ------------------------------------------------------
# Caches describing USB sticks this box will never see again.
echo "Analysis cache:"
if [ -d "$BOX_HOME/data/waveform-cache" ]; then
    size=$(du -sh "$BOX_HOME/data/waveform-cache" 2>/dev/null | cut -f1)
    rm -rf "$BOX_HOME/data/waveform-cache"/*
    echo "  cleared ($size)"
else
    echo "  none"
fi

echo "Test recordings:"
count=$(find "$BOX_HOME/data/recordings" -name '*.mp3' 2>/dev/null | wc -l)
find "$BOX_HOME/data/recordings" -name '*.mp3' -delete 2>/dev/null || true
echo "  removed $count"

echo "Favourites and deck state:"
rm -f "$BOX_HOME/data/favourites.json" "$BOX_HOME/data/deck-relative-mode.json" \
      "$BOX_HOME/data/box-name.json" 2>/dev/null || true

# The caching kill switch (see server/src/cache-mode.js).
if [ -f "$BOX_HOME/data/disable-cache" ]; then
    rm -f "$BOX_HOME/data/disable-cache"
    echo "  removed the disable-cache flag - caching is ON for the new owner"
fi

# Dev leftovers that accumulate in the home directory during a build: ad-hoc test scripts, library backups, archived crash dumps.
rm -f "$BOX_HOME"/library-json-prep-backup-*.json "$BOX_HOME/keylock" "$BOX_HOME/asound.conf" 2>/dev/null || true
rm -rf "$BOX_HOME/crash-archive" 2>/dev/null || true
echo "  cleared"

# --- Logs and history -------------------------------------------------------
echo "Logs:"
journalctl --rotate >/dev/null 2>&1 || true
journalctl --vacuum-time=1s >/dev/null 2>&1 || true
echo "  vacuumed"

echo "Shell history:"
rm -f "$BOX_HOME/.bash_history" /root/.bash_history 2>/dev/null || true
echo "  cleared"

# --- What is deliberately KEPT ---------------------------------------------
echo
echo "Kept on purpose: the timecode/cue-offset settings in data/deck*.env, the installed"
echo "releases, and the source in ~/src (so the box can be rebuilt or updated in place)."
echo
echo "=== Done - check the summary above, then power off ==="
echo
echo "Still yours to do by hand:"
echo "  * change the box's password, or hand over the one you set"
echo "  * confirm the hostname is unique if more than one box will share a network"
echo "  * run ./check-drift.sh - nothing should differ from the repo before this box ships"
