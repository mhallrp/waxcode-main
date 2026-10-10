#!/bin/sh
# Give the box account a random password on first boot, once.
[ -e /var/lib/pidvs-account-initialised ] && exit 0

BOX_USER="${1:-waxcode}"

# Field 2 of `passwd -S`: P = usable hash, L = locked, NP = none at all.
PASSWORD_STATUS="$(passwd -S "$BOX_USER" 2>/dev/null | awk '{print $2}')"
if [ "$PASSWORD_STATUS" = "P" ]; then
  echo "pidvs-init-account: $BOX_USER already has a usable password - leaving it alone"
else
  printf '%s:%s\n' "$BOX_USER" "$(head -c 32 /dev/urandom | base64 | tr -d '\n')" | chpasswd
  echo "pidvs-init-account: $BOX_USER given a random password so its systemd user manager can start"
fi

# Always, whichever branch ran: the "must change at next login" flag and an account expiry each make PAM refuse the session on their own
chage -d "$(date +%Y-%m-%d)" -E -1 "$BOX_USER" 2>/dev/null || true
passwd -u "$BOX_USER" >/dev/null 2>&1 || true

mkdir -p /var/lib
touch /var/lib/pidvs-account-initialised
