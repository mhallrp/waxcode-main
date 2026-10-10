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

# --- the card's own verdict -------------------------------------------------
# prepare-for-imaging.sh leaves this on the FAT partition because it powers the box off and has no
# other way to report. Read HERE because this is the last moment anything can: the next line
# unmounts the card, and after that the file is only readable by pulling it back out of the image.
# Deleted once read, or it ships inside the image - which is how it went on 2026-10-11.
PART="${DEVICE/rdisk/disk}s1"
BOOT="$("$DISKUTIL" info "$PART" 2>/dev/null | awk -F': *' '/Mount Point/ {print $2; exit}')"
# Mounted here if it is not already. An unmounted boot partition used to make the whole verdict
# block below evaporate - no verdict, no network names, no refusal - and the capture carried on as
# if the card had never been prepped (2026-10-12).
if [ -z "$BOOT" ]; then
    "$DISKUTIL" mount "$PART" >/dev/null 2>&1 || true
    BOOT="$("$DISKUTIL" info "$PART" 2>/dev/null | awk -F': *' '/Mount Point/ {print $2; exit}')"
fi
if [ -n "$BOOT" ] && [ -f "$BOOT/waxcode-prepare-status.txt" ]; then
    echo "--- the card's prep verdict ---"
    sed 's/^/    /' "$BOOT/waxcode-prepare-status.txt"
    echo "-------------------------------"
    # A non-zero exit is a refusal, with ONE narrow exception: prep got all the way through and
    # then failed at its own secret scan, because it had nothing to scan against. Everything it
    # does to the card happened; the only thing missing is the measurement - and that same
    # measurement can be made here, against the password itself, which is strictly no weaker.
    #
    # Deliberately tight. It wants the scan's own words in the log, not merely a non-zero exit,
    # so a card that failed at the zero-fill or the sweep can never take this path.
    UNVERIFIED_ONLY=0
    if grep -q '^secrets: *unverified' "$BOOT/waxcode-prepare-status.txt" \
       && grep -q 'NO SECRETS RECORDED' "$BOOT/waxcode-prepare-status.txt" \
       && grep -q '^  done$' "$BOOT/waxcode-prepare-status.txt"; then
        UNVERIFIED_ONLY=1
    fi
    if ! grep -q '^exit:  *0$' "$BOOT/waxcode-prepare-status.txt"; then
        if [ "$UNVERIFIED_ONLY" -eq 1 ]; then
            echo
            echo "  Prep completed every step, then failed at its own secret scan - it had no"
            echo "  secret to scan against. Nothing else in the run failed; the zero-fills, the"
            echo "  sweep and the identity clearing all reported done."
            echo "  So the scan happens here instead, against the password itself."
        else
            echo "  REFUSING: prep did not finish cleanly on this card." >&2
            exit 1
        fi
    fi
    # The box greps every byte of the card for the REAL wifi secrets, which only it can do - by
    # the time the card reaches this Mac they have been deleted, so there is nothing left to
    # search for. Anything but a plain zero here, "unverified" included, is a refusal.
    SECRETS="$(awk -F': *' '/^secrets:/ {print $2; exit}' "$BOOT/waxcode-prepare-status.txt")"
    # Three outcomes. A plain zero means the box measured the card and found nothing, and that is
    # the end of it. Anything else means the box could not measure it - and rather than refuse a
    # card that may well be fine, the same measurement is offered here, because the one thing the
    # Mac has that the box no longer does is a person who knows the password.
    NEED_MAC_VERIFY=0
    [ "${UNVERIFIED_ONLY:-0}" -eq 1 ] && SECRETS="unverified - the box had no secret to scan for"
    case "$SECRETS" in
        "0 match(es)"*)
            echo "  the box scanned its own card for the real secrets: none found" ;;
        *)
            [ -z "$SECRETS" ] && SECRETS="(this card's prep predates the scan)"
            echo
            echo "  The box did NOT verify this card: $SECRETS" >&2
            echo "  So it has to be verified here instead, against the password itself." >&2
            NEED_MAC_VERIFY=1 ;;
    esac
    # Kept before the file goes: these are the networks prep removed, and the only strings worth
    # scanning the finished image for.
    REMOVED_RAW="$(awk -F': *' '/^removed:/ {print $2; exit}' "$BOOT/waxcode-prepare-status.txt")"
    # Two corrections before this becomes a search pattern.
    #
    # pidvs-setup is the box's OWN access point, named in its own scripts - which are in the image
    # on purpose. Searching for it would refuse every clean image.
    #
    # A netplan-managed profile is called "netplan-<iface>-<SSID>", so the SSID on its own is the
    # string that actually leaks; the profile name would miss it in a log line.
    REMOVED=""
    while IFS= read -r name; do
        [ -n "$name" ] || continue
        [ "$name" = "pidvs-setup" ] && continue
        REMOVED="${REMOVED}${REMOVED:+|}${name}"
        bare="$(printf '%s' "$name" | sed -E 's/^netplan-[^-]+-//')"
        [ "$bare" != "$name" ] && [ -n "$bare" ] && REMOVED="${REMOVED}|${bare}"
    done <<NAMES
