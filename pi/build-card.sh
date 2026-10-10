#!/bin/bash
# Builds a complete, verified box from a freshly imaged card - one command, from the Mac.

set -euo pipefail

TARGET="${1:-}"
ASSUME_YES=0
[ "${2:-}" = "--yes" ] && ASSUME_YES=1

if [ -z "$TARGET" ]; then
    echo "usage: $0 <user@host> [--yes]" >&2
    exit 1
fi

BOX_USER="${TARGET%@*}"
BOX_HOST="${TARGET#*@}"
HERE="$(cd "$(dirname "$0")" && pwd)"
REPO="$(cd "$HERE/.." && pwd)"
PARENT="$(cd "$REPO/.." && pwd)"
XWAX="$PARENT/xwax"
DEST="\$HOME/src"

RED=$'\033[31m'; GREEN=$'\033[32m'; YELLOW=$'\033[33m'; DIM=$'\033[2m'; OFF=$'\033[0m'
ok()   { echo "  ${GREEN}ok${OFF}       $*"; }
warn() { echo "  ${YELLOW}warn${OFF}     $*"; }
die()  { echo "  ${RED}FAIL${OFF}     $*" >&2; exit 1; }
step() { echo; echo "${DIM}---${OFF} $* ${DIM}---${OFF}"; }

# ------------------------------------------------------------------ preflight ---
step "Preflight"

[ -f "$XWAX/xwax.c" ] || die "no xwax fork at $XWAX - it must sit beside this repo"
[ -f "$XWAX/riaa.c" ] || die "$XWAX looks like UPSTREAM xwax, not this project's fork"
ok "xwax fork present"

# A card is only as good as the source it is built from, so say plainly what that source is.
for r in "$REPO" "$XWAX"; do
    name="$(basename "$r")"
    if git -C "$r" rev-parse --git-dir >/dev/null 2>&1; then
        branch="$(git -C "$r" rev-parse --abbrev-ref HEAD)"
        dirty="$(git -C "$r" status --porcelain | wc -l | tr -d ' ')"
        # rev-list --count, not a `log | wc -l` pipeline: @{u} fails outright on a branch with no
        # upstream, and under pipefail the pipeline both printed its own 0 AND fired the fallback.
        ahead="$(git -C "$r" rev-list --count '@{u}..HEAD' 2>/dev/null || echo 0)"
        [ "$dirty" = 0 ] || warn "$name has $dirty uncommitted file(s) - they WILL be built into this card"
        [ "$ahead" = 0 ] || warn "$name has $ahead unpushed commit(s) - fine, but they exist only here"
        ok "$name on $branch"
    else
        warn "$name is not a git checkout - cannot tell you what is being built"
    fi
done

# The box never runs npm: the server's dependencies reach it only inside server/node_modules.
if [ -d "$REPO/server/node_modules" ]; then
    ok "server dependencies present ($(ls "$REPO/server/node_modules" | wc -l | tr -d ' ') packages)"
else
    warn "server/node_modules missing - installing now (the box cannot do this itself)"
    ( cd "$REPO/server" && npm install --silent ) || die "npm install failed"
    ok "server dependencies installed"
fi

# Pure JS matters: these are copied from macOS to Linux as-is, never rebuilt.
natives="$(find "$REPO/server/node_modules" -name '*.node' 2>/dev/null | wc -l | tr -d ' ')"
[ "$natives" = 0 ] || die "$natives native binaries in server/node_modules - a macOS build cannot run on the box"

# Key auth specifically, not just reachability.
if ssh -o ConnectTimeout=10 -o BatchMode=yes "$TARGET" true 2>/dev/null; then
    ok "$TARGET reachable (key auth)"
