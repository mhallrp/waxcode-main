#!/bin/sh
# pidvs-usb-mount.sh - USB automount + library scan trigger for Pi DVS.

ACTION="$1"
DEVNAME="$2"   # eg. sda1 - FSTYPE is detected here via blkid directly, not trusted from udev (see the "add" branch below).

MOUNT_ROOT="/media/pidvs"
LOCAL_API="http://127.0.0.1:8080"
MOUNT_USER="__BOX_USER__"

# Stable identifier tied to the PHYSICAL port (owner's port 1-4 case labelling), not the kernel's sdX name, which shifts with detection order.
get_port_id() {
    PATH_ID="$ID_PATH"
    if [ -z "$PATH_ID" ]; then
        PATH_ID=$(udevadm info --query=property --name="/dev/$DEVNAME" 2>/dev/null | sed -n 's/^ID_PATH=//p')
    fi
    case "$PATH_ID" in
        platform-xhci-hcd.1-usb-0:1:*) echo "port-1" ;;
        platform-xhci-hcd.1-usb-0:2:*) echo "port-2" ;;
        platform-xhci-hcd.0-usb-0:2:*) echo "port-3" ;;
        platform-xhci-hcd.0-usb-0:1:*) echo "port-4" ;;
        *)
            log "Unrecognised USB topology '$PATH_ID' for $DEVNAME - falling back to kernel device name"
            echo "$DEVNAME"
            ;;
    esac
}

log() {
    logger -t pidvs-usb "$1"
}

# Best-effort human-friendly device name for the app.
get_device_name() {
    LABEL=$(blkid -o value -s LABEL "/dev/$DEVNAME" 2>/dev/null)
    if [ -n "$LABEL" ]; then
        echo "$LABEL"
        return
    fi
    VENDOR=$(udevadm info --query=property --name="/dev/$DEVNAME" 2>/dev/null | sed -n 's/^ID_VENDOR=//p')
    MODEL=$(udevadm info --query=property --name="/dev/$DEVNAME" 2>/dev/null | sed -n 's/^ID_MODEL=//p')
    if [ -n "$VENDOR" ] || [ -n "$MODEL" ]; then
        # udev encodes spaces as underscores in these values.
        echo "$VENDOR $MODEL" | tr '_' ' ' | sed 's/^ *//;s/ *$//'
        return
    fi
    echo "USB Drive"
}

# Escapes a value for safe interpolation into a JSON string - a weird volume label shouldn't be able to break the request body's structure.
json_escape() {
    printf '%s' "$1" | sed 's/\\/\\\\/g; s/"/\\"/g'
}

# POSTs to the local API via systemd-run, same reason as mount/umount above
post_with_retry() {
    URL="$1"
    DATA="$2"
    ATTEMPT=1
    while [ "$ATTEMPT" -le 3 ]; do
        if [ -n "$DATA" ]; then
            HTTP_STATUS=$(systemd-run --quiet --wait --pipe --collect -- \
                curl -s -o /tmp/pidvs-post-response -w "%{http_code}" -X POST "$URL" \
                -H "Content-Type: application/json" -d "$DATA" 2>/tmp/pidvs-post-error)
        else
            HTTP_STATUS=$(systemd-run --quiet --wait --pipe --collect -- \
                curl -s -o /tmp/pidvs-post-response -w "%{http_code}" -X POST "$URL" 2>/tmp/pidvs-post-error)
        fi
        CURL_EXIT=$?
        if [ "$HTTP_STATUS" = "200" ]; then
            return 0
        fi
        ATTEMPT=$((ATTEMPT + 1))
        sleep 1
    done
    log "Failed to POST $URL after 3 attempts (curl exit $CURL_EXIT, HTTP $HTTP_STATUS): $(cat /tmp/pidvs-post-response /tmp/pidvs-post-error 2>/dev/null)"
    return 1
}

# Computed once, used by both branches below.
PORT_ID=$(get_port_id)
MOUNT_POINT="$MOUNT_ROOT/$PORT_ID"