$(printf '%s' "$REMOVED_RAW" | tr '|' '\n')
NAMES
    # Overwritten IN PLACE first, then deleted. Deleting alone frees the clusters without clearing
    # them, and this file names the network - which is how two copies of it ended up in an image on
    # 2026-10-12 despite the free-space fill below reporting success. The fill could not reuse those
    # clusters because macOS had not finished freeing them: `rm` then `dd` with no sync between.
    #
    # Writing over the file's own bytes needs no allocator cooperation and no sync to be correct.
    st_size="$(stat -f %z "$BOOT/waxcode-prepare-status.txt" 2>/dev/null || echo 0)"
    if [ "${st_size:-0}" -gt 0 ]; then
        dd if=/dev/zero of="$BOOT/waxcode-prepare-status.txt" bs=1 count="$st_size" \
            conv=notrunc 2>/dev/null || true
        sync
    fi
    # Nothing to verify against, because nothing was ever there. `removed:` is prep's own record of
    # the networks it took off the card; with pidvs-setup - the box's own AP - excluded, an empty
    # list means no network credential was ever written to this card. An ethernet-only build always
    # lands here, and asking for a password that does not exist would be theatre (2026-10-12).
    if [ "${NEED_MAC_VERIFY:-0}" = "1" ] && [ -z "$REMOVED" ]; then
        NEED_MAC_VERIFY=0
        NO_WIFI_EVER=1
        echo
        echo "  No network was ever configured on this card - prep removed only the box's own"
        echo "  access point. There is no wifi secret in existence for it to leak, so there is"
        echo "  nothing to scan for and nothing to type."
    fi

    rm -f "$BOOT/waxcode-prepare-status.txt"
    sync
    # Deleting it frees the blocks without clearing them, and the file names the networks prep
    # removed. The box cannot do this itself - its own fill runs before this file is written.
    # Checked, not attempted. This used to be `status=none 2>/dev/null || true`, which would have
    # reported success for a fill that never wrote a byte - and an un-overwritten FAT partition is
    # precisely how the verdict file, which names the network, survives into an image.
    dd if=/dev/zero of="$BOOT/zero.fill" bs=1m 2>/dev/null || true
    filled="$([ -f "$BOOT/zero.fill" ] && stat -f %z "$BOOT/zero.fill" || echo 0)"
    rm -f "$BOOT/zero.fill"
    sync
    if [ "${filled:-0}" -lt 1048576 ]; then
        echo "  REFUSING: could only write ${filled} bytes of zeros to the boot partition." >&2
        echo "  Its free space still holds the verdict file naming your network. Is the card" >&2
        echo "  mounted read-only, or full?" >&2
        exit 1
    fi
    echo "  verdict read, removed, and its blocks overwritten ($((filled/1048576))MB of zeros)"
else
    # A refusal, not a warning. No verdict means nothing here knows whether the card was prepared,
    # which network it held, or whether the box could verify it - and an image is forever.
    echo "  REFUSING: no prep verdict on this card." >&2
    if [ -z "$BOOT" ]; then
        echo "  Its boot partition would not mount ($PART)." >&2
    else
        echo "  $BOOT holds no waxcode-prepare-status.txt - either prepare-for-imaging.sh has not" >&2
        echo "  run, or an earlier capture already consumed it." >&2
    fi
    echo >&2
    echo "  If this image has already been verified by hand - pi/verify-image.sh - capture is the" >&2
    echo "  wrong tool for it now. Compress what you have:" >&2
    echo "      xz -T0 -9 '$IMG' && xz -t '$XZ' && shasum -a 256 '$XZ'" >&2
    exit 1
fi
# A card that has been in a Mac at all carries these, and they are written on mount, not by prep.
if [ -n "$BOOT" ]; then
    rm -rf "$BOOT/.Spotlight-V100" "$BOOT/.fseventsd" "$BOOT/.TemporaryItems" 2>/dev/null || true
    find "$BOOT" -name '._*' -delete 2>/dev/null || true
    sync
