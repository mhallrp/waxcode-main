#!/usr/bin/env bash
# Captures what a wedged deck was doing, at the moment it wedges.
set -uo pipefail

# The box owner's home, written literally because provision.sh substitutes it
BOX_HOME=/home/__BOX_USER__
DIAG_DIR="${PIDVS_DIAG_DIR:-$BOX_HOME/diagnostics}"
# One capture per deck per cooldown.
COOLDOWN_SECONDS=300

# Captures are pruned oldest-first past EITHER limit.
MAX_CAPTURES=5
MAX_DIAG_MB=250

# --- automatic recovery -------------------------------------------------------------------------
# A wedged deck stays dead until something restarts it.
RECOVERY_ENABLED="${PIDVS_WATCHDOG_RECOVERY:-1}"
# Failures needed inside RECOVERY_WINDOW before acting
RECOVERY_FAILURES=3
RECOVERY_WINDOW=30
# Hard ceiling per deck. Beyond this the watchdog stops trying and says so.
RECOVERY_MAX_PER_HOUR=3
# How the restart is actually performed.
RESTART_CMD="${PIDVS_WATCHDOG_RESTART_CMD:-systemctl restart}"

mkdir -p "$DIAG_DIR"

log() { echo "[deck-watchdog] $*"; }

oldest_capture() {
    find "$DIAG_DIR" -mindepth 1 -maxdepth 1 -type d -printf '%T@ %p\n' 2>/dev/null \
        | sort -n | head -1 | cut -d' ' -f2-
}

prune() {
    local used count oldest

    # By count first, then by size - whichever bites sooner.
    count=$(find "$DIAG_DIR" -mindepth 1 -maxdepth 1 -type d 2>/dev/null | wc -l)
    while [ "$count" -gt "$MAX_CAPTURES" ]; do
        oldest=$(oldest_capture)
        [ -z "$oldest" ] && break
        log "pruning $oldest (keeping the newest $MAX_CAPTURES)"
        rm -rf "$oldest"
        count=$(find "$DIAG_DIR" -mindepth 1 -maxdepth 1 -type d 2>/dev/null | wc -l)
    done

    used=$(du -sm "$DIAG_DIR" 2>/dev/null | cut -f1)
    [ -z "$used" ] && return
    while [ "$used" -gt "$MAX_DIAG_MB" ]; do
        oldest=$(oldest_capture)
        [ -z "$oldest" ] && return
        log "pruning $oldest to stay under ${MAX_DIAG_MB}MB"
        rm -rf "$oldest"
        used=$(du -sm "$DIAG_DIR" 2>/dev/null | cut -f1)
    done
}

# Restarts deck N's xwax, if the fault looks persistent and the budget allows.
recover() {
    local deck="$1"
    local now recent fails budget spent
    now=$(date +%s)

    [ "$RECOVERY_ENABLED" = "1" ] || return

    # Persistent, like the capture cooldown - this service restarts on failure, and a budget held in memory would reset with it
    recent="$DIAG_DIR/.failures-deck$deck"
    echo "$now" >> "$recent"
    # Keep only failures inside the window.
    awk -v cutoff="$(( now - RECOVERY_WINDOW ))" '$1 >= cutoff' "$recent" > "$recent.tmp" 2>/dev/null
    mv -f "$recent.tmp" "$recent"
    fails=$(wc -l < "$recent")
    if [ "$fails" -lt "$RECOVERY_FAILURES" ]; then
        log "deck $deck: $fails failure(s) in ${RECOVERY_WINDOW}s, need $RECOVERY_FAILURES before restarting"
        return
    fi

    budget="$DIAG_DIR/.restarts-deck$deck"
    awk -v cutoff="$(( now - 3600 ))" '$1 >= cutoff' "$budget" > "$budget.tmp" 2>/dev/null
    mv -f "$budget.tmp" "$budget" 2>/dev/null
    spent=$(wc -l < "$budget" 2>/dev/null || echo 0)
    if [ "$spent" -ge "$RECOVERY_MAX_PER_HOUR" ]; then
        log "deck $deck: NOT restarting - already restarted $spent times this hour. Leaving it down deliberately rather than cycling it; this needs a person."
        return
    fi

    echo "$now" >> "$budget"
    log "deck $deck: restarting xwax@$deck (restart $(( spent + 1 )) of $RECOVERY_MAX_PER_HOUR this hour)"
    if $RESTART_CMD "xwax@$deck.service"; then
        log "deck $deck: xwax@$deck restarted - the deck will be empty, reload the track"
        : > "$recent"
    else
        log "deck $deck: xwax@$deck restart FAILED"
    fi
}

