#!/bin/sh
#
# The box's own wireless management - installed as /usr/local/bin/pidvs-network.
#
# THE RULE THIS SCRIPT EXISTS TO ENFORCE: there is always a way back.
#
# The Pi has one radio and, in the field, no Ethernet and no console. Anything
# that puts the radio into AP mode is therefore one mistake away from a box
# nobody can reach - and two of these are already in other people's flats. So:
#
#   * `ap-up` ARMS A REVERT BEFORE IT CHANGES ANYTHING. If nothing cancels it,
#     the box returns to the network it was on. A hotspot nobody joined is a
#     hotspot that should not still be running an hour later.
#   * `join` keeps the old connection until the new one is proven, and puts the
#     old one back if it is not.
#   * nothing here ever disables the radio or deletes the last known network,
#     with ONE deliberate exception: `forget-all`, which the owner asks for by
#     putting a file on a USB stick. It is allowed to take the box off every
#     network precisely because having none is what raises the setup network -
#     see server/src/wifi-mode.js. The way back is the thing it causes.
#
# AP and station mode do not coexist usefully on this chipset (one channel,
# shared), and they do not need to: the AP is for a box with nowhere to be.
set -eu

IFACE=wlan0
AP_CON=pidvs-setup
# Just the name (owner's call, 2026-10-11). It carried the last four of the Pi's serial so that two
# boxes in one room were not both offering "Waxcode Setup" - which is a real case when building a
# box for somebody else, and the cost of dropping it: you would have to pick one and find out. It
# was judged not worth four characters of noise in front of every owner setting up their only box.
ap_ssid() {
    printf 'Waxcode Setup\n'
}
# Long enough for someone to join, open the page and type a password; short
# enough that a forgotten hotspot fixes itself well within a set.
REVERT_SECONDS=900
REVERT_UNIT=pidvs-network-revert

usage() {
    echo "usage: pidvs-network status|scan|ap-up (psk on stdin, empty = open)|ap-down|join <ssid> (psk on stdin)|forget <ssid>|forget-all" >&2
    exit 64
}

# The connection the box was on before an AP went up, so ap-down and the revert
# both know where to return to. Deliberately a file: the revert runs in its own
# unit, minutes later, with none of this shell's state.
LAST_FILE=/run/pidvs-network-last

active_wifi() {
    nmcli -t -f NAME,TYPE,DEVICE connection show --active \
        | awk -F: -v i="$IFACE" '$2=="802-11-wireless" && $3==i {print $1; exit}'
}

arm_revert() {
    # A cable in the box is a better end condition than any timer: udev maintains
    # /run/pidvs/cable-present on both edges, so pulling the cable ends the AP the moment it
    # happens, and the watcher (server/src/wifi-mode.js) acts on that. A timer on top of it would
    # only drop the network out from under someone still typing their password. The revert is for
    # the other case - an AP raised because the box has no network at all, where nothing physical
    # will ever come along to end it.
    #
    # If the server dies while the AP is up and the cable is then pulled, the AP does outlive it.
    # That is a dead-server problem, not a stranded box: the profile is autoconnect=no (below) and
    # /run is tmpfs, so a power cycle - how an appliance gets fixed - always comes back in station
    # mode.
    [ -e /run/pidvs/cable-present ] && return 0
    # A revert from an earlier attempt may still be armed, or spent and not yet garbage-collected,
    # and `systemd-run --unit=` refuses a name that is already taken. That refusal lands BEFORE the
    # radio is touched and under `set -e`, so ap-up exited 1 with nothing on stdout OR stderr - the
    # server could only report "sudo exited 1". Any ap-up that failed after arming therefore
    # poisoned every retry for the next REVERT_SECONDS. Seen on hardware 2026-10-13: the radio was
    # soft-blocked, the first attempt armed this timer and then failed to raise the AP, and the box
    # could not try again for fifteen minutes - silently.
    disarm_revert
    # systemd-run, not a backgrounded sleep: this has to outlive the shell, the
    # SSH session that started it, and the server being restarted.
    if ! systemd-run --unit="$REVERT_UNIT" --on-active="$REVERT_SECONDS" \
        /usr/local/bin/pidvs-network ap-down >/dev/null 2>&1; then
        # Loud, because the alternative is what we had: a failure with no words anywhere.
        echo "pidvs-network: could not arm the ${REVERT_SECONDS}s revert - not raising the AP" >&2
        return 1
    fi
}

disarm_revert() {
    # Both units, and reset-failed on both: a spent or failed unit holds the name just as firmly as
    # a pending one, and arm_revert is blocked by either.
    systemctl stop "$REVERT_UNIT.timer" "$REVERT_UNIT.service" >/dev/null 2>&1 || true
    systemctl reset-failed "$REVERT_UNIT.timer" "$REVERT_UNIT.service" >/dev/null 2>&1 || true
}