elif nc -z -G 5 "$BOX_HOST" 22 2>/dev/null; then
    # Distinguish the two reasons the probe above can fail. A freshly flashed card regenerates its
    # host keys, so the FIRST build after a flash hits this - and reporting it as "key auth is not
    # set up" sends you to ssh-copy-id, which is not the problem.
    ssh_err="$(ssh -o ConnectTimeout=10 -o BatchMode=yes "$TARGET" true 2>&1 || true)"
    case "$ssh_err" in
        *"REMOTE HOST IDENTIFICATION HAS CHANGED"*|*"host key for"*"has changed"*|*"Host key verification failed"*)
            echo "  ${RED}FAIL${OFF}     $BOX_HOST's SSH host key has changed." >&2
            echo "           Normal after flashing a card - it generated new host keys." >&2
            echo >&2
            echo "           Clear the old one, then re-run:" >&2
            echo "               ssh-keygen -R $BOX_HOST" >&2
            ;;
        *)
            echo "  ${RED}FAIL${OFF}     $BOX_HOST answers on port 22, but key auth is not set up." >&2
            echo "           This script makes many SSH calls; password auth would prompt for every one." >&2
            echo >&2
            echo "           Fix it once, then re-run:" >&2
            echo "               ssh-copy-id $TARGET" >&2
            echo >&2
            echo "           (Raspberry Pi Imager can also install your public key at flash time, under" >&2
            echo "            Services -> SSH -> 'Allow public-key authentication only'.)" >&2
            ;;
    esac
    exit 1
else
    die "cannot reach $BOX_HOST at all. Is the Pi powered on and on this network?
           mDNS has been unreliable on these boxes - try the IP instead of a .local name.
           Find it with:  for i in \$(seq 1 254); do (nc -z -G 1 192.168.1.\$i 22 && echo 192.168.1.\$i) & done; wait"
fi

eval "$(ssh "$TARGET" '
    echo "REMOTE_ARCH=$(uname -m)"
    echo "REMOTE_USER_OK=$(id -u '"$BOX_USER"' >/dev/null 2>&1 && echo yes || echo no)"
    echo "REMOTE_GROUP_OK=$(getent group '"$BOX_USER"' >/dev/null && echo yes || echo no)"
    echo "REMOTE_MODEL=\"$(tr -d "\0" < /proc/device-tree/model 2>/dev/null || echo unknown)\""
')"
[ "$REMOTE_USER_OK" = yes ]  || die "no user '$BOX_USER' on the box - create it first"
# 50-pidvs-led-permissions.rules chgrps the LED to this group; a failed chgrp leaves it unwritable.
[ "$REMOTE_GROUP_OK" = yes ] || die "no group '$BOX_USER' on the box - provision.sh requires one"
ok "box user and group exist"
ok "$REMOTE_MODEL ($REMOTE_ARCH)"

if ssh "$TARGET" 'test -f /etc/systemd/system/pidvs-server.service' 2>/dev/null; then
    warn "this box is ALREADY provisioned - re-running is safe and will update it in place"
fi

# ------------------------------------------------------------------- confirm ---
echo
echo "About to build ${BOX_HOST} as '${BOX_USER}':"
echo "    source      $REPO"
echo "                $XWAX"
echo "    recordings  ${RECORDINGS_GB:-3}GB     swap ${SWAP_MB:-1024}MB"
echo "    server ver  $(node -p "require('$REPO/server/package.json').version" 2>/dev/null || echo '?') ${DIM}(repo's own - deliberately not overridden)${OFF}"
echo
echo "This installs system units, udev rules and sudoers files, and reboots the box."
if [ "$ASSUME_YES" -ne 1 ]; then
    printf "Continue? [y/N] "
    read -r reply
    case "$reply" in [yY]*) ;; *) echo "Aborted."; exit 1 ;; esac
fi

# -------------------------------------------------------------------- deploy ---
step "Copying source to the box"
"$HERE/deploy-to-box.sh" "$TARGET"

# ----------------------------------------------------------------- provision ---
# SERVER_VERSION is deliberately NOT passed.
step "Provisioning (you will be asked for the box's sudo password)"
ssh -t "$TARGET" "cd $DEST/waxcode/pi && sudo BOX_USER='$BOX_USER' \
    RECORDINGS_GB='${RECORDINGS_GB:-3}' SWAP_MB='${SWAP_MB:-1024}' ./provision.sh" \
    || die "provisioning failed - fix the error above and re-run; it is idempotent"

