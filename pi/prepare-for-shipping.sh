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

# Kept, in tmpfs and mode 600, so prepare-for-imaging.sh can grep the RAW CARD for these exact
# strings AFTER the zero-fill - the only check that measures the thing itself rather than a proxy.
# Never echoed, never written to disk, and gone the moment the box powers off.
#
# Added 2026-10-12, after an image passed an SSID-name scan while carrying the password in a
# cloud-init log from a previous card. The SSID was a proxy for the password; this is not.
#
# FIRST, before anything is deleted, and that ordering is the whole point. On Debian 13
# NetworkManager keeps its connections AS netplan yaml in /etc/netplan/90-NM-<uuid>.yaml, so
# `nmcli connection delete` takes the password with it. Run after that loop, this found nothing
# and prep refused the card - correctly, but for the wrong reason (2026-10-12).
echo "Secrets, kept in RAM for the post-fill scan:"
: > /run/waxcode-secrets
chmod 600 /run/waxcode-secrets
{
    # netplan: `password: "the-psk"` under an access point.
    grep -hoE 'password:[[:space:]]*"?[^"[:space:]]+"?' /etc/netplan/*.yaml /etc/netplan/*.yml 2>/dev/null \
        | sed -E 's/^password:[[:space:]]*//; s/^"//; s/"$//'
    # NetworkManager keyfiles, wherever they are.
    grep -rhoE '^(psk|wep-key0)=.+' /etc/NetworkManager /run/NetworkManager /var/lib/NetworkManager 2>/dev/null \
        | sed -E 's/^[a-z0-9-]+=//'
    # wpa_supplicant, for cards built any other way.
    grep -rhoE '^[[:space:]]*psk=.+' /etc/wpa_supplicant 2>/dev/null \
        | sed -E 's/^[[:space:]]*psk=//; s/^"//; s/"$//'
} 2>/dev/null | grep -vE '^(\$|[[:space:]]*$)' | sort -u >> /run/waxcode-secrets || true
secret_count="$(grep -c . /run/waxcode-secrets 2>/dev/null || echo 0)"
echo "  $secret_count secret(s) held in RAM for verification (never printed, never written to disk)"

# --- WiFi ---
echo "WiFi profiles:"
found=0
# The names are written down, because capture-image.sh scans the finished image for exactly these
# strings. Grepping an image for `psk=` instead matches wpa_supplicant's own packaged files, which
# are legitimately in there - a gate that refuses a clean image gets switched off.
: > /run/waxcode-removed-ssids
while read -r name; do
    [ -z "$name" ] && continue
    nmcli connection delete "$name" >/dev/null 2>&1 && echo "  removed $name"
    printf '%s\n' "$name" >> /run/waxcode-removed-ssids
    found=1
