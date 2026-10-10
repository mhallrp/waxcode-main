#!/bin/bash
# Prepares a built box to be captured as a distributable image.
set -euo pipefail

BOX_USER="${BOX_USER:-waxcode}"
BOX_HOME="/home/$BOX_USER"

if [ "$(id -u)" -ne 0 ]; then
    echo "Run with sudo." >&2
    exit 1
fi

# ---------------------------------------------------------------- detach ---
# THIS SCRIPT DELETES THE WIFI IT IS BEING DRIVEN OVER.
if [ "${PIDVS_DETACHED:-}" != "1" ]; then
    LOG=/var/log/pidvs-prepare-for-imaging.log
    echo "Detaching, because this removes the WiFi this session may be running over."
    echo "Follow it with:  tail -f $LOG"
    echo "It is finished when the log says 'Ready to capture'. Then power off."
    PIDVS_DETACHED=1 setsid nohup "$0" "$@" >"$LOG" 2>&1 < /dev/null &
    exit 0
fi

echo "=== Preparing $(hostname) to be captured as an image ==="

# --- everything the single-box prep already handles ---
# WiFi, caches, recordings, logs and history.
if [ -x "$(dirname "$0")/prepare-for-shipping.sh" ]; then
    BOX_USER="$BOX_USER" "$(dirname "$0")/prepare-for-shipping.sh"
fi

echo
echo "=== Image-specific ==="

# --- SSH host keys ----------------------------------------------------------
# Removed WITHOUT regenerating - see this file's own header.
rm -f /etc/ssh/ssh_host_*
if systemctl list-unit-files | grep -q '^regenerate_ssh_host_keys\.service'; then
    systemctl enable regenerate_ssh_host_keys.service >/dev/null 2>&1 || true
    echo "  ssh host keys: removed, regenerate-on-boot enabled"
else
    cat > /etc/systemd/system/pidvs-firstboot-sshkeys.service <<'UNIT'
[Unit]
Description=Generate SSH host keys on first boot
ConditionPathExistsGlob=!/etc/ssh/ssh_host_*_key
Before=ssh.service

[Service]
Type=oneshot
ExecStart=/usr/bin/ssh-keygen -A
RemainAfterExit=yes

[Install]
WantedBy=multi-user.target
UNIT
    systemctl enable pidvs-firstboot-sshkeys.service >/dev/null 2>&1 || true
    echo "  ssh host keys: removed, first-boot generator installed"
fi

# --- the builder's password -------------------------------------------------
# An image carries whatever password the master had, to everyone who flashes it.
HERE_DIR="${HERE_DIR:-$(cd "$(dirname "$0")" && pwd)}"
if [ -f "$HERE_DIR/pidvs-init-account.sh" ]; then
    install -m 755 "$HERE_DIR/pidvs-init-account.sh" /usr/local/sbin/pidvs-init-account
    sed -e "s|__BOX_USER__|$BOX_USER|g" "$HERE_DIR/pidvs-init-account.service" > /etc/systemd/system/pidvs-init-account.service
    chmod 644 /etc/systemd/system/pidvs-init-account.service
    systemctl enable pidvs-init-account.service >/dev/null 2>&1 || true

    # Run it ONCE here so the image itself ships a valid account, then clear the flag so every box re-randomises on its own first boot.
    rm -f /var/lib/pidvs-account-initialised
    if [ -n "${BOX_PASSWORD:-}" ]; then
        # A KNOWN password, supplied by whoever is building the card - never a literal in this repo, and never a default.
        printf '%s:%s\n' "$BOX_USER" "$BOX_PASSWORD" | chpasswd
        chage -d "$(date +%Y-%m-%d)" -E -1 "$BOX_USER" 2>/dev/null || true
        passwd -u "$BOX_USER" >/dev/null 2>&1 || true
        echo "  account: the password you supplied, kept across first boot"
    else
        /usr/local/sbin/pidvs-init-account "$BOX_USER"
        echo "  account: valid in the image, re-randomised on each box's first boot"
    fi
    rm -f /var/lib/pidvs-account-initialised
else
    echo "  account: pidvs-init-account.sh NOT FOUND - this image would not be able to update" >&2
fi

# SSH off by default.
if systemctl disable ssh >/dev/null 2>&1 || systemctl disable sshd >/dev/null 2>&1; then
    echo "  ssh: disabled by default - re-enable in Imager if you want it"
fi

# --- cloud-init: the builder's own credentials ------------------------------ THE BIG ONE.
BOOTFS=/boot/firmware
[ -d "$BOOTFS" ] || BOOTFS=/boot
rm -f "$BOOTFS/user-data" "$BOOTFS/network-config" "$BOOTFS/meta-data"
if [ -f "$BOOTFS/cmdline.txt" ]; then
    sed -i 's/ ds=nocloud;i=[^ ]*//' "$BOOTFS/cmdline.txt"