fi

"$DISKUTIL" unmountDisk "$DEVICE" >/dev/null

# Asked here, before the read, so the prompt is not sitting there after fifteen minutes of dd.
# Never echoed, never written to a file, and gone from the shell when this script exits.
if [ "${NEED_MAC_VERIFY:-0}" = "1" ]; then
    echo
    echo "Type the Wi-Fi password this box was built on. It is not shown as you type, it is"
    echo "never written to disk, and only a count of matches is printed."
    printf "Wi-Fi password: "
    read -rs WIFI_SECRET
    echo
    if [ -z "$WIFI_SECRET" ]; then
        echo "  REFUSING: nothing entered, so nothing can be verified." >&2
        exit 1
    fi
fi

# An interruption after the read - a failed scan, a closed terminal - used to cost the whole
# 15GB again. Reused only when the size matches the card exactly, so a leftover image from a
# different card can never be mistaken for this one.
DEV_BYTES="$("$DISKUTIL" info "$DEVICE" 2>/dev/null | awk -F'[()]' '/Disk Size/ {print $2; exit}' | awk '{print $1}')"
IMG_BYTES="$([ -f "$IMG" ] && stat -f %z "$IMG" || echo 0)"
if [ -f "$IMG" ] && [ -n "$DEV_BYTES" ] && [ "$IMG_BYTES" = "$DEV_BYTES" ]; then
    echo "Reusing $IMG - same size as the card, so the read is already done."
    echo "  (delete it to force a fresh read)"
else
    [ -f "$IMG" ] && echo "An image of a DIFFERENT size is in the way: $IMG" >&2 && exit 1
    echo "Copying (Ctrl-T shows progress)..."
    sudo dd if="$DEVICE" of="$IMG" bs=4m status=progress
fi

# --- the gate ---------------------------------------------------------------
# The password FIRST. It is the only check that looks for the secret itself rather than for a
# string that tends to sit near it, and until 2026-10-12 it ran second - so a refusal on the
# network NAME exited the script before the password was ever looked for. Worst thing first.

# The direct measurement, when the box could not make it. Process substitution keeps the password
# out of argv and off the disk - `grep -F -f` reads it from a pipe that exists only in this shell.
if [ "${NEED_MAC_VERIFY:-0}" = "1" ]; then
    echo
    echo "Checking the image for the password itself..."
    pw_hits="$(LC_ALL=C tr -s '\0' '\n' < "$IMG" \
        | LC_ALL=C grep -a -c -F -f <(printf '%s\n' "$WIFI_SECRET") || true)"
    unset WIFI_SECRET
    if [ "${pw_hits:-0}" -ne 0 ]; then
        echo >&2
        echo "  REFUSING: the Wi-Fi password appears $pw_hits time(s) in $(basename "$IMG")." >&2
        echo "  Do NOT publish it. Delete it, zero the card with pi/zero-card.sh, and rebuild:" >&2
        echo "      rm '$IMG'" >&2
        exit 1
    fi
    echo "  clean - the password does not appear anywhere in the image"
fi

