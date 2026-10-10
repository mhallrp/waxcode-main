#!/bin/bash
# Captures a prepared card into a distributable Waxcode DVS image, on the Mac.
set -euo pipefail

DEVICE="${1:-}"
VERSION="${2:-}"

if [ -z "$DEVICE" ] || [ -z "$VERSION" ]; then
    echo "usage: $0 <raw-device> <version>" >&2
    echo >&2
    echo "Find the device with:  /usr/sbin/diskutil list" >&2
    echo "Use the RAW node (rdiskN, not diskN) - it is many times faster." >&2
    exit 1
fi

case "$DEVICE" in
    /dev/rdisk*) ;;
    /dev/disk*)
        echo "Use the raw node instead: ${DEVICE/disk/rdisk} - buffered reads are far slower." >&2
        exit 1 ;;
    *) echo "Expected a /dev/rdiskN device." >&2; exit 1;;
esac

# Absolute, because /usr/sbin is not on every shell's PATH
DISKUTIL=/usr/sbin/diskutil
[ -x "$DISKUTIL" ] || DISKUTIL="$(command -v diskutil || true)"
[ -n "$DISKUTIL" ] || { echo "Cannot find diskutil." >&2; exit 1; }

OUT_DIR="${OUT_DIR:-$HOME/Desktop}"
IMG="$OUT_DIR/waxcode-dvs-$VERSION.img"
XZ="$IMG.xz"

# Refusing beats overwriting: these take a long time to produce.
[ -e "$XZ" ] && { echo "$XZ already exists - move it or pick another version." >&2; exit 1; }

echo "Reading $DEVICE"
"$DISKUTIL" list "$DEVICE" 2>/dev/null | head -8 || true
echo
echo "This reads the WHOLE card, including free space - prepare-for-imaging.sh zero-fills it"
echo "first so the compressed result stays small."
printf "Continue? [y/N] "
read -r reply
case "$reply" in [yY]*) ;; *) echo "Aborted."; exit 1 ;; esac

"$DISKUTIL" unmountDisk "$DEVICE" >/dev/null

echo "Copying (Ctrl-T shows progress)..."
sudo dd if="$DEVICE" of="$IMG" bs=4m status=progress

echo "Compressing - this is the slow part, and it is worth it..."
xz -T0 -9 "$IMG"

echo
echo "=== $XZ ==="
ls -lh "$XZ" | awk '{print "    " $5}'
shasum -a 256 "$XZ" | awk '{print "    sha256 " $1}'
echo
echo "Builders select this file in Raspberry Pi Imager under 'Use custom', then set their own"
echo "hostname, user and Wi-Fi in Imager's settings as usual."