case "${1:-}" in
status)
    printf 'interface=%s\n' "$IFACE"
    printf 'mode=%s\n' "$(nmcli -t -f GENERAL.STATE device show "$IFACE" 2>/dev/null | cut -d: -f2-)"
    printf 'connection=%s\n' "$(active_wifi)"
    printf 'ap=%s\n' "$([ "$(active_wifi)" = "$AP_CON" ] && echo yes || echo no)"
    printf 'ip=%s\n' "$(nmcli -t -f IP4.ADDRESS device show "$IFACE" 2>/dev/null | cut -d: -f2- | head -1)"
    printf 'revert_armed=%s\n' "$(systemctl is-active "$REVERT_UNIT.timer" >/dev/null 2>&1 && echo yes || echo no)"
    ;;

scan)
    # Rescan can fail harmlessly when one is already in flight; the cached list
    # is still worth returning, so this never aborts the caller.
    nmcli device wifi rescan ifname "$IFACE" >/dev/null 2>&1 || true
    # `rescan` returns as soon as it is STARTED, not when results arrive - so listing straight
    # afterwards returns whatever was already known, which right after boot is almost nothing. A
    # first look that does not include your own network is the one that matters most.
    sleep 3
    nmcli -t -f SSID,SIGNAL,SECURITY device wifi list ifname "$IFACE" --rescan no
    ;;

ap-up)
    current="$(active_wifi)"
    [ "$current" = "$AP_CON" ] && { echo "already up" >&2; exit 0; }

    # The password comes in on STDIN, for two separate reasons. The sudoers grant names `ap-up`
    # exactly, with no wildcard, and a box that has already bootstrapped can never be granted a new
    # argument - so an argument was never available here. And a password passed to `sudo` as an
    # argument is written to the journal, which is uploaded in diagnostics bundles; that is how a real
    # PSK leaked on 2026-09-26. stdin is matched by neither sudoers nor the log.
    #
    # An unusable value falls back to the default rather than failing. This must ALWAYS produce a
    # joinable network: an AP that refuses to come up because someone typed a seven-character
    # password is a box nobody can reach, which is far worse than ignoring the edit.
    # Nothing usable means an OPEN network, deliberately - see server/src/ap-password.js. A fresh box
    # has to be joinable by someone who has been told nothing, and the setup page on the other side
    # will not let anyone past it until they set a password. Anything WPA2 would reject (under 8 characters)
    # is treated as nothing rather than failing: an AP that refuses to come up is a box nobody can
    # reach, which is worse than one that is briefly too welcoming.
    IFS= read -r psk 2>/dev/null || psk=""
    [ "${#psk}" -lt 8 ] && psk=""

    # Written BEFORE the radio changes, or the revert has nowhere to go back to.
    printf '%s\n' "$current" > "$LAST_FILE"
    arm_revert

    # Built explicitly rather than with `nmcli device wifi hotspot`, which cannot make an open network:
    # given no password it INVENTS a random one. That is exactly what happened on the first ap-up on
    # real hardware - a network appeared that nobody could join, because the only copy of its password
    # was on a box that had just left the network you would read it over (2026-09-26).
    #
    # Recreated every time, not reused: the profile carries the password, so one changed since the last
    # run would otherwise be silently ignored.
    #
    # autoconnect=no at creation, not patched on afterwards. A hotspot profile defaults to yes, which
    # would mean a box that went into setup mode once offers a setup network at every boot forever with
    # its real network never tried. band=bg keeps it on 2.4GHz, where every phone can see it.
    nmcli connection delete "$AP_CON" >/dev/null 2>&1 || true
    if [ -n "$psk" ]; then
        nmcli connection add type wifi ifname "$IFACE" con-name "$AP_CON" ssid "$(ap_ssid)" \
            autoconnect no 802-11-wireless.mode ap 802-11-wireless.band bg \
            ipv4.method shared ipv6.method ignore \
            wifi-sec.key-mgmt wpa-psk wifi-sec.psk "$psk" >/dev/null
    else
        nmcli connection add type wifi ifname "$IFACE" con-name "$AP_CON" ssid "$(ap_ssid)" \
            autoconnect no 802-11-wireless.mode ap 802-11-wireless.band bg \
            ipv4.method shared ipv6.method ignore >/dev/null
    fi
    nmcli connection up "$AP_CON"
    ;;

ap-down)
    disarm_revert
    nmcli connection down "$AP_CON" >/dev/null 2>&1 || true
    last=""
    [ -f "$LAST_FILE" ] && last="$(cat "$LAST_FILE")"
    if [ -n "$last" ] && [ "$last" != "$AP_CON" ]; then
        nmcli connection up "$last" || true
    fi
    rm -f "$LAST_FILE"
    ;;