case "$ACTION" in
add)
    # A partitioned whole-disk device: mount its partitions, not the disk itself.
    if [ -n "$(blkid -o value -s PTTYPE "/dev/$DEVNAME" 2>/dev/null)" ]; then
        exit 0
    fi

    # Skip EFI System Partitions (fixed GPT type GUID, never contain music)
    PART_ENTRY_TYPE=$(blkid -p -o value -s PART_ENTRY_TYPE "/dev/$DEVNAME" 2>/dev/null)
    if [ "$PART_ENTRY_TYPE" = "c12a7328-f81f-11d2-ba4b-00a0c93ec93b" ]; then
        log "Skipping /dev/$DEVNAME - EFI System Partition, never contains music"
        exit 0
    fi

    # blkid run directly with a short retry, rather than trusting udev's own ID_FS_TYPE property
    FSTYPE=""
    ATTEMPT=1
    while [ "$ATTEMPT" -le 5 ] && [ -z "$FSTYPE" ]; do
        FSTYPE=$(blkid -o value -s TYPE "/dev/$DEVNAME" 2>/dev/null)
        if [ -z "$FSTYPE" ]; then
            ATTEMPT=$((ATTEMPT + 1))
            sleep 1
        fi
    done

    case "$FSTYPE" in
        vfat|exfat)
            MOUNT_FSTYPE="$FSTYPE"
            ;;
        ntfs)
            # blkid reports plain "ntfs"; the in-kernel driver that actually mounts it is named ntfs3.
            MOUNT_FSTYPE="ntfs3"
            ;;
        hfsplus)
            MOUNT_FSTYPE="hfsplus"
            ;;
        "")
            NAME=$(json_escape "$(get_device_name)")
            log "Could not detect a filesystem on /dev/$DEVNAME after retrying - not mounting"
            post_with_retry "$LOCAL_API/library/error" \
                "{\"device\":\"$PORT_ID\",\"name\":\"$NAME\",\"message\":\"Could not read the storage device's filesystem. Try FAT32, exFAT, NTFS, or HFS+.\"}"
            exit 0
            ;;
        *)
            NAME=$(json_escape "$(get_device_name)")
            log "Unsupported filesystem '$FSTYPE' on /dev/$DEVNAME - not mounting"
            post_with_retry "$LOCAL_API/library/error" \
                "{\"device\":\"$PORT_ID\",\"name\":\"$NAME\",\"message\":\"Storage device uses an unsupported filesystem ($FSTYPE). Try FAT32, exFAT, NTFS, or HFS+.\"}"
            exit 0
            ;;
    esac

    NAME=$(json_escape "$(get_device_name)")

    # The filesystem's own UUID - a stable identity for the STICK itself, unlike $PORT_ID (the physical port).
    VOLUME_ID=$(json_escape "$(blkid -o value -s UUID "/dev/$DEVNAME" 2>/dev/null)")

    # Already mounted, most likely a re-run where the earlier POST to /scan never landed.
    if mountpoint -q "$MOUNT_POINT"; then
        log "/dev/$DEVNAME already mounted at $MOUNT_POINT - re-announcing to Node"
        post_with_retry "$LOCAL_API/scan" "{\"device\":\"$PORT_ID\",\"name\":\"$NAME\",\"path\":\"$MOUNT_POINT\",\"volumeId\":\"$VOLUME_ID\"}"
        exit 0
    fi

    mkdir -p "$MOUNT_POINT"

    if systemd-run --quiet --pipe --wait --collect \
        --description="pidvs USB mount for $DEVNAME" \
        mount -t "$MOUNT_FSTYPE" -o ro,uid="$MOUNT_USER",gid="$MOUNT_USER" "/dev/$DEVNAME" "$MOUNT_POINT" \
        >/tmp/pidvs-mount-error 2>&1; then
        log "Mounted /dev/$DEVNAME ($FSTYPE) at $MOUNT_POINT"
        # /scan responds immediately and scans in the background server-side
        post_with_retry "$LOCAL_API/scan" "{\"device\":\"$PORT_ID\",\"name\":\"$NAME\",\"path\":\"$MOUNT_POINT\",\"volumeId\":\"$VOLUME_ID\"}"
    else
        log "Failed to mount /dev/$DEVNAME ($FSTYPE): $(cat /tmp/pidvs-mount-error 2>/dev/null)"
        rmdir "$MOUNT_POINT" 2>/dev/null
    fi
    ;;
remove)
    if mountpoint -q "$MOUNT_POINT" 2>/dev/null; then
        if systemd-run --quiet --pipe --wait --collect umount "$MOUNT_POINT" >/tmp/pidvs-umount-error 2>&1; then
            log "Unmounted $MOUNT_POINT"
        else
            log "Failed to unmount $MOUNT_POINT: $(cat /tmp/pidvs-umount-error 2>/dev/null)"
        fi
    fi
    rmdir "$MOUNT_POINT" 2>/dev/null
    post_with_retry "$LOCAL_API/library/removed" "{\"device\":\"$PORT_ID\"}"
    ;;
esac
