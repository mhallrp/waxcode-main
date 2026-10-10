#!/bin/bash
# Prepares a built box to be captured as a distributable image.
set -euo pipefail

BOX_USER="${BOX_USER:-waxcode}"
BOX_HOME="/home/$BOX_USER"

if [ "$(id -u)" -ne 0 ]; then
    echo "Run with sudo." >&2
    exit 1
fi

LOG=/var/log/pidvs-prepare-for-imaging.log
BOOTFS=/boot/firmware
[ -d "$BOOTFS" ] || BOOTFS=/boot
STATUS_FILE="$BOOTFS/waxcode-prepare-status.txt"

# ---------------------------------------------------------------- detach ---
# THIS SCRIPT DELETES THE WIFI IT IS BEING DRIVEN OVER.
if [ "${PIDVS_DETACHED:-}" != "1" ]; then
    echo "Detaching, because this removes the WiFi this session may be running over."
    echo "Follow it with:  tail -f $LOG   (only if you have a second route in)"
    echo "Otherwise: wait for the box to power itself off, then read $(basename "$STATUS_FILE")"
    echo "on the card's boot partition - it mounts on any laptop."
    PIDVS_DETACHED=1 setsid nohup "$0" "$@" >"$LOG" 2>&1 < /dev/null &
    exit 0
fi

# ---------------------------------------------------------------- outcome ---
# Reached only by the detached child, which is why the trap is installed here and not above: the
# parent exits deliberately, and a trap on EXIT would power the box off before any work started.
#
# A box with no second route in loses contact the moment prepare-for-shipping.sh deletes the network
# this session is running over, a few lines from here - and on wifi alone, that is every box. So the
# outcome is left somewhere it can still be read: the FAT boot partition, which mounts on whatever
# laptop the card is taken to. Then the box powers itself off, because going quiet is the only
# completion signal left, and a half-prepared card must never be allowed to boot again - booting
# regenerates the identity this script just cleared.
rm -f "$STATUS_FILE"
finish() {
    status=$?
    {
        echo "exit:    $status"
        echo "verdict: $([ "$status" -eq 0 ] && echo 'ready to capture' || echo 'FAILED - do NOT publish this image')"
        echo "when:    $(date -Is 2>/dev/null || date)"
        echo "host:    $(hostname)"
        # Quoted from the log rather than inferred from the exit code. The credential sweep runs
        # early in prepare-for-shipping.sh, so it falls outside the tail below - and it is the one
        # result worth reading on its own, because a leak here ships somebody's wifi password.
        echo "wifi:    $(grep -A1 'Credential sweep:' "$LOG" 2>/dev/null | tail -n 1 | sed 's/^ *//' || echo 'not reported')"
        # Carried out so the Mac can scan the finished image for these exact strings. Names only -
        # never a password - and capture-image.sh deletes this file before it images anything.
        echo "removed: $(sort -u /run/waxcode-removed-ssids 2>/dev/null | paste -sd'|' - || true)"
        # The raw-card secret scan. A count, never the secret. "unverified" means it did not run,
        # which capture-image.sh must treat exactly like a failure.
        echo "secrets: $(cat /run/waxcode-rawscan 2>/dev/null || echo 'unverified') match(es) on the raw card"
        echo
        echo "--- last 30 lines of $LOG ---"
        tail -n 30 "$LOG" 2>/dev/null
    } > "$STATUS_FILE" 2>/dev/null || true
    # This log names every network it removed, and the zero-fill has already run by the time this
    # trap fires - so deleting it would free the blocks without clearing them. Overwritten IN PLACE
    # first, which reuses the same blocks, then removed. Found in an image on 2026-10-11 as the
    # last trace of the builder's network: the name only, never the password.
    if [ -f "$LOG" ]; then
        dd if=/dev/zero of="$LOG" bs=1 count="$(stat -c %s "$LOG" 2>/dev/null || echo 0)" \
            conv=notrunc status=none 2>/dev/null || true
        rm -f "$LOG"
    fi
    sync
    poweroff
}
trap finish EXIT

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
    # NOT "re-enable it in Imager": Imager greys its whole customisation panel out for a custom
    # image, so there is no screen to re-enable anything on. Established on hardware 2026-10-13,
    # after this script had been telling people the opposite for weeks.
    #
    # Which means a card flashed from this image cannot be logged into AT ALL - ssh off, no
    # authorized_keys, no password hash. The setup network is the only way in, and that is why a
    # blocked Wi-Fi radio made the v0.11.0 image unusable rather than merely awkward.
    #
    # An `ssh` file on the boot partition MIGHT work (stock Raspberry Pi OS ships sshswitch.service
    # for exactly that) but it is UNVERIFIED on this image and must not be written down as fact.
    echo "  ssh: disabled - and Imager cannot turn it back on for a custom image."
    echo "       The setup network is the only confirmed way into a card flashed from this."