join)
    [ $# -ge 2 ] || usage
    ssid="$2"
    # The PSK comes in on STDIN, never as an argument. sudo logs the whole command line, and
    # /proc/<pid>/cmdline is readable by anyone on the box - so a password passed as argv is
    # published twice over. It turned up verbatim in a diagnostics bundle, which is how this was
    # found (2026-09-26).
    IFS= read -r psk || psk=""
    previous="$(active_wifi)"

    # SAVED FIRST, joined second.
    #
    # `nmcli device wifi connect` needs the network to be BROADCASTING at that instant, and an
    # iPhone's Personal Hotspot is not: it sleeps when nothing is connected, and wakes when its
    # settings screen is opened. So the one network somebody most needs to save is the one least
    # likely to be visible while they are typing its password - and the old behaviour then DELETED
    # the profile, leaving nothing behind and no way to try again except by retyping it all.
    #
    # A saved profile with autoconnect costs nothing and waits: NetworkManager joins it the moment
    # the network appears, minutes or days later.
    nmcli connection delete "$ssid" >/dev/null 2>&1 || true
    if [ -n "$psk" ]; then
        nmcli connection add type wifi con-name "$ssid" ifname "$IFACE" ssid "$ssid" \
            wifi-sec.key-mgmt wpa-psk wifi-sec.psk "$psk" connection.autoconnect yes >/dev/null
    else
        nmcli connection add type wifi con-name "$ssid" ifname "$IFACE" ssid "$ssid" \
            connection.autoconnect yes >/dev/null
    fi

    # The AP is torn down only once there is something to go to, and the revert is left armed until
    # the join is proven - so a wrong password cannot strand the box with neither a network nor a
    # way to be told the right one.
    if out="$(nmcli connection up "$ssid" ifname "$IFACE" 2>&1)"; then
        disarm_revert
        rm -f "$LAST_FILE"
        echo "joined $ssid"
    else
        # NetworkManager's own reason code decides whether this profile is worth keeping. (7) is
        # NO_SECRETS - the password is wrong, and a profile that can never work would be retried at
        # every boot forever, so it goes. Anything else is most often (53) SSID_NOT_FOUND, which is
        # not a fault at all: it is a hotspot that is not awake yet, and the profile is the entire
        # point of this change.
        case "$out" in
            *"(7)"*|*Secrets*|*secrets*)
                nmcli connection delete "$ssid" >/dev/null 2>&1 || true
                echo "could not join $ssid: password refused" >&2
                [ -n "$previous" ] && nmcli connection up "$previous" >/dev/null 2>&1 || true
                exit 1
                ;;
            *)
                echo "saved $ssid" >&2
                [ -n "$previous" ] && nmcli connection up "$previous" >/dev/null 2>&1 || true
                # 2, not 1: "saved but not joined" is a different outcome from "refused", and the
                # caller has to be able to tell them apart to say the right thing.
                exit 2
                ;;
        esac
    fi
    ;;

forget)
    [ $# -ge 2 ] || usage
    # Refused when it is the only one left and the box is using it - that is the
    # request that ends with a box nobody can reach.
    remaining="$(nmcli -t -f NAME,TYPE connection show | awk -F: '$2=="802-11-wireless"' | wc -l)"
    if [ "$remaining" -le 1 ] && [ "$(active_wifi)" = "$2" ]; then
        echo "refusing to forget the only network this box can reach" >&2
        exit 1
    fi
    nmcli connection delete "$2"
    ;;

forget-all)
    # Recovery, asked for physically: a file on a USB stick (see server/src/wifi-recovery.js).
    #
    # This is the one path allowed to leave the box with nothing saved, because that is exactly what
    # brings the setup network up - a box with no networks has nowhere to be, and wifi-mode raises
    # the AP for it. `forget` refuses this for a good reason; the difference here is that somebody
    # walked up to the box with a stick, and that there is a known way back.
    #
    # The AP's own profile is left alone: it is not a network this box ever joined, and deleting it
    # while it is up would drop the very connection the owner is about to arrive on.
    nmcli -t -f NAME,TYPE connection show \
        | awk -F: '$2=="802-11-wireless" {print $1}' \
        | while IFS= read -r name; do
            [ -z "$name" ] && continue
            [ "$name" = "$AP_CON" ] && continue
            # Best effort, one at a time: one profile that will not delete must not strand the rest.
            nmcli connection delete "$name" >/dev/null 2>&1 || echo "could not forget: $name" >&2
        done
    ;;

*)
    usage
    ;;
esac
