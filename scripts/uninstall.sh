#!/usr/bin/env bash
# annotation-hub uninstaller — reverses only what install.sh owns.
#   scripts/uninstall.sh [--dry-run] [--all] [--component NAME]... [--purge-data]
# Default (no component flags): hub crit plannotator-env portless
# --purge-data also removes ~/.annotation-hub entirely (hub state, logs, the
# dedicated Helium profile). Never touches other user settings or registries.
# Compatible with macOS's stock bash 3.2.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LABEL="local.annotation-hub"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
STATE_DIR="$HOME/.annotation-hub/state"
ALIAS_NAME="annotation-hub"
DRY_RUN=0
PURGE=0
COMPONENTS=()

say()  { printf '%s\n' "$*"; }
note() { printf '    %s\n' "$*"; }
die()  { printf 'uninstall: error: %s\n' "$*" >&2; exit 1; }

while [[ $# -gt 0 ]]; do
  case "$1" in
    --dry-run) DRY_RUN=1 ;;
    --all) COMPONENTS=(hub crit plannotator-env portless helium) ;;
    --component) [[ -n "${2:-}" ]] || die "--component needs a value"; COMPONENTS+=("$2"); shift ;;
    --purge-data) PURGE=1 ;;
    -h|--help) sed -n '2,7p' "$0" | sed 's/^# \{0,1\}//'; exit 2 ;;
    *) die "unknown flag: $1 (see --help)" ;;
  esac
  shift
done

if [[ ${#COMPONENTS[@]} -eq 0 ]]; then
  COMPONENTS=(hub crit plannotator-env portless)
fi
if (( PURGE )); then
  COMPONENTS+=(helium)
fi

DRY_FLAG=()
if (( DRY_RUN )); then DRY_FLAG=(--dry-run); fi

run() {
  if (( DRY_RUN )); then say "  [dry-run] $*"; else "$@"; fi
}

MANAGED_START='# >>> annotation-hub (managed) >>>'
MANAGED_END='# <<< annotation-hub (managed) <<<'

strip_env_block() { # $1 = shell file
  local f="$1"
  [[ -f "$f" ]] || return 0
  if (( DRY_RUN )); then
    if grep -qF "$MANAGED_START" "$f"; then say "  [dry-run] strip managed block from $f"; fi
    return
  fi
  if ! grep -qF "$MANAGED_START" "$f"; then say "  no managed block in $f"; return; fi
  awk -v start="$MANAGED_START" -v end="$MANAGED_END" '
    $0 == start { inblk = 1 }
    !inblk { print }
    $0 == end { inblk = 0 }
  ' "$f" > "$f.annotation-hub.tmp" && mv "$f.annotation-hub.tmp" "$f"
  say "  stripped managed block from $f"
}

uninstall_hub() {
  say "[hub] stop + remove LaunchAgent ($LABEL)"
  if [[ -f "$PLIST" ]] && ! grep -q 'annotation-hub managed' "$PLIST"; then
    die "$PLIST is not managed by annotation-hub — refusing to touch it."
  fi
  if (( DRY_RUN )); then
    say "  [dry-run] launchctl bootout gui/$(id -u)/$LABEL"
    say "  [dry-run] rm -f $PLIST"
    return
  fi
  launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || launchctl unload "$PLIST" 2>/dev/null || true
  rm -f "$PLIST"
  say "  stopped and removed $PLIST"
}

uninstall_crit() {
  say "[crit] restore prior no_open state (only if we changed it)"
  local bun_bin
  bun_bin="$(command -v bun || true)"
  if [[ -z "$bun_bin" ]]; then
    say "  bun not found — restore manually: bun run scripts/crit-config.ts restore"
    return
  fi
  run "$bun_bin" run "$ROOT/scripts/crit-config.ts" restore --home "$HOME" ${DRY_FLAG[@]+"${DRY_FLAG[@]}"}
}

uninstall_plannotator_env() {
  say "[plannotator-env] remove managed shell blocks"
  local files=()
  local f
  if [[ -f "$STATE_DIR/shell-files.txt" ]]; then
    while IFS= read -r f; do
      [[ -n "$f" ]] && files+=("$f")
    done < "$STATE_DIR/shell-files.txt"
  fi
  [[ -f "$HOME/.zshrc" ]] && files+=("$HOME/.zshrc")
  if [[ ${#files[@]} -eq 0 ]]; then
    say "  nothing recorded — nothing to strip"
    return
  fi
  for f in "${files[@]}"; do strip_env_block "$f"; done
  run rm -f "$STATE_DIR/shell-files.txt"
}

uninstall_portless() {
  say "[portless] remove static alias $ALIAS_NAME"
  if ! command -v portless >/dev/null 2>&1; then
    say "  portless not found — skipping"
    return
  fi
  run portless alias --remove "$ALIAS_NAME" || say "  (alias was not present)"
  note "system-level pieces (service, CA trust, /etc/hosts), if you installed"
  note "them manually, are removed by: sudo portless clean"
}

uninstall_helium() {
  say "[helium] launcher script lives in this repo; profile data stays unless --purge-data"
  if (( PURGE )); then
    say "  removing ~/.annotation-hub (state, logs, dedicated Helium profile)"
    run rm -rf "$HOME/.annotation-hub"
  fi
}

seen=" "
for c in ${COMPONENTS[@]+"${COMPONENTS[@]}"}; do
  case " $seen " in *" $c "*) continue ;; esac
  seen="$seen $c"
  case "$c" in
    hub) uninstall_hub ;;
    crit) uninstall_crit ;;
    plannotator-env) uninstall_plannotator_env ;;
    portless) uninstall_portless ;;
    helium) uninstall_helium ;;
    *) die "unknown component: $c (hub|crit|plannotator-env|portless|helium)" ;;
  esac
done

say "done."
