#!/bin/sh
# Builds and copies the app onto a box, for seeing a change on real hardware.
#
#   npm run deploy                 -> waxcodedvs.local
#   npm run deploy 192.168.1.87    -> that address
#
# This is the DEV path. Shipping to someone else's box is a published release
# (waxcode/tools/package-release.js), which picks these files up on its own because they are built
# into server/web/ and a release tarball copies server/ wholesale.
set -eu

BOX="${1:-waxcodedvs.local}"
USER_AT="waxcode@$BOX"
BUILT="../server/web"

echo "Building..."
npm run build

# `readlink current` rather than a fixed version: the box moves on with every update, and a path
# baked in here would silently deploy into a release that is no longer running.
RELEASE="$(ssh -o BatchMode=yes "$USER_AT" 'readlink -f ~/releases/current')"

# Checked before it is used, because the next command deletes a directory built from it. An
# unreadable symlink would otherwise make this `rm -rf /web` on the box.
case "$RELEASE" in
  */releases/*) ;;
  *) echo "Refusing to deploy: 'current' resolved to '$RELEASE', which is not a release." >&2; exit 1 ;;
esac

echo "Copying to $BOX ($RELEASE/web)..."

# Emptied first, not copied over. scp leaves whatever it did not overwrite, so a file this build no
# longer produces would sit there being served - which is exactly how the old vanilla app would have
# kept answering for /app.js long after it stopped existing here.
ssh -o BatchMode=yes "$USER_AT" "rm -rf '$RELEASE/web' && mkdir -p '$RELEASE/web'"
scp -q -r "$BUILT/." "$USER_AT:$RELEASE/web/"

echo "Done - http://$BOX/"
