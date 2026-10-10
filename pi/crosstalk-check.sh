#!/usr/bin/env bash
# Measures how much of a deck's LINE output leaks into its PHONO output.
set -euo pipefail

DECK="${1:-1}"
LINE_DEV="dvs_deck${DECK}_line"
CAPTURE_DEV="dvs_record_capture"
SECONDS_EACH=6
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

# These devices sit on the shared dmix/dsnoop layer at 2048/64.
ALSA_BUF=(--buffer-size=2048 --period-size=64)

record() {
  arecord -D "$CAPTURE_DEV" -f S16_LE -r 48000 -c 2 -d "$SECONDS_EACH" "${ALSA_BUF[@]}" "$1" 2>/dev/null
}

peak_dbfs() {
  # sox reports peak as a 0..1 amplitude; convert so the two runs are directly comparable.
  local amplitude
  amplitude="$(sox "$1" -n stat 2>&1 | awk '/Maximum amplitude/ { print $3 }')"
  awk -v a="$amplitude" 'BEGIN { if (a <= 0) print "-inf"; else printf "%.1f", 20 * log(a) / log(10) }'
}

echo "Deck $DECK. Cable the PHONO pair into the record input, then leave the room quiet."
echo

echo "1/2  Noise floor (nothing playing)..."
record "$WORK/floor.wav"
FLOOR="$(peak_dbfs "$WORK/floor.wav")"
echo "     floor: ${FLOOR} dBFS"

echo "2/2  Full-scale 1kHz on the LINE pair only..."
# -1 dBFS rather than 0 so nothing clips on the way out and inflates the result.
sox -n -t alsa "$LINE_DEV" synth "$SECONDS_EACH" sine 1000 gain -1 2>/dev/null &
TONE_PID=$!
sleep 0.5
record "$WORK/bleed.wav"
wait "$TONE_PID" 2>/dev/null || true
BLEED="$(peak_dbfs "$WORK/bleed.wav")"
echo "     with tone: ${BLEED} dBFS"

echo
awk -v f="$FLOOR" -v b="$BLEED" 'BEGIN {
  if (f == "-inf" || b == "-inf") { print "Inconclusive - check the cabling and that the tone played."; exit }
  d = b - f;
  printf "Line tone lifts the phono pair by %.1f dB above its own noise floor.\n\n", d;
  if (d < 3)        print "VERDICT: no measurable crosstalk. Good to ship this layout.";
  else if (d < 12)  print "VERDICT: slight bleed. Probably inaudible once a record is playing, but worth a listen on a big system.";
  else              print "VERDICT: real crosstalk. The mixer phono stage will amplify this - do not ship without shielding or a rethink.";
}'