# -------------------------------------------------------------------- reboot ---
# Not optional: the HiFiBerry overlay is only applied at boot.
step "Rebooting (the HiFiBerry overlay only takes effect on boot)"
ssh "$TARGET" 'sudo systemctl reboot' 2>/dev/null || true

echo -n "  waiting for $BOX_HOST to come back"
# Give it a moment to actually go down first, or the first probe succeeds against the dying box.
sleep 10
deadline=$(( SECONDS + 180 ))
until ssh -o ConnectTimeout=5 -o BatchMode=yes "$TARGET" true 2>/dev/null; do
    [ "$SECONDS" -lt "$deadline" ] || { echo; die "box did not come back within 3 minutes"; }
    echo -n "."
    sleep 5
done
echo
ok "back up after $(ssh "$TARGET" 'uptime -p' 2>/dev/null || echo 'a reboot')"

# ------------------------------------------------------------- OTA bootstrap ---
# Without this a card works, then silently ignores the xwax half of every update.
step "Bootstrapping over-the-air xwax"
"$HERE/enable-ota-xwax.sh" "$TARGET"

# -------------------------------------------------------------------- verify ---
step "Verifying"

if ssh "$TARGET" 'aplay -l 2>/dev/null | grep -q hifiberry'; then
    ok "sound card present (snd_rpi_hifiberry_dac8x)"
else
    die "no HiFiBerry card in 'aplay -l' - check the HAT is seated and the overlay applied"
fi

# Checked, not assumed: a card that looks perfect but points at /usr/local/bin/xwax is the
# silent failure this build exists to prevent.
exec_line="$(ssh "$TARGET" 'systemctl cat xwax@.service 2>/dev/null | grep -m1 ^ExecStart=' || true)"
case "$exec_line" in
    *"/home/$BOX_USER/bin/xwax"*) ok "xwax@.service starts the updater-owned symlink";;
    "") die "no xwax@.service on the box - the OTA bootstrap did not run" ;;
    *) die "xwax@.service starts ${exec_line#ExecStart=}, not ~/bin/xwax - updates could never replace the engine";;
esac
ssh "$TARGET" 'test -x ~/bin/xwax' 2>/dev/null \
    && ok "~/bin/xwax resolves to a runnable binary" \
    || die "~/bin/xwax is missing or not executable - decks would not start"

for s in pidvs-server pidvs-dmix-keeper-playback pidvs-dmix-keeper-capture; do
    state="$(ssh "$TARGET" "systemctl is-active $s.service" 2>/dev/null || true)"
    [ "$state" = active ] && ok "$s active" || die "$s is '$state'"
done

echo
echo "${DIM}  running check-drift.sh...${OFF}"
if ssh -t "$TARGET" "cd $DEST/waxcode/pi && sudo ./check-drift.sh" ; then
    DRIFT_OK=1
else
    DRIFT_OK=0
fi

# ---------------------------------------------------------------------- done ---
echo
if [ "$DRIFT_OK" -eq 1 ]; then
    echo "${GREEN}=== Card built and verified ===${OFF}"
else
    echo "${RED}=== Card built, but check-drift.sh reported drift (above) ===${OFF}"
    echo "Something on this box does not match the repo. Fix it in pi/ - not on the box - and re-run."
fi
echo
echo "Next, by hand:"
echo "  * open waxcodedvs.local, load a track, check BOTH decks"
echo "  * set the box's password"
echo "  * if more than one box shares a network, confirm the hostname is unique"
echo
echo "Before it goes to anyone else:"
echo "  ssh $TARGET 'cd $DEST/waxcode/pi && sudo ./prepare-for-shipping.sh'"
[ "$DRIFT_OK" -eq 1 ] || exit 1
