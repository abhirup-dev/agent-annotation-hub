#!/usr/bin/env bash
# Launch/inspect Helium (imput Chromium fork) with the hub's dedicated,
# credential-free profile. Conservative flags only — nothing here disables
# security features or background timer throttling.
#
#   scripts/helium.sh open <url> [url...]   open URL(s) in the hub profile
#   scripts/helium.sh check-updates         open Helium, then use its menu
#   scripts/helium.sh channel stable|beta   switch Helium update channel
#
# Profile: ~/.annotation-hub/helium-profile (isolated from your daily
# profile). First launch with -n creates a fresh instance; later launches
# with the same --user-data-dir are forwarded to that instance by Chromium's
# singleton lock, so repeated `open` calls reuse the hub window.
set -euo pipefail

PROFILE="${ANNOTATION_HUB_HELIUM_PROFILE:-$HOME/.annotation-hub/helium-profile}"
APP="Helium"

cmd="${1:-}"; shift || true

case "$cmd" in
  open)
    [[ $# -ge 1 ]] || { echo "usage: helium.sh open <url> [url...]" >&2; exit 2; }
    mkdir -p "$PROFILE"
    exec open -na "$APP" --args \
      --user-data-dir="$PROFILE" \
      --no-first-run --no-default-browser-check \
      --window-size=1280,900 \
      "$@"
    ;;
  check-updates)
    echo "Opening Helium — then use the Helium menu: Check for Updates (Sparkle)."
    echo "Current builds ship with automatic update checks disabled; this is manual."
    echo "Downloads: helium.computer or github.com/imputnet/helium-macos/releases"
    exec open -a "$APP"
    ;;
  channel)
    ch="${1:-stable}"
    [[ "$ch" == "stable" || "$ch" == "beta" ]] || { echo "channel must be stable|beta" >&2; exit 2; }
    echo "Switching Helium update channel to $ch (also available in chrome://flags)."
    echo "Quit any Helium instance already using $PROFILE first; Chromium forwards launches to an existing profile process and may ignore new flags."
    exec open -na "$APP" --args --user-data-dir="$PROFILE" --helium-update-channel="$ch"
    ;;
  *)
    sed -n '2,14p' "$0" | sed 's/^# \{0,1\}//'
    exit 2
    ;;
esac
