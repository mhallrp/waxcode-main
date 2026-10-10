#!/bin/bash
# Zeroes a whole SD card on the Mac, BEFORE Raspberry Pi Imager writes to it.
#
# Why this exists, found 2026-10-12: Imager writes a ~3GB image onto a 16GB card and leaves the
# rest of the card exactly as it was. Every byte of the PREVIOUS build survives out there, and
# the new filesystem's free space is made of those bytes. prepare-for-imaging.sh zero-fills from
# inside the running system, which is necessary but not sufficient - it cannot reach ext4's
# root-reserved blocks, and an image captured from such a card carried the builder's wifi
# password, in plaintext, in a cloud-init log six days older than the card.
#
# Three minutes here removes that entire class of problem: a card that starts as zeros cannot
# leak a previous card's anything.
set -euo pipefail

DEVICE="${1:-}"

if [ -z "$DEVICE" ]; then
    echo "usage: $0 <raw-device>" >&2
    echo >&2
    echo "Find it with:  /usr/sbin/diskutil list" >&2
    echo "Use the RAW node (rdiskN, not diskN) - it is many times faster." >&2
    exit 1
fi

case "$DEVICE" in
    /dev/rdisk*) ;;
    /dev/disk*) echo "Use the raw node instead: ${DEVICE/disk/rdisk}" >&2; exit 1 ;;
    *) echo "Expected a /dev/rdiskN device." >&2; exit 1 ;;
esac

DISKUTIL=/usr/sbin/diskutil
[ -x "$DISKUTIL" ] || DISKUTIL="$(command -v diskutil || true)"
[ -n "$DISKUTIL" ] || { echo "Cannot find diskutil." >&2; exit 1; }

# Shown in full, because the one thing this script must never do is zero the wrong disk.
echo "About to ERASE this device completely:"
"$DISKUTIL" list "$DEVICE" 2>/dev/null || { echo "No such device." >&2; exit 1; }
echo
if "$DISKUTIL" info "$DEVICE" 2>/dev/null | grep -q 'Internal:.*Yes'; then
    echo "NOTE: reported as internal - on a Mac an SD slot reads as internal, which is normal." >&2
fi
echo "Everything on it will be gone. There is no undo."
printf "Type ERASE to continue: "
read -r reply
[ "$reply" = "ERASE" ] || { echo "Aborted."; exit 1; }

"$DISKUTIL" unmountDisk "$DEVICE" >/dev/null

echo "Zeroing (Ctrl-T shows progress)..."
# Not /dev/urandom: zeros are what makes the captured image compress, and what makes a leftover
# byte impossible rather than merely unlikely.
sudo dd if=/dev/zero of="$DEVICE" bs=4m status=progress || true
sync

echo
echo "Done. The card is all zeros."
echo "Now write Raspberry Pi OS Lite 64-bit to it with Imager, then run pi/build-card.sh"
