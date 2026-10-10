#!/bin/sh
# Grow the root partition and filesystem to fill whatever card this is on.
ROOT_DEV=$(findmnt -n -o SOURCE /) || exit 0
case "$ROOT_DEV" in
    /dev/mmcblk*p[0-9]*|/dev/nvme*p[0-9]*)
        DISK="${ROOT_DEV%p*}"; NUM="${ROOT_DEV##*p}" ;;
    /dev/sd[a-z][0-9]*)
        DISK=$(printf "%s" "$ROOT_DEV" | sed "s/[0-9]*$//")
        NUM=$(printf "%s" "$ROOT_DEV" | sed "s/^.*[^0-9]//") ;;
    *)
        echo "pidvs-expand: unrecognised root device $ROOT_DEV, leaving it alone"
        exit 0 ;;
esac

# Checked separately, because a MISSING growpart used to take the same branch as an already-full-size partition
if ! command -v growpart >/dev/null 2>&1; then
    echo "pidvs-expand: growpart is NOT INSTALLED - the card cannot be expanded" >&2
elif growpart "$DISK" "$NUM" 2>&1; then
    echo "pidvs-expand: partition grown"
else
    echo "pidvs-expand: partition already full size"
fi
if resize2fs "$ROOT_DEV" 2>&1; then
    echo "pidvs-expand: filesystem grown"
fi
exit 0
