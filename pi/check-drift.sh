#!/bin/bash
# Reports where the running box differs from this repo - the tracked source a fresh SD card is built from.

set -uo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
REPO="$(cd "$HERE/.." && pwd)"
BOX_USER="${BOX_USER:-${SUDO_USER:-$(id -un)}}"
BOX_UID="$(id -u "$BOX_USER" 2>/dev/null || echo 1000)"
IS_ROOT=0; [ "$(id -u)" -eq 0 ] && IS_ROOT=1

DRIFT=0
SKIPPED=0

red()  { printf '\033[31m%s\033[0m\n' "$1"; }
green(){ printf '\033[32m%s\033[0m\n' "$1"; }
dim()  { printf '\033[2m%s\033[0m\n' "$1"; }

# Identical to provision.sh's own substitution - the comparison is only meaningful against the text provision.sh would actually have written.
substitute() {
    sed -e "s|__BOX_USER__|$BOX_USER|g" \
        -e "s|/run/user/1000|/run/user/$BOX_UID|g" \
        "$1"
}

# compare <source-in-repo> <installed-path> [needs-root]
compare() {
    local src="$HERE/$1" dst="$2" needs_root="${3:-0}"

    if [ ! -f "$src" ]; then
        red   "  MISSING FROM REPO  $1"; DRIFT=1; return
    fi
    if [ "$needs_root" = 1 ] && [ "$IS_ROOT" -ne 1 ]; then
        dim   "  skipped (needs root)  $dst"; SKIPPED=$((SKIPPED+1)); return
    fi
    if [ ! -e "$dst" ]; then
        red   "  NOT INSTALLED      $dst"; DRIFT=1; return
    fi

    if diff -q <(substitute "$src") "$dst" >/dev/null 2>&1; then
        green "  ok                 $dst"
    else
        red   "  DIFFERS            $dst"
        diff -u <(substitute "$src") "$dst" | sed -n '3,40p' | sed 's/^/      /'
        DRIFT=1
    fi
}

echo "=== Box vs repo ==="
echo "    repo: $REPO"
echo "    user: $BOX_USER (uid $BOX_UID)"
[ "$IS_ROOT" -eq 1 ] || dim "    not root - sudoers and polkit checks will be skipped"
echo

echo "--- ALSA ---"
compare asound.conf /etc/asound.conf

echo "--- udev ---"
for r in 41-pidvs-cable-presence.rules 50-pidvs-led-permissions.rules 99-pidvs-usb.rules; do
    compare "$r" "/etc/udev/rules.d/$r"
done
compare 49-pidvs-polkit-xwax-lifecycle.rules /etc/polkit-1/rules.d/49-pidvs-xwax-lifecycle.rules 1

echo "--- NetworkManager ---"
compare 99-pidvs-unmanage-ipheth.conf /etc/NetworkManager/conf.d/99-pidvs-unmanage-ipheth.conf
compare dnsmasq-shared-captive.conf /etc/NetworkManager/dnsmasq-shared.d/captive.conf

echo "--- helper scripts ---"
compare usb-mount.sh   /usr/local/bin/pidvs-usb-mount.sh
compare led-booting.sh /usr/local/bin/pidvs-led-booting.sh
compare deck-watchdog.sh /usr/local/bin/pidvs-deck-watchdog
compare ../server/provisioning/pidvs-network.sh /usr/local/bin/pidvs-network

echo "--- sudoers ---"
compare ../server/provisioning/pidvs-network.sudoers /etc/sudoers.d/pidvs-network 1
for f in "$HERE"/pidvs-sudoers-*; do
    [ -e "$f" ] || continue
    base="$(basename "$f")"
    compare "$base" "/etc/sudoers.d/pidvs-${base#pidvs-sudoers-}" 1
done

echo "--- systemd units ---"
for u in pidvs-server.service xwax@.service pidvs-dmix-keeper-playback.service \
         pidvs-dmix-keeper-capture.service pidvs-usb-mount@.service \
         pidvs-boot-recovery.service pidvs-led-booting.service \
         pidvs-deck-watchdog.service; do
    compare "$u" "/etc/systemd/system/$u"
done

