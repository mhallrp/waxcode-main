#!/bin/bash
# Creates the fixed-size volume that mix recordings live on.
set -euo pipefail

OWNER="${BOX_USER:-waxcode}"
IMAGE="/home/$OWNER/recordings.img"
MOUNTPOINT="/home/$OWNER/data/recordings"
# Only ever holds ONE recording (see recorder.js), so this is sized for the longest single set anyone would record, not a library.
SIZE_GB="${RECORDINGS_GB:-3}"

if [ -f "$IMAGE" ]; then
    echo "$IMAGE already exists ($(du -h "$IMAGE" | cut -f1)) - leaving it alone."
else
    echo "Creating ${SIZE_GB}GB image at $IMAGE..."
    # fallocate, not dd: reserves the blocks immediately without writing them to the card.
    fallocate -l "${SIZE_GB}G" "$IMAGE"
    # -m 0: no reserved-for-root blocks.
    mkfs.ext4 -q -m 0 -L pidvs-rec "$IMAGE"
    chown "$OWNER:$OWNER" "$IMAGE"
fi

mkdir -p "$MOUNTPOINT"
chown "$OWNER:$OWNER" "$MOUNTPOINT"

# fstab, not a hand-written.mount unit.
UNIT=$(systemd-escape -p --suffix=mount "$MOUNTPOINT")
if [ -f "/etc/systemd/system/$UNIT" ]; then
    echo "Removing the old hand-written mount unit..."
    systemctl disable --now "$UNIT" >/dev/null 2>&1 || true
    rm -f "/etc/systemd/system/$UNIT"
    systemctl daemon-reload
fi

FSTAB_LINE="$IMAGE $MOUNTPOINT ext4 loop,noatime,nofail 0 0"
if grep -qF "$MOUNTPOINT" /etc/fstab; then
    echo "fstab already has an entry for $MOUNTPOINT"
else
    echo "Adding it to /etc/fstab..."
    # nofail: a box whose recording volume is missing should still boot and play records.
    echo "$FSTAB_LINE" >> /etc/fstab
fi

systemctl daemon-reload
mountpoint -q "$MOUNTPOINT" || mount "$MOUNTPOINT"

# Ownership has to be set through the mount, not on the empty directory underneath it.
chown "$OWNER:$OWNER" "$MOUNTPOINT"

echo
df -h "$MOUNTPOINT" | tail -1