fi

# --- cloud-init: the builder's own credentials ------------------------------ THE BIG ONE.
rm -f "$BOOTFS/user-data" "$BOOTFS/network-config" "$BOOTFS/meta-data"
# Anything else left on the boot partition by a person rather than by the OS. This partition is the
# one place a Mac can write to a card, so it is where recovery hooks and their logs end up - and a
# log of a recovery names the network it restored. Found shipped in an image, 2026-10-11.
rm -f "$BOOTFS"/waxcode-*.log "$BOOTFS/firstrun.sh" "$BOOTFS"/cmdline.txt.*backup
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
        # `current` is a symlink to one of these directories, and a trailing-slash glob matches a
        # symlink-to-directory exactly like the real thing - so it arrives here as
        # .../releases/current while CURRENT holds the RESOLVED .../releases/vN. They never compare
        # equal, so the old `[ "$r" = "$CURRENT" ]` let the link itself be removed. The release it
        # pointed at survived; the link did not. pidvs-server.service's WorkingDirectory is that
        # link, so the server could not chdir and never started - no HTTP, no Bonjour, and no
        # setup network, because the AP watcher lives in the server. Shipped that way in the
        # v0.11.0 image and caught on its first boot, 2026-10-13.
        [ -L "$r" ] && continue
        [ "$(readlink -f "$r" 2>/dev/null)" = "$CURRENT" ] && continue
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

# --- will this image boot and serve? ---------------------------------------
# Every gate above this line asks what the image must NOT contain. Not one of them would notice an
# image that is spotlessly clean and completely dead - which is exactly what v0.11.0 was: the
# `current` symlink deleted a few lines up, pidvs-server.service unable to chdir to its
# WorkingDirectory, so no UI, no Bonjour, and no setup network either, because the AP watcher lives
# in the server. It passed every secrecy check, was captured, compressed and published. Caught on
# its first boot, 2026-10-13.
#
# Deliberately ahead of the zero-fill and the raw scan: those cost a quarter of an hour between
# them, and there is nothing to be learned by spending it on a card that cannot serve.
echo
echo "Will this image boot and serve?"
boot_fail=0
note_fail() { echo "  BROKEN: $1" >&2; boot_fail=1; }

CURRENT_LINK="$BOX_HOME/releases/current"
if [ ! -L "$CURRENT_LINK" ]; then
    note_fail "$CURRENT_LINK is not a symlink - pidvs-server.service has no WorkingDirectory"
elif [ ! -f "$CURRENT_LINK/src/index.js" ]; then
    note_fail "$CURRENT_LINK -> $(readlink "$CURRENT_LINK") holds no src/index.js"
else
    echo "  ok  releases/current -> $(readlink "$CURRENT_LINK")"
fi

# Points at a resolved vN rather than through `current`, which is why the decks survived today's
# bug. That was luck, not design, so it gets checked too.
# The symlink's EXISTENCE is the thing that matters, not where it currently points.
# pi/enable-ota-xwax.sh deliberately points it at /usr/local/bin/xwax: the indirection is what lets
# a later update repoint it into releases/vN without touching /usr/local, and xwax@.service starts
# this path rather than the real binary. So /usr/local/bin/xwax is the correct state for a card
# that has never taken an xwax update - which every fresh card is. An earlier version of this check
# warned about exactly that and would have cried wolf on every correctly built card.
if [ -L "$BOX_HOME/bin/xwax" ] && [ -x "$BOX_HOME/bin/xwax" ]; then
    echo "  ok  bin/xwax -> $(readlink -f "$BOX_HOME/bin/xwax")"