fi
rm -rf /var/lib/cloud/instances/* /var/lib/cloud/data/* /var/lib/cloud/sem/* /var/lib/cloud/instance
rm -f /var/log/cloud-init.log /var/log/cloud-init-output.log
echo "  cloud-init: config, cache and logs cleared (removes Wi-Fi PSK, password hash, ssh key)"

# --- the box's own identity ------------------------------------------------
# The update-server credential is per box: every card flashed from this image must register itself.
rm -f "$BOX_HOME/data/public-cert.json"
echo "  identity: update credential removed"

# The builder's own PIN and the devices they let past it.
rm -f "$BOX_HOME/data/connection-pin.json" "$BOX_HOME/data/connection-pin-sessions.json"
echo "  connection pin: cleared"

#.txt, not.json.
rm -f "$BOX_HOME/data/box-name.txt" "$BOX_HOME/data/box-name.json"
echo "  box name: cleared"

# --- the password hash ------------------------------------------------------
# Expiring the password leaves the hash in /etc/shadow, which is still a hash to crack.
if ! sed -i "s|^$BOX_USER:[^:]*:|$BOX_USER:!:|" /etc/shadow /etc/shadow- 2>/dev/null; then
    echo "  password: FAILED to clear the hash for $BOX_USER - do NOT publish this image" >&2
    exit 1
fi
echo "  password: hash removed from /etc/shadow"

# --- macOS metadata ---------------------------------------------------------
# A card that has ever been in a Mac carries a Spotlight index.
rm -rf "$BOOTFS/.Spotlight-V100" "$BOOTFS/.fseventsd" "$BOOTFS/.TemporaryItems" "$BOOTFS"/._*

# --- machine id -------------------------------------------------------------
# Cloned machine-ids make every box look identical to systemd and to DHCP.
: > /etc/machine-id
rm -f /var/lib/dbus/machine-id
echo "  machine-id: cleared, regenerates on boot"

# --- filesystem -------------------------------------------------------------
# The image is the size of the card it was captured from, not of the data on it.
HERE_DIR="$(cd "$(dirname "$0")" && pwd)"
if [ -f "$HERE_DIR/pidvs-expand-rootfs.sh" ]; then
    install -m 755 "$HERE_DIR/pidvs-expand-rootfs.sh" /usr/local/sbin/pidvs-expand-rootfs
    install -m 644 "$HERE_DIR/pidvs-expand-rootfs.service" /etc/systemd/system/pidvs-expand-rootfs.service
    systemctl enable pidvs-expand-rootfs.service >/dev/null 2>&1 || true
    # Belt and braces: a stale init= from an earlier attempt would stop the box booting at all.
    sed -i 's| init=/usr/lib/raspi-config/init_resize.sh||' "$BOOTFS/cmdline.txt" 2>/dev/null || true
    echo "  rootfs: expansion service installed, grows to fill the card on first boot"
else
    echo "  rootfs: pidvs-expand-rootfs.sh not found beside this script - the image will NOT expand" >&2
fi

# --- superseded releases ----------------------------------------------------
# Only the running one belongs in an image.
CURRENT="$(readlink -f "$BOX_HOME/releases/current" 2>/dev/null || true)"
if [ -n "$CURRENT" ] && [ -d "$BOX_HOME/releases" ]; then
    freed=0
    for r in "$BOX_HOME"/releases/*/; do
        r="${r%/}"
        [ "$r" = "$CURRENT" ] && continue
        [ -d "$r" ] || continue
        freed=$((freed + $(du -sm "$r" 2>/dev/null | cut -f1)))
        rm -rf "$r"
    done
    echo "  releases: kept $(basename "$CURRENT"), removed the rest (${freed}MB)"
fi

# --- the builder's own source tree -----------------------------------------
# ~/src is how THIS box was provisioned.
if [ -d "$BOX_HOME/src" ]; then
    size="$(du -sh "$BOX_HOME/src" 2>/dev/null | cut -f1)"
    rm -rf "$BOX_HOME/src"
    echo "  removed ~/src ($size) - already built and installed"
fi

# --- free space -------------------------------------------------------------
# Zero-fill, so the captured image compresses to roughly the data on it.
echo "  zero-filling free space (this takes a few minutes)..."
dd if=/dev/zero of=/zero.fill bs=4M status=none || true
rm -f /zero.fill
sync
echo "  done"

echo
echo "=== Ready to capture ==="
echo "Power off NOW - do not let it boot again, or it will regenerate the identity you just cleared:"
echo "  sudo poweroff"
echo
echo "Then take the card to your Mac and run pi/capture-image.sh"
echo
echo "NOT YET VERIFIED, and worth checking before you publish an image: whether Raspberry Pi"
echo "Imager's own username/password settings apply to a CUSTOM image that already has a user."
echo "Imager writes those for the stock image's first-boot service to consume, and this image's"
echo "user already exists. If they do not apply, builders keep the '$BOX_USER' account with the"
echo "expired password above - which works, but the build guide should say so plainly."

