#!/bin/bash
# Builds a working box from a fresh Raspberry Pi OS install.

set -euo pipefail

BOX_USER="${BOX_USER:-waxcode}"
BOX_HOME="/home/$BOX_USER"
HERE="$(cd "$(dirname "$0")" && pwd)"
REPO="$(cd "$HERE/.." && pwd)"
XWAX_SRC="${XWAX_SRC:-$(cd "$REPO/.." 2>/dev/null && pwd)/xwax}"

if [ "$(id -u)" -ne 0 ]; then
    echo "Run with sudo - this installs system units, udev rules and sudoers files." >&2
    exit 1
fi

if ! id "$BOX_USER" >/dev/null 2>&1; then
    echo "No such user '$BOX_USER'. Create it first, or set BOX_USER to the box's own user." >&2
    exit 1
fi

BOX_UID="$(id -u "$BOX_USER")"

# A group of the same name must exist: 50-pidvs-led-permissions.rules chgrps the LED's control files to it
if ! getent group "$BOX_USER" >/dev/null; then
    echo "No group named '$BOX_USER'. The LED permission rule chgrps to it; create it first." >&2
    exit 1
fi

# The first user Raspberry Pi Imager creates already has these.
for g in audio video render input plugdev gpio i2c spi netdev dialout; do
    getent group "$g" >/dev/null || continue
    if ! id -nG "$BOX_USER" | tr " " "\n" | grep -qx "$g"; then
        usermod -aG "$g" "$BOX_USER"
        echo "    added $BOX_USER to $g"
    fi
done

if [ ! -f "$XWAX_SRC/xwax.c" ]; then
    echo "No xwax source at $XWAX_SRC - set XWAX_SRC to this project's FORK (not upstream)." >&2
    echo "It carries --cue-offset, --phono-out and the ARM64 fixes upstream does not have." >&2
    exit 1
fi

echo "=== Provisioning as '$BOX_USER' (uid $BOX_UID) ==="
echo "    repo:  $REPO"
echo "    xwax:  $XWAX_SRC"
echo

# ---------------------------------------------------------------- packages ---
echo "=== Packages ==="
apt-get update -q
apt-get install -y -q \
    build-essential libsdl2-dev libsdl2-ttf-dev libasound2-dev \
    librubberband-dev libsamplerate0-dev libfftw3-dev \
    alsa-utils ffmpeg sox git fonts-dejavu-extra \
    nodejs \
    gdb systemd-coredump \
    `# growpart, for pidvs-expand-rootfs on a card flashed from an image. Raspberry Pi OS resizes` \
    `# with its own init_resize.sh, which an image cannot use, so this is not guaranteed present.` \
    cloud-guest-utils \

# ------------------------------------------------------------- boot config ---
echo
echo "=== Boot config ==="
# Without these the box has no sound card, so this cannot be left to a manual step.
CONFIG=/boot/firmware/config.txt
[ -f "$CONFIG" ] || CONFIG=/boot/config.txt

ensure_config_line() {
    grep -qxF "$1" "$CONFIG" || echo "$1" >> "$CONFIG"
}

if ! grep -q "^# Waxcode DVS" "$CONFIG"; then
    printf '\n# Waxcode DVS - added by pi/provision.sh\n' >> "$CONFIG"
fi
# Rewritten, not just appended: a stock image ships dtparam=audio=on
sed -i 's|^dtparam=audio=on$|dtparam=audio=off|' "$CONFIG"
ensure_config_line "dtparam=audio=off"
ensure_config_line "dtoverlay=hifiberry-dac8x"
ensure_config_line "dtoverlay=nospi10"
ensure_config_line "usb_max_current_enable=1"

# The stock line enables the Pi's own audio through the KMS driver, which would fight the HAT.
sed -i 's|^dtoverlay=vc4-kms-v3d$|dtoverlay=vc4-kms-v3d,noaudio|' "$CONFIG"

echo "    $CONFIG updated - the sound card appears after a reboot, not before."

# ------------------------------------------------------------------- xwax ---
echo
echo "=== Building xwax (this project's fork) ==="
# ALSA=1 explicitly: a bare `make` silently produces a binary with no ALSA support at all
sudo -u "$BOX_USER" make -C "$XWAX_SRC" clean >/dev/null 2>&1 || true
sudo -u "$BOX_USER" make -C "$XWAX_SRC" PREFIX=/usr/local ALSA=1
make -C "$XWAX_SRC" PREFIX=/usr/local ALSA=1 install

# xwax@.service starts ~/bin/xwax, not /usr/local/bin/xwax directly - see that unit's own comment.
install -d -o "$BOX_USER" -g "$BOX_USER" "/home/$BOX_USER/bin"
ln -sfn /usr/local/bin/xwax "/home/$BOX_USER/bin/xwax"
chown -h "$BOX_USER:$BOX_USER" "/home/$BOX_USER/bin/xwax"

