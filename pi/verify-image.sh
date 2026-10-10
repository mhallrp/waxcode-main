#!/bin/bash
# Checks a captured image for the Wi-Fi secrets of the box it came from, on the Mac.
#
# prepare-for-imaging.sh does this on the box, where it can read the password out of the config
# before deleting it. This exists for the case where that did not happen - a card prepped before
# that check existed, or one whose verdict file has already been consumed - because the person at
# the Mac knows the password even when the card no longer does.
#
# Prints counts. Never the secret, never to a file, never into argv.
set -euo pipefail

IMG="${1:-}"
if [ -z "$IMG" ] || [ ! -f "$IMG" ]; then
    echo "usage: $0 <image file>   (.img or .img.xz)" >&2
    exit 1
fi

echo "Verifying $(basename "$IMG")"
echo
printf "Wi-Fi password of the network this box was built on: "
read -rs WIFI_SECRET
echo
[ -n "$WIFI_SECRET" ] || { echo "Nothing entered - nothing can be verified." >&2; exit 1; }

printf "Wi-Fi network NAME (SSID), or blank to skip: "
read -r SSID
echo

# Both patterns in one pass, because reading 15GB twice is the slow way round.
PATTERNS="$(printf '%s\n' "$WIFI_SECRET"; [ -n "$SSID" ] && printf '%s\n' "$SSID")"

case "$IMG" in
    *.xz) READ="xz -dc \"$IMG\"" ;;
    *)    READ="cat \"$IMG\"" ;;
esac

echo "Reading every byte (several minutes)..."
# -s squeezes runs of NULs into one newline - the image is mostly zero-fill, and without it grep
# walks billions of empty lines. LC_ALL=C on BOTH, or tr aborts on the first undecodable byte and
# the pipeline comes back empty, which reads exactly like "clean".
pw_hits="$(eval "$READ" | LC_ALL=C tr -s '\0' '\n' \
    | LC_ALL=C grep -a -c -F -f <(printf '%s\n' "$WIFI_SECRET") || true)"

ssid_hits="n/a"
if [ -n "$SSID" ]; then
    ssid_hits="$(eval "$READ" | LC_ALL=C tr -s '\0' '\n' \
        | LC_ALL=C grep -a -c -F -f <(printf '%s\n' "$SSID") || true)"
fi
unset WIFI_SECRET

echo
echo "  password in the image : ${pw_hits:-0}"
echo "  network name          : ${ssid_hits}"
echo
if [ "${pw_hits:-0}" -ne 0 ]; then
    echo "FAIL - the password is in this image. Do not publish it." >&2
    exit 1
fi
if [ "$ssid_hits" != "n/a" ] && [ "${ssid_hits:-0}" -ne 0 ]; then
    echo "The password is absent, but the network's NAME appears ${ssid_hits} time(s)." >&2
    echo "Not a credential, and not a reason to refuse by itself - your call." >&2
    exit 2
fi
echo "PASS - neither the password nor the network name appears anywhere in this image."