capture() {
    local deck="$1" reason="$2"
    local now stamp dir pid marker last
    now=$(date +%s)

    # The cooldown lives on DISK, not in a shell variable.
    marker="$DIAG_DIR/.last-capture-deck$deck"
    last=$(cat "$marker" 2>/dev/null || echo 0)
    if [ $(( now - last )) -lt "$COOLDOWN_SECONDS" ]; then
        log "deck $deck failed again within ${COOLDOWN_SECONDS}s of the last capture - not capturing again"
        return
    fi
    echo "$now" > "$marker"

    stamp=$(date +%Y%m%d-%H%M%S)
    dir="$DIAG_DIR/$stamp-deck$deck"
    mkdir -p "$dir"
    log "capturing deck $deck to $dir ($reason)"

    {
        echo "deck:    $deck"
        echo "when:    $(date -Is)"
        echo "reason:  $reason"
        echo "uptime:  $(uptime -p)"
        echo "release: $(readlink "$BOX_HOME/releases/current" 2>/dev/null)"
        echo "xwax:    $(readlink -f "$BOX_HOME/bin/xwax" 2>/dev/null)"
    } > "$dir/summary.txt"

    pid=$(pgrep -f "xwax-deck$deck.sock" | head -1)
    if [ -z "$pid" ]; then
        echo "no xwax process for deck $deck - it is not running at all" >> "$dir/summary.txt"
    else
        echo "pid:     $pid" >> "$dir/summary.txt"

        # Per-thread state first: cheapest, and on its own it distinguishes "blocked on a lock" from "spinning" from "asleep in poll"
        {
            echo "=== threads ==="
            ps -Lo tid,stat,wchan:32,pcpu,comm -p "$pid" 2>/dev/null
            echo
            for t in /proc/$pid/task/*; do
                echo "--- tid $(basename "$t") ---"
                echo "wchan:  $(cat "$t/wchan" 2>/dev/null)"
                echo "state:  $(awk '{print $3}' "$t/stat" 2>/dev/null)"
                cat "$t/stack" 2>/dev/null || echo "(kernel stack needs root)"
            done
        } > "$dir/threads.txt" 2>&1

        # User-space backtraces.
        timeout 60 gdb -p "$pid" --batch \
            -ex "set pagination off" \
            -ex "thread apply all bt full" \
            > "$dir/backtraces.txt" 2>&1 \
            || echo "(gdb failed or timed out after 60s)" >> "$dir/backtraces.txt"

        # A core keeps everything the two files above only sample.
        timeout 120 gcore -o "$dir/core" "$pid" > "$dir/gcore.log" 2>&1 \
            || echo "(gcore failed or timed out)" >> "$dir/gcore.log"
    fi

    ss -x 2>/dev/null | grep -E "xwax-deck|State" > "$dir/sockets.txt"
    journalctl -u "xwax@$deck" -n 300 --no-pager > "$dir/xwax.log" 2>&1
    journalctl -u pidvs-server -n 300 --no-pager > "$dir/server.log" 2>&1
    {
        echo "=== memory ==="; free -m
        echo; echo "=== load ==="; cat /proc/loadavg
        echo; echo "=== thermal ==="; vcgencmd measure_temp 2>/dev/null; vcgencmd get_throttled 2>/dev/null
        echo; echo "=== alsa ==="
        for s in /proc/asound/card0/pcm*/sub0/status; do echo "--- $s ---"; cat "$s" 2>/dev/null; done
    } > "$dir/system.txt" 2>&1

    log "capture complete: $dir ($(du -sh "$dir" 2>/dev/null | cut -f1))"
    prune
}

# Reading from stdin instead of the journal is how this gets TESTED - a watchdog nobody has ever seen fire is not a watchdog.
if [ "${1:-}" = "--stdin" ]; then
    log "reading failure lines from stdin (test mode), capturing to $DIAG_DIR"
    source_cmd() { cat; }
else
    if [ "$RECOVERY_ENABLED" = "1" ]; then
        log "watching for deck control-socket failures (captures to $DIAG_DIR, then restarts the deck)"
    else
        log "watching for deck control-socket failures (captures to $DIAG_DIR, recovery disabled)"
    fi
    # --since now, so a backlog of old failures in the journal cannot trigger a storm of captures on every boot.
    source_cmd() { journalctl -u pidvs-server -f -n 0 --since now 2>/dev/null; }
fi

source_cmd | while read -r line; do
    case "$line" in
        # What a wedged control socket actually looks like from the server, both shapes seen on 2026-09-16: the connect timing out
        *"timed out connecting to deck"*)
            deck=$(echo "$line" | sed -n "s/.*timed out connecting to deck \([0-9]*\).*/\1/p")
            if [ -n "$deck" ]; then
                capture "$deck" "control socket connect timed out"
                recover "$deck"
            fi
            ;;
        *"connect EAGAIN /tmp/xwax-deck"*)
            deck=$(echo "$line" | sed -n "s|.*xwax-deck\([0-9]*\)\.sock.*|\1|p")
            if [ -n "$deck" ]; then
                capture "$deck" "control socket backlog full (EAGAIN)"
                recover "$deck"
            fi
            ;;
    esac
done