# ---------------------------------------------------------------- qmtempo ---
echo
echo "=== Building qmtempo (Queen Mary beat tracker helper) ==="
# The server spawns this once per track analysis - see server/src/beatgrid-qm.js.
QMTEMPO_SRC="${QMTEMPO_SRC:-$REPO/qmtempo}"
if [ -f "$QMTEMPO_SRC/qmtempo.cpp" ]; then
    # Compiled as the box user, installed as root - same split as xwax: a root-owned.build/ in
    # the source tree makes the next ordinary rebuild fail.
    sudo -u "$BOX_USER" make -C "$QMTEMPO_SRC" clean >/dev/null 2>&1 || true
    sudo -u "$BOX_USER" make -C "$QMTEMPO_SRC" PREFIX=/usr/local
    make -C "$QMTEMPO_SRC" PREFIX=/usr/local install
else
    echo "No qmtempo source at $QMTEMPO_SRC - beat grids will fall back to autocorrelation." >&2
fi

# -------------------------------------------------------------- directories ---
echo
echo "=== Directories ==="
for d in data releases updater; do
    install -d -o "$BOX_USER" -g "$BOX_USER" "$BOX_HOME/$d"
done

# The updater ships separately from the release tarball (that carries server/ only)
cp -a "$REPO/updater/." "$BOX_HOME/updater/"
chown -R "$BOX_USER:$BOX_USER" "$BOX_HOME/updater"

# ------------------------------------------------------------------ config ---
# Every file here is written for the development box's own user.
substitute() {
    sed -e "s|__BOX_USER__|$BOX_USER|g" \
        -e "s|/run/user/1000|/run/user/$BOX_UID|g" \
        "$1"
}

echo
echo "=== ALSA ==="
substitute "$HERE/asound.conf" > /etc/asound.conf

echo "=== udev rules ==="
for r in 41-pidvs-cable-presence.rules 50-pidvs-led-permissions.rules 99-pidvs-usb.rules; do
    substitute "$HERE/$r" > "/etc/udev/rules.d/$r"
done
substitute "$HERE/49-pidvs-polkit-xwax-lifecycle.rules" > /etc/polkit-1/rules.d/49-pidvs-xwax-lifecycle.rules
udevadm control --reload-rules
# Reloading alone does not re-apply rules to devices that already exist, and the LED is one of them
udevadm trigger --subsystem-match=leds

echo "=== NetworkManager ==="
install -d /etc/NetworkManager/conf.d
substitute "$HERE/99-pidvs-unmanage-ipheth.conf" > /etc/NetworkManager/conf.d/99-pidvs-unmanage-ipheth.conf
# Read only for connections in `shared` mode, which on this box means the setup hotspot and nothing else
install -d /etc/NetworkManager/dnsmasq-shared.d
substitute "$HERE/dnsmasq-shared-captive.conf" > /etc/NetworkManager/dnsmasq-shared.d/captive.conf

echo "=== Helper scripts ==="
substitute "$HERE/usb-mount.sh" > /usr/local/bin/pidvs-usb-mount.sh
substitute "$HERE/led-booting.sh" > /usr/local/bin/pidvs-led-booting.sh
substitute "$HERE/deck-watchdog.sh" > /usr/local/bin/pidvs-deck-watchdog
substitute "$HERE/../server/provisioning/pidvs-network.sh" > /usr/local/bin/pidvs-network
chmod +x /usr/local/bin/pidvs-usb-mount.sh /usr/local/bin/pidvs-led-booting.sh \
         /usr/local/bin/pidvs-deck-watchdog /usr/local/bin/pidvs-network

echo "=== sudoers ==="
# Validated before installing: a malformed sudoers file can lock the box out of sudo entirely
for f in "$HERE"/pidvs-sudoers-* "$HERE/../server/provisioning/pidvs-network.sudoers"; do
    name="pidvs-$(basename "$f" | sed -e 's/^pidvs-sudoers-//' -e 's/^pidvs-//' -e 's/\.sudoers$//')"
    tmp="$(mktemp)"
    substitute "$f" > "$tmp"
    if visudo -cf "$tmp" >/dev/null; then
        install -m 0440 "$tmp" "/etc/sudoers.d/$name"
    else
        echo "REFUSING to install malformed sudoers file: $f" >&2
        rm -f "$tmp"; exit 1
    fi
    rm -f "$tmp"
done

echo "=== systemd units ==="
for u in pidvs-server.service xwax@.service pidvs-dmix-keeper-playback.service \
         pidvs-dmix-keeper-capture.service pidvs-usb-mount@.service \
         pidvs-boot-recovery.service pidvs-led-booting.service \
         pidvs-deck-watchdog.service; do
    substitute "$HERE/$u" > "/etc/systemd/system/$u"
done
systemctl daemon-reload

# ------------------------------------------------------- recordings volume ---
echo
echo "=== Recording volume ==="
BOX_USER="$BOX_USER" RECORDINGS_GB="${RECORDINGS_GB:-3}" "$HERE/recordings-volume.sh"