else
    note_fail "$BOX_HOME/bin/xwax is missing or not a runnable symlink - no deck would start, and
    this box could never take an xwax update either (run pi/enable-ota-xwax.sh)"
fi

# The radio, cleared in prepare-for-shipping.sh. Asked again here because this is the gate that
# stands between a card and a published image, and a blocked radio is invisible until somebody
# flashes it and goes looking for a setup network that cannot exist. /sys, not the `rfkill` tool,
# which is not installed on these cards - see the same note in prepare-for-shipping.sh.
radio_seen=0
for d in /sys/class/rfkill/rfkill*; do
    [ -e "$d/type" ] || continue
    [ "$(cat "$d/type" 2>/dev/null)" = wlan ] || continue
    radio_seen=1
    s="$(cat "$d/soft" 2>/dev/null || echo 1)"; h="$(cat "$d/hard" 2>/dev/null || echo 1)"
    if [ "$s" = "0" ] && [ "$h" = "0" ]; then
        echo "  ok  wifi radio unblocked (soft=0 hard=0)"
    else
        note_fail "the Wi-Fi radio is blocked (soft=$s hard=$h) - no setup network on any box flashed from this"
    fi
done
[ "$radio_seen" = "1" ] || note_fail "no wlan rfkill switch found - the radio cannot be certified"
# The block is restored from here at every boot, so a clean live radio is not enough on its own.
for f in /var/lib/systemd/rfkill/*:wlan; do
    [ -e "$f" ] || continue
    [ "$(cat "$f" 2>/dev/null)" = "0" ] || note_fail "$f would restore a Wi-Fi block on first boot"
done
if grep -qiE '^WirelessEnabled=false' /var/lib/NetworkManager/NetworkManager.state 2>/dev/null; then
    note_fail "NetworkManager.state says WirelessEnabled=false - it is restored on every boot"
fi

if command -v node >/dev/null 2>&1; then
    echo "  ok  node $(node --version 2>/dev/null)"
else
    note_fail "node is not installed - nothing would serve"
fi

# Enabled, not active: this box is mid-teardown, so the only question that matters is what the
# NEXT boot does - on somebody else's card.
for unit in pidvs-server.service pidvs-init-account.service pidvs-expand-rootfs.service \
            pidvs-led-booting.service pidvs-boot-recovery.service; do
    state="$(systemctl is-enabled "$unit" 2>/dev/null || true)"
    case "$state" in
        enabled|enabled-runtime|static|indirect) echo "  ok  $unit ($state)" ;;
        *) note_fail "$unit is '${state:-absent}' - it would not run on a flashed card" ;;
    esac
done

if [ "$boot_fail" -ne 0 ]; then
    echo "  REFUSING: this card would capture to a clean image that does not work." >&2
    echo "  None of it is recoverable here - this card's credentials are already cleared." >&2
    echo "  Fix pi/, build a fresh card, and prep that one." >&2
    exit 1
fi
echo "  this image would come up and serve"

# --- free space -------------------------------------------------------------
# Zero-fill, so the captured image compresses to roughly the data on it - and so that deleted files
# are actually GONE. Deleting a config removes the name, not the bytes, and the bytes are what ends
# up in an image.
# ext4 keeps ~5% of every filesystem back for root. Dropped to zero for the fill and restored
# afterwards by exact block count, not by percentage, so it comes back as it was.
#
# Honest about why: on 2026-12-10 a card had 599MB reserved and 680MB of stale non-zero data left
# in free space, which is suggestive but NOT proof - a root dd holds CAP_SYS_RESOURCE and should be
# able to spend the reserve, and tune2fs on a mounted filesystem may not reach the live mount at
# all. The real defences are zeroing the card before Imager writes it (pi/zero-card.sh) and the
# secret scan at the end of this script, neither of which depends on knowing the mechanism. This
# costs nothing, so it stays.
drop_reserve() {
    local dev="$1"
    [ -n "$dev" ] || return 0
    command -v tune2fs >/dev/null 2>&1 || return 0
    tune2fs -l "$dev" 2>/dev/null | awk -F': *' '/^Reserved block count/{print $2; exit}'
    tune2fs -m 0 "$dev" >/dev/null 2>&1 || true
}
restore_reserve() {
    local dev="$1" blocks="$2"
    [ -n "$dev" ] && [ -n "$blocks" ] || return 0
    command -v tune2fs >/dev/null 2>&1 || return 0
    tune2fs -r "$blocks" "$dev" >/dev/null 2>&1 || true
}

ROOT_DEV="$(findmnt -n -o SOURCE / 2>/dev/null | head -1 || true)"
ROOT_RESERVE="$(drop_reserve "$ROOT_DEV")"
[ -n "$ROOT_RESERVE" ] && echo "  root reserve: ${ROOT_RESERVE} blocks released for the fill"

echo "  zero-filling free space (this takes a few minutes)..."
dd if=/dev/zero of=/zero.fill bs=4M status=none || true
rm -f /zero.fill
sync
restore_reserve "$ROOT_DEV" "$ROOT_RESERVE"
[ -n "$ROOT_RESERVE" ] && echo "  root reserve: restored to ${ROOT_RESERVE} blocks"
# The BOOT partition, which the fill above never touches - it is a different filesystem, mounted
# elsewhere, and it is where Raspberry Pi Imager writes network-config with the wifi password in
# plaintext. Deleting that file removes the name and leaves every byte. Four of the five traces in
# the 2026-10-11 image were here, two of them the password itself.
if mountpoint -q "$BOOTFS" 2>/dev/null || [ -d "$BOOTFS" ]; then
    dd if=/dev/zero of="$BOOTFS/zero.fill" bs=1M status=none || true
    rm -f "$BOOTFS/zero.fill"
    sync
    echo "  boot partition: free space zeroed"
fi

# The recordings volume is its own filesystem inside a loop file, so the fill above never enters it.
# A deleted mix is the owner's, and it leaves the same way their wifi password does.
if mountpoint -q "$BOX_HOME/data/recordings" 2>/dev/null; then
    REC_DEV="$(findmnt -n -o SOURCE "$BOX_HOME/data/recordings" 2>/dev/null | head -1 || true)"
    REC_RESERVE="$(drop_reserve "$REC_DEV")"
    dd if=/dev/zero of="$BOX_HOME/data/recordings/.zero.fill" bs=4M status=none || true
    rm -f "$BOX_HOME/data/recordings/.zero.fill"
    sync
    restore_reserve "$REC_DEV" "$REC_RESERVE"
    echo "  recordings volume: free space zeroed too"
fi
# --- swap, AFTER the fill ---------------------------------------------------
# A live swapfile is not free space, so the fill above cannot reach a byte of it - and anything
# that has been in memory can be sitting in it.
#
# Order matters, and it was wrong until 2026-10-12: this used to run BEFORE the fill and switch
# swap back on, so the fill - 6GB of dd on a box with 1GB of RAM - promptly swapped and re-dirtied
# every byte that had just been cleaned. Left OFF now. /etc/fstab enables it at the next boot,
# which is the flashed box's first boot, and this box is about to power off for good.
if [ -f /swapfile ]; then
    swap_mb="$(( $(stat -c %s /swapfile) / 1024 / 1024 ))"
    swapoff /swapfile 2>/dev/null || true
    dd if=/dev/zero of=/swapfile bs=1M count="$swap_mb" conv=notrunc status=none || true
    chmod 600 /swapfile
    mkswap /swapfile >/dev/null 2>&1 || true
    echo "  swap: ${swap_mb}MB overwritten, remade, and left off until the next boot"
fi

echo "  done"

# --- the only check that measures the thing itself -------------------------
# Everything upstream of here is a proxy: files deleted, sweeps passed, SSID names scanned for.
# This greps every byte of the card for the ACTUAL secrets, held in RAM by prepare-for-shipping.sh
# and never written to disk. It runs here because this is the last moment the card can be read as
# a whole, and after the zero-fill, so it sees exactly what the image will contain.
#
# Added 2026-10-12. An image passed an SSID-name scan while carrying the wifi password in
# plaintext, in a cloud-init log left behind by a card built six days earlier.
echo
echo "Secret scan of the raw card (reads every byte, several minutes):"
DISK_DEV=""
if [ -n "${ROOT_DEV:-}" ]; then
    pk="$(lsblk -no pkname "$ROOT_DEV" 2>/dev/null | head -1 || true)"
    [ -n "$pk" ] && [ -b "/dev/$pk" ] && DISK_DEV="/dev/$pk"
fi
if [ ! -s /run/waxcode-secrets ]; then
    # Tell the two apart. A card built over ethernet alone never had a wifi secret, and failing
    # that build would teach whoever hits it to switch the check off.
    # pidvs-setup is the box's OWN access point, not a network anyone gave it credentials for -
    # and plugging in ethernet is exactly what brings it up, so an ethernet-only build always has
    # one. Counting it as "this card had wifi" made prep refuse a card that never held a secret
    # (2026-10-12). Its own AP password is cleared separately, in prepare-for-shipping.sh.
    if [ "$(grep -v '^pidvs-setup$' /run/waxcode-removed-ssids 2>/dev/null | grep -c . || true)" -eq 0 ]; then
        echo "  no wifi was ever configured on this card - there is no secret to look for"
        printf '0\n' > /run/waxcode-rawscan
    else
        echo "  NO SECRETS RECORDED, but this card HAD wifi - the scan cannot run." >&2
        echo "  That leaves the capture unverified, which is a refusal, not a warning." >&2
        echo "unverified" > /run/waxcode-rawscan
        exit 1
    fi
elif [ -z "$DISK_DEV" ]; then
    echo "  CANNOT FIND THE WHOLE-DISK DEVICE for $ROOT_DEV - scan not run." >&2
    echo "unverified" > /run/waxcode-rawscan
    exit 1
else
    # -s squeezes runs of NULs into one newline: the card is mostly zero-fill by now, and without
    # it grep walks billions of empty lines. LC_ALL=C on BOTH, or tr aborts on the first
    # undecodable byte and the pipeline comes back empty - which reads exactly like "clean".
    leaks="$(LC_ALL=C tr -s '\0' '\n' < "$DISK_DEV" | LC_ALL=C grep -a -c -F -f /run/waxcode-secrets || true)"
    leaks="${leaks:-0}"
    printf '%s\n' "$leaks" > /run/waxcode-rawscan
    if [ "$leaks" -ne 0 ]; then
        echo "  FAILED: $leaks place(s) on this card still hold a real wifi secret." >&2
        echo "  Do NOT capture this card. Zero it with pi/zero-card.sh and build again." >&2
        exit 1
    fi
    echo "  clean - no real secret anywhere on the card ($(grep -c . /run/waxcode-secrets) pattern(s) searched)"
fi

echo
echo "=== Ready to capture ==="
echo "Powering off now, from the EXIT trap at the top of this script - deliberately, and not"
echo "something to undo. Letting this box boot again would regenerate the machine-id, the ssh host"
echo "keys and the update credential it has just spent five minutes clearing."
echo
echo "Then take the card to your Mac and run pi/capture-image.sh"
echo
echo "SETTLED 2026-10-13, and it is worse than the open question this used to describe:"
echo "Raspberry Pi Imager greys its customisation panel out ENTIRELY for a custom image, so there"
echo "is no hostname, user, password or Wi-Fi to apply - the fields cannot even be reached. A card"
echo "flashed from this image therefore has no login of any kind, and its setup network is the only"
echo "way in. Test that every time before publishing: flash a card, cold-boot it, and confirm"
echo "'Waxcode Setup' appears unaided. An image that cannot do that is not awkward, it is unusable."
echo
echo "To offer flash-time Wi-Fi and hostname, Imager needs an os_list.json manifest declaring"
echo "init_format (cloudinit-rpi suits this image - cloud-init and cc_raspberry_pi are both"
echo "present). Not done yet; the setup network is the shipped path."