done < <(nmcli -t -f NAME,TYPE connection show 2>/dev/null | awk -F: '$2=="802-11-wireless"{print $1}')
# The SSID itself, not the profile name, which NetworkManager prefixes when netplan made it.
grep -ohE '"[^"]+":' /etc/netplan/*.yaml 2>/dev/null | tr -d '":' >> /run/waxcode-removed-ssids || true
[ "$found" -eq 0 ] && echo "  none"

# Deleting the NetworkManager connection is NOT enough, and that is not obvious.
#
# Raspberry Pi Imager writes its wifi settings as NETPLAN yaml. NetworkManager then generates a
# connection from it into /run - tmpfs, so `nmcli connection delete` removes something that was
# going to vanish at the next boot anyway, while the real copy sits in /etc/netplan holding the
# SSID and the PSK in plaintext. An image taken without this ships the builder's home wifi, and
# every box flashed from it silently joins that network instead of ever showing first-time setup.
# Found on hardware, 2026-10-11, by grepping /etc for the password.
echo "Netplan wifi configuration:"
removed=0
for f in /etc/netplan/*.yaml /etc/netplan/*.yml; do
    [ -e "$f" ] || continue
    grep -q "wifis:" "$f" 2>/dev/null || continue
    rm -f "$f"
    echo "  removed $(basename "$f")"
    removed=1
done
[ "$removed" -eq 0 ] && echo "  none"

# Deleting the CONFIG is not the end of it, and an image proved that (2026-10-11): the sweep below
# passed, and the captured artefact still carried the builder's wifi password ten times over. These
# three keep copies of their own, and none of them is a connection profile.
echo "Logs and network state:"
# The journal is persistent on this box on purpose, and NetworkManager names the connection it is
# activating on every single activation.
journalctl --rotate --quiet 2>/dev/null || true
journalctl --vacuum-time=1s --quiet 2>/dev/null || true
rm -rf /var/log/journal/* 2>/dev/null || true
echo "  journal: rotated and emptied"
# seen-bssids, timestamps and DHCP leases all name networks, and `nmcli connection delete` leaves
# every one of them behind.
rm -f /var/lib/NetworkManager/seen-bssids /var/lib/NetworkManager/timestamps \
      /var/lib/NetworkManager/*.lease /var/lib/NetworkManager/*.state 2>/dev/null || true
echo "  NetworkManager state: cleared"
rm -rf /var/tmp/* /tmp/*.log 2>/dev/null || true

# Said plainly rather than assumed: this is the one leak that is both a privacy failure and a
# functional one, so it is CHECKED rather than trusted to the deletions above.
#
# Widened from two config directories to everything writable, because the narrow version passed on
# an image that was not clean. /usr is excluded deliberately: netplan ships example configs and a
# schema full of these very words, and a sweep that cries wolf on its own operating system is one
# somebody learns to ignore.
echo "Credential sweep:"
#
# Anything Debian shipped is skipped, because a file that came out of a package predates this box
# and cannot hold its wifi password. Asked of dpkg rather than kept as a list of paths to ignore:
# /etc/wpa_supplicant/functions.sh contains the string `psk=` as CODE, failed a prep run on
# 2026-10-11, and a hand-maintained exclusion list would have grown a new entry every time the OS
# changed - until somebody started ignoring the check, which is the real failure.
#
# One directory at a time, and the exit status of every grep is checked.
#
# `grep -r` across all four trees at once is OOM-killed on a 1GB box: it dies, prints nothing, and
# an empty result reads as "clean". That is the worst failure a check like this can have, and it
# was happening silently (2026-10-11, rc=137). Each tree alone fits; a grep that does not finish
# now stops the run instead of blessing it.
sweep_candidates() {
    local d out rc
    for d in /etc /var /home /root; do
        [ -d "$d" ] || continue
        set +e
        # src/ and releases/ are THIS PROJECT'S OWN CODE, which talks about wifi passwords
        # constantly without containing one - pidvs-network.sh reads a psk on stdin, and a test
        # names the field. dpkg cannot vouch for them the way it can for a Debian file, so they are
        # named here. ~/src goes entirely in prepare-for-imaging.sh a few minutes later anyway.
        out="$(grep -rlaiE 'psk=|pre-shared-key|wifi-security|wifis:' "$d" \
            --exclude='*.img' --exclude-dir=src --exclude-dir=releases --exclude-dir=node_modules \
            2>/dev/null)"
        rc=$?
        set -e
        # 0 = matches, 1 = none. Anything else means it did not finish.
        if [ "$rc" -gt 1 ]; then
            echo "SWEEP-DID-NOT-FINISH $d (exit $rc)"
            continue
        fi
        [ -n "$out" ] && printf '%s\n' "$out"
    done
    return 0
}

leaks=""
while IFS= read -r candidate; do
    case "$candidate" in
        SWEEP-DID-NOT-FINISH*)
            echo "  $candidate - cannot certify this card, refusing" >&2
            exit 1
            ;;
    esac
    [ -n "$candidate" ] || continue
    case "$candidate" in *pidvs-setup*) continue ;; esac
    dpkg -S "$candidate" >/dev/null 2>&1 && continue
    leaks="${leaks}${candidate}
"
done <<SWEEP
$(sweep_candidates)
SWEEP
leaks="$(printf '%s' "$leaks")"
if [ -n "$leaks" ]; then
    echo "  STILL PRESENT - do NOT publish an image from this card:" >&2
    echo "$leaks" | sed 's/^/    /' >&2
    exit 1
fi
echo "  clean - no wifi credentials left on this card"

# --- the radio itself -------------------------------------------------------
# Removing every network is not the same as leaving the radio usable, and the difference cost a
# whole published image. A card built over ethernet has its Wi-Fi switched off - deliberately, to
# prove no network was ever joined - and BOTH halves of that persist:
#
#   /var/lib/systemd/rfkill/*                    systemd-rfkill restores the block on every boot
#   /var/lib/NetworkManager/NetworkManager.state WirelessEnabled=false, NM's own memory of it
#
# The v0.11.0 image carried both. Every box flashed from it booted with wlan0 unavailable, so the
# server built its pidvs-setup profile, tried to activate it, and NetworkManager answered "No
# suitable device found for this connection" - no setup network, on a card that was otherwise
# working perfectly. Found 2026-10-13, from the journal of a flashed card's first boot.
#
# This matters just as much for a user's OWN wifi: a blocked radio cannot join a network either,
# however the credentials arrived.
# Written against /sys, NOT the `rfkill` tool. The first version of this check used `rfkill` behind
# a `command -v` guard; the tool is not installed on these cards, so it skipped everything and
# reported success - an inert check, which is worse than none. Found the same day it was written.
echo "Wi-Fi radio:"
wifi_rfkill=""
for d in /sys/class/rfkill/rfkill*; do
    [ -e "$d/type" ] || continue
    [ "$(cat "$d/type" 2>/dev/null)" = wlan ] || continue
    wifi_rfkill="$d"
    echo 0 > "$d/soft" 2>/dev/null || true
done
# systemd-rfkill restores this at every boot, so the live radio and the saved state must agree.
for f in /var/lib/systemd/rfkill/*:wlan; do
    [ -e "$f" ] && printf '0\n' > "$f"
done
NM_STATE=/var/lib/NetworkManager/NetworkManager.state
if [ -f "$NM_STATE" ]; then
    sed -i 's/^WirelessEnabled=false/WirelessEnabled=true/I' "$NM_STATE"
fi
nmcli radio wifi on >/dev/null 2>&1 || true
# Asked of the kernel, not of what we just wrote.
if [ -z "$wifi_rfkill" ]; then
    echo "  no wlan rfkill switch found at all - cannot certify this card's radio, refusing" >&2
    exit 1
fi
soft="$(cat "$wifi_rfkill/soft" 2>/dev/null || echo 1)"
hard="$(cat "$wifi_rfkill/hard" 2>/dev/null || echo 1)"
if [ "$soft" != "0" ] || [ "$hard" != "0" ]; then
    echo "  REFUSING: the Wi-Fi radio is still blocked (soft=$soft hard=$hard)." >&2
    echo "  This card could never raise its setup network, and could not join a network the" >&2
    echo "  owner supplies either. Set the WLAN country (pi/provision.sh does this)." >&2
    exit 1
fi
echo "  unblocked (soft=0 hard=0), and the saved block state cleared so no boot restores it"

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

# Every audio file on the box, not just the mp3s in one directory.
#
# A recording can be any format, laptop staging drops real tracks into data/uploads, and the
# release carries a handful of one-second test fixtures. None of it belongs in something other
# people flash - an image that distributes somebody's music is a copyright problem whoever built it.
#
# $BOX_HOME and /tmp ONLY. Never /media: that is the owner's USB stick, which is theirs and is
# removable, and a prep script that deletes somebody's record collection would be unforgivable.
# One definition, called three times. Held in a variable and expanded unquoted it depended on word
# splitting to become separate arguments, which is a thing a shell can be configured not to do -
# and when it does not, find matches nothing, deletes nothing, and reports "clean".
audio_files() {
    # Unconditional. test/fixtures was briefly excluded here, to protect the project's own
    # synthesised one-second files from being stripped out of the source tree - but releases no
    # longer carry test/ at all (2026-10-12) and prepare-for-imaging.sh removes ~/src wholesale,
    # so the exclusion protected nothing and would have skipped real music in any path that
    # happened to match.
    find "$BOX_HOME" /tmp -type f \( \
        -iname '*.mp3' -o -iname '*.wav' -o -iname '*.flac' -o -iname '*.aiff' -o -iname '*.aif' \
        -o -iname '*.m4a' -o -iname '*.aac' -o -iname '*.ogg' -o -iname '*.opus' -o -iname '*.wma' \
        \) 2>/dev/null
}

echo "Audio:"
count="$(audio_files | wc -l | tr -d ' ')"
audio_files | while IFS= read -r f; do rm -f "$f"; done
rm -rf "$BOX_HOME/data/uploads"/* 2>/dev/null || true
echo "  removed $count file(s), and emptied data/uploads"

# Checked, not assumed - the same reasoning as the credential sweep below it.
left="$(audio_files)"
if [ -n "$left" ]; then
    echo "  STILL PRESENT - do NOT publish an image from this card:" >&2
    echo "$left" | sed 's/^/    /' >&2
    exit 1
fi
echo "  clean - no audio files left on this card"

echo "Favourites and deck state:"
# deck-key-lock.json matters more than it looks. It is reapplied on every deck start, so a builder
# who left key lock engaged ships an image whose decks come up key-locked - softened transients,
# and the one-time notice never shown, because that only appears on the press that turns it ON.
# The cost arrives without the explanation. Found on hardware, 2026-10-11, testing that very press.
#
# key-lock-notice.json goes for the same reason: the builder has been told what key lock costs, the
# person who flashes this image has not.
#
# data/ap-password is the builder's password for the box's OWN setup network, and shipping it
# strands people: a fresh box has to be joinable by somebody who has been told nothing, which is
# why an unset password means an OPEN network - see server/provisioning/pidvs-network.sh. Keeping
# the builder's would leave every flashed box behind a password only the builder knows.
rm -f "$BOX_HOME/data/favourites.json" "$BOX_HOME/data/deck-relative-mode.json" \
      "$BOX_HOME/data/deck-key-lock.json" "$BOX_HOME/data/key-lock-notice.json" \
      "$BOX_HOME/data/ap-password" \
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

# --- apt's leftovers -------------------------------------------------------
# Building a card installs 180-odd packages, and apt keeps every .deb it downloaded plus the
# package lists. None of it is needed again - provision.sh runs `apt-get update` before it
# installs anything, so a flashed box refetches what it needs.
#
# Measured 2026-10-12: an image that should have been smaller than its predecessors came out
# 1.3GB against 964MB, and 19.78% of the card was real data. This was never cleaned.
echo "apt caches:"
apt_before="$(du -sm /var/cache/apt /var/lib/apt/lists 2>/dev/null | awk '{t+=$1} END {print t+0}')"
apt-get clean >/dev/null 2>&1 || true
rm -rf /var/lib/apt/lists/* 2>/dev/null || true
apt_after="$(du -sm /var/cache/apt /var/lib/apt/lists 2>/dev/null | awk '{t+=$1} END {print t+0}')"
echo "  reclaimed $((apt_before - apt_after))MB (was ${apt_before}MB)"

# --- Logs and history -------------------------------------------------------
echo "Logs:"
journalctl --rotate >/dev/null 2>&1 || true
journalctl --vacuum-time=1s >/dev/null 2>&1 || true
echo "  vacuumed"

echo "Shell history:"
rm -f "$BOX_HOME/.bash_history" /root/.bash_history 2>/dev/null || true
# Not just bash: anything that records what was typed can hold a network name.
rm -f "$BOX_HOME/.zsh_history" "$BOX_HOME/.lesshst" "$BOX_HOME/.viminfo" \
      "$BOX_HOME/.wget-hsts" "$BOX_HOME/.python_history" \
      /root/.zsh_history /root/.lesshst /root/.viminfo /root/.wget-hsts 2>/dev/null || true
echo "  cleared"

echo "Our own logs in /var/log:"
# prepare-for-imaging.log is the log THIS script is writing into right now - its own trap
# overwrites and removes it at the end, and unlinking it here would leave those blocks intact.
for f in /var/log/pidvs-*.log /var/log/waxcode-*.log; do
    [ -f "$f" ] || continue
    [ "$f" = "/var/log/pidvs-prepare-for-imaging.log" ] && continue
    rm -f "$f"
done
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