# ------------------------------------------------------------------ coverage ---
# Catches the other half: a file added to pi/ but never installed on the box.
echo
echo "--- coverage ---"
# Files in pi/ that are TOOLS rather than artefacts
NOT_INSTALLED="provision.sh check-drift.sh deploy-to-box.sh build-card.sh prepare-for-shipping.sh prepare-for-imaging.sh capture-image.sh crosstalk-check.sh recordings-volume.sh enable-ota-xwax.sh"
for f in "$HERE"/*; do
    base="$(basename "$f")"
    case " $NOT_INSTALLED " in *" $base "*) continue ;; esac
    # The sudoers files are installed by a glob, so their names never appear literally.
    if [ "${base#pidvs-sudoers-}" != "$base" ] || grep -qF "$base" "$HERE/provision.sh"; then
        green "  installed by provision.sh  $base"
    # Some things only an IMAGE needs: expanding the rootfs onto a card of unknown size, and giving the account a usable password.
    elif grep -qF "$base" "$HERE/prepare-for-imaging.sh"; then
        green "  installed for images       $base"
    else
        red   "  NOT IN provision.sh        $base"
        echo  "            ^ if this is a TOOL rather than something the box needs installed,"
        echo  "              add it to NOT_INSTALLED at the top of this section."
        DRIFT=1
    fi
done

# ------------------------------------------------------------- dependencies ---
# Content and coverage compare files; this compares installed packages.
echo
echo "--- required binaries ---"
for b in ffmpeg ffprobe sox node; do
    if command -v "$b" >/dev/null 2>&1; then
        green "  ok        $b"
    else
        red   "  MISSING   $b"; DRIFT=1
    fi
done
# Deliberately NOT required, and listed so their absence is never mistaken for a real gap: aubio: the beat-grid modules spawn it
for b in aubio keyfinder-cli; do
    command -v "$b" >/dev/null 2>&1 \
        && dim "  present   $b (not used in production - harmless)" \
        || dim "  absent    $b (expected - not used in production)"
done

# --------------------------------------------------------------- boot config ---
echo
echo "--- boot config ---"
CONFIG=/boot/firmware/config.txt
[ -f "$CONFIG" ] || CONFIG=/boot/config.txt
for line in dtparam=audio=off dtoverlay=hifiberry-dac8x dtoverlay=nospi10 usb_max_current_enable=1; do
    if grep -qxF "$line" "$CONFIG" 2>/dev/null; then
        green "  ok        $line"
    else
        red   "  ABSENT    $line   ($CONFIG)"; DRIFT=1
    fi
done
if grep -qxF "dtparam=audio=on" "$CONFIG" 2>/dev/null; then
    red "  STILL PRESENT  dtparam=audio=on - fights the HAT for card 0"; DRIFT=1
fi

# ----------------------------------------------------------------- packages ---
# Build-time libraries xwax links against.
echo
echo "--- packages ---"
for pkg in libasound2-dev librubberband-dev libsamplerate0-dev libfftw3-dev libsdl2-dev libsdl2-ttf-dev; do
    if dpkg-query -W -f='${Status}' "$pkg" 2>/dev/null | grep -q "install ok installed"; then
        green "  ok        $pkg"
    else
        red   "  MISSING   $pkg - xwax will not rebuild correctly without it"; DRIFT=1
    fi
done

# --------------------------------------------------------------- xwax link ---
# ~/bin/xwax is how an update swaps the audio engine without touching /usr/local.
echo
echo "--- xwax link ---"
# The BOX USER's home, not $HOME - this script is run under sudo for the sudoers and polkit checks
BOX_HOME=$(eval echo "~${SUDO_USER:-$USER}")
if [ -L "$BOX_HOME/bin/xwax" ] && [ -x "$BOX_HOME/bin/xwax" ]; then
    green "  ok        $BOX_HOME/bin/xwax -> $(readlink -f "$BOX_HOME/bin/xwax")"
else
    red "  MISSING   $BOX_HOME/bin/xwax - this box cannot receive xwax updates; run pi/enable-ota-xwax.sh"
    DRIFT=1
fi

# ------------------------------------------------------------------ services ---
echo
echo "--- services ---"
for s in pidvs-server pidvs-dmix-keeper-playback pidvs-dmix-keeper-capture pidvs-deck-watchdog; do
    state="$(systemctl is-active "$s.service" 2>/dev/null)"
    [ "$state" = active ] && green "  active    $s" || { red "  $state  $s"; DRIFT=1; }
done
for s in pidvs-boot-recovery pidvs-led-booting; do
    state="$(systemctl is-enabled "$s.service" 2>/dev/null)"
    [ "$state" = enabled ] && green "  enabled   $s" || { red "  $state  $s"; DRIFT=1; }
done

# --------------------------------------------------------------- logging ---
# Persistent journald, so a crash survives the reboot that follows it.
echo
echo "--- logging ---"
if [ -d /var/log/journal ]; then
    green "  ok        /var/log/journal (persistent)"
else
    red "  MISSING   /var/log/journal - logs are volatile and will not survive a reboot"
    DRIFT=1
fi
if [ -f /etc/systemd/journald.conf.d/99-pidvs.conf ]; then
    green "  ok        /etc/systemd/journald.conf.d/99-pidvs.conf"
else
    red "  MISSING   /etc/systemd/journald.conf.d/99-pidvs.conf (journal size is uncapped)"
    DRIFT=1
fi

# ---------------------------------------------------------------------- xwax ---
# The fork, built with ALSA.
echo
echo "--- xwax ---"
if BIN="$(command -v xwax)"; then
    if grep -qa "alsa" "$BIN"; then green "  ok        $BIN (ALSA present)"
    else red "  NO ALSA   $BIN - rebuilt without ALSA=1"; DRIFT=1; fi
    if [ -f "$REPO/../xwax/xwax.c" ] && [ "$REPO/../xwax/xwax.c" -nt "$BIN" ]; then
        red "  STALE     source is newer than the installed binary"; DRIFT=1
    fi
else
    red "  NOT FOUND xwax is not on PATH"; DRIFT=1
fi

echo
[ "$SKIPPED" -gt 0 ] && dim "$SKIPPED check(s) skipped - re-run with sudo to include them"
if [ "$DRIFT" -eq 0 ]; then
    green "=== No drift. The box matches the repo. ==="
else
    red   "=== Drift found. Write it back into pi/ before building another card. ==="
fi
exit "$DRIFT"