# Scanned BEFORE the compress, on purpose. The compress is the slow part, and a gate that runs
# after it makes every miss cost a whole cycle - which is exactly what happened twice on
# 2026-10-11. An .xz is a lossless encoding of this file, so a clean .img IS a clean .xz.
#
# prepare-for-shipping.sh sweeps the box and can pass honestly while the image is still dirty: it
# looks at files, and a deleted file is not a file. On 2026-10-11 an image whose sweep came back
# clean carried the builder's wifi password ten times over, in freed blocks and in the journal.
# Only the finished bytes can answer this, so only the finished bytes are trusted.
#
# Scanned for the NETWORK NAMES prep removed, not for `psk=`. The image contains all of /usr,
# including wpa_supplicant's own packaged files, which carry that string legitimately - a gate that
# refuses a clean image is a gate somebody switches off.
#
# Nulls become newlines first: a 15GB binary stream has lines long enough to exhaust grep and awk,
# which is not a theoretical worry - awk died on exactly this on 2026-10-11. `-s` squeezes runs of
# them into ONE newline: the image is mostly zero-fill, and without it grep spends the scan reading
# billions of empty lines - measured at 28MB/s on 2026-10-12, against 50 with it. LC_ALL=C goes on `tr`
# as well as `grep`: without it tr aborts on the first undecodable byte and the pipeline comes back
# empty, which reads exactly like "clean".
echo
echo "Checking the image for credentials (reads the whole file, a few minutes)..."
if [ -z "${REMOVED:-}" ]; then
    # No names AND a zero from the box's own secret scan is the signature of a card built over
    # ethernet alone - the shape this project moved to on 2026-10-12, so that no wifi credential is
    # ever written to a box that becomes an image. Nothing to scan for because nothing was there,
    # and the box is the thing that says so.
    # A PREFIX match, not equality. The line reads "secrets: 0 match(es) on the raw card", and
    # awk -F': *' hands back everything after the colon - so `= "0 match(es)"` never matched and
    # this refused a perfectly clean card after reading all 15GB of it (2026-10-12). The check
    # above it got this right with a glob; this one did not.
    box_said_zero=0
    case "${SECRETS:-}" in "0 match(es)"*) box_said_zero=1 ;; esac
    if [ "$box_said_zero" = "1" ] || [ "${NO_WIFI_EVER:-0}" = "1" ]; then
        echo "  no network was ever configured on this card, so there is no secret to find."
        hits=0
    else
        echo "  REFUSING: prep recorded no network names, so nothing can be scanned for." >&2
        echo "  A card prepped over wifi always records one. Re-run prepare-for-imaging.sh." >&2
        echo "  To override deliberately, re-run with:" >&2
        echo "      ALLOW_UNSCANNED=1 $0 $DEVICE $VERSION" >&2
        [ "${ALLOW_UNSCANNED:-0}" = "1" ] || exit 1
        hits=0
    fi
else
    echo "  looking for: $REMOVED"
    hits="$(LC_ALL=C tr -s '\0' '\n' < "$IMG" | LC_ALL=C grep -a -c -E "$REMOVED" || true)"
fi
if [ "${hits:-0}" -ne 0 ]; then
    echo >&2
    echo "  REFUSING: $hits match(es) for a removed network in $(basename "$IMG")." >&2
    echo >&2
    # Where, and in what context. Printed because finding this out by hand took three rounds on
    # 2026-10-11, and the answer - which file the bytes belong to - is usually right there in the
    # window. The name itself is masked: it is the thing we are trying not to spread.
    echo "  Context around the first few matches, network name masked:" >&2
    # LC_ALL=C on EVERY stage. Without it each of these aborts on the first undecodable byte and
    # the window comes back empty - the same failure that made the gate itself report 0 matches for
    # anything on 2026-10-11. The second tr makes the binary around a match printable first.
    # NOT -s here, unlike the count above: squeezing shortens the stream, so grep's byte offsets
    # stop matching the image and point at nothing. Slower, and it only runs when something is
    # already wrong.
    #
    # Masked twice over. The SSID is what we searched for; `password:` and `psk=` are what tend to
    # be sitting next to it, and printing those to a terminal is the one thing worse than shipping
    # them. Learned the hard way on 2026-10-12.
    LC_ALL=C tr '\0' '\n' < "$IMG" | LC_ALL=C grep -a -b -m 5 -E "$REMOVED" \
        | LC_ALL=C tr -c '\11\12\40-\176' '.' \
        | LC_ALL=C sed -E "s/($REMOVED)/<REMOVED-SSID>/g" \
        | LC_ALL=C sed -E "s/(password|passwd|psk|pre-shared-key|wep-key[0-9]?)([\"'\''[:space:]:=]+)[^,}[:space:]\"'\'']+/\1\2<MASKED>/gI" \
        | LC_ALL=C cut -c 1-300 | sed 's/^/    /' >&2 || true
    echo >&2
    echo "  The uncompressed image is left in place so it can be examined. Delete it once done:" >&2
    echo "      rm '$IMG'" >&2
    echo >&2
    echo "  Live files name themselves, so check the card BEFORE re-imaging:" >&2
    echo "      sudo grep -rla '<the ssid>' /etc /var /home /root" >&2
    exit 1
fi
echo "  clean - no credential-shaped data in the image"


echo
echo "Compressing - this is the slow part, and it is worth it..."
xz -T0 -9 "$IMG"
# Cheap, and the only thing left that could differ between the bytes that were scanned and the
# bytes that get published.
xz -t "$XZ" && echo "  compressed image verifies"

echo
echo "=== $XZ ==="
ls -lh "$XZ" | awk '{print "    " $5}'
shasum -a 256 "$XZ" | awk '{print "    sha256 " $1}'
echo
echo "Builders select this file in Raspberry Pi Imager under 'Use custom', then set their own"
echo "hostname, user and Wi-Fi in Imager's settings as usual."