# ----------------------------------------------------------------- logging ---
echo
echo "=== Persistent logging ==="
# Raspberry Pi OS ships journald with Storage=auto and NO /var/log/journal
JOURNAL_MAX="${JOURNAL_MAX:-200M}"
if [ -d /var/log/journal ]; then
    echo "    /var/log/journal already present - leaving it alone."
else
    install -d -m 2755 -o root -g systemd-journal /var/log/journal
    echo "    created /var/log/journal"
fi
install -d /etc/systemd/journald.conf.d
cat > /etc/systemd/journald.conf.d/99-pidvs.conf <<EOF
# Installed by provision.sh - see the Persistent logging section there for why.
[Journal]
Storage=persistent
SystemMaxUse=$JOURNAL_MAX
EOF
systemctl restart systemd-journald 2>/dev/null || true
echo "    persistent, capped at $JOURNAL_MAX"

# -------------------------------------------------------------------- swap ---
echo
echo "=== Swap ==="
# Raspberry Pi OS ships zram, which is RAM compressing itself - useful, but it cannot help when the pressure IS RAM.
SWAPFILE=/swapfile
SWAP_MB="${SWAP_MB:-1024}"

if [ -f "$SWAPFILE" ]; then
    echo "    $SWAPFILE already exists ($(du -h "$SWAPFILE" | cut -f1)) - leaving the file alone."
else
    fallocate -l "${SWAP_MB}M" "$SWAPFILE"
    chmod 600 "$SWAPFILE"
    mkswap "$SWAPFILE" >/dev/null
    echo "    ${SWAP_MB}MB created at $SWAPFILE"
fi

# OUTSIDE the branch above, deliberately: a first run that created the file then stopped left the
# box with no swap at boot for ever, because every later run took the "already exists" path.
# Lower priority than zram, so compressed RAM is always used first.
grep -q "^$SWAPFILE " /etc/fstab || echo "$SWAPFILE none swap sw,pri=10 0 0" >> /etc/fstab
if swapon --show=NAME --noheadings 2>/dev/null | grep -qx "$SWAPFILE"; then
    echo "    already swapped on, priority below zram"
elif swapon "$SWAPFILE" 2>/dev/null; then
    echo "    swapped on, priority below zram"
else
    echo "    WARNING: swapon failed - no swap until the next boot" >&2
fi

# ------------------------------------------------------------------ server ---
echo
echo "=== Installing the server ==="
# Through the updater's own activate-file rather than laying out releases/ by hand: that path is tested, and it does the checksum
VERSION="${SERVER_VERSION:-$(node -p "require('$REPO/server/package.json').version" 2>/dev/null || echo '0.0.0')}"
STAGING="$(mktemp -d)"
TARBALL="$STAGING/pidvs-server-v$VERSION.tar.gz"
tar -czf "$TARBALL" -C "$REPO/server" --exclude=./data .
CHECKSUM="$(sha256sum "$TARBALL" | cut -d' ' -f1)"
# activate-file runs as the box user, and mktemp -d under root is mode 700
chown -R "$BOX_USER:$BOX_USER" "$STAGING"

sudo -u "$BOX_USER" PIDVS_HOME="$BOX_HOME" \
    node "$BOX_HOME/updater/cli.js" activate-file "$VERSION" "$TARBALL" "$CHECKSUM"
rm -rf "$STAGING"

# ------------------------------------------------------------------ linger ---
echo
echo "=== User session lingering ==="
# Without this the box cannot update itself.
loginctl enable-linger "$BOX_USER"
echo "    lingering enabled for $BOX_USER ($(loginctl show-user "$BOX_USER" -p Linger))"

echo "=== Enabling services ==="
systemctl enable --now pidvs-dmix-keeper-playback.service pidvs-dmix-keeper-capture.service
systemctl enable pidvs-boot-recovery.service pidvs-led-booting.service
systemctl enable --now pidvs-server.service
# Diagnostics only, and it follows the server's journal, so it starts alongside it.
systemctl enable --now pidvs-deck-watchdog.service

echo
echo "=== Done ==="
# `|| true`: is-active exits non-zero for anything but "active", and under `set -euo pipefail`
# that aborted the script here - taking the mandatory REBOOT instruction below with it. On a
# fresh card the server is EXPECTED to be down until the overlay loads on reboot.
echo "server: $(systemctl is-active pidvs-server.service || true)"
echo "Box user: $BOX_USER   Home: $BOX_HOME"
echo
echo "xwax@N is started on demand by the server, not enabled here - that is deliberate."
echo
echo "REBOOT NOW - the HiFiBerry overlay only takes effect on boot, so until you do:"
echo "  * aplay -l will not show the card"
echo "  * the dmix keepers and any deck will fail to start"
echo
echo "  sudo reboot"
echo
echo "After it comes back: 'aplay -l' should list snd_rpi_hifiberry_dac8x."
echo
echo "Then run ./check-drift.sh to confirm the box matches this repo. A card is only as good as"
echo "the source it was built from, and a fix that only ever lived on the last box will not be here."
