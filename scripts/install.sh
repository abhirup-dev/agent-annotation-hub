#!/usr/bin/env bash
# annotation-hub installer.
#
# Explicit, idempotent, reversible. NEVER shadows crit/plannotator binaries.
# Default components touch only user-owned files:
#   hub              user LaunchAgent running the observer on 127.0.0.1:7632
#   crit             set {"no_open": true} in ~/.crit.config.json (merge, reversible)
#   plannotator-env  delimited export block in shell startup files
#   portless         static alias https://annotation-hub.localhost -> 127.0.0.1:7632
#   helium           dedicated credential-free Helium profile + launcher script
#
# Usage:
#   scripts/install.sh [--dry-run] [--all] [--component NAME]... [--port N]
#                      [--shell-file PATH]...
# Without component flags: hub crit plannotator-env
# Compatible with macOS's stock bash 3.2.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LABEL="local.annotation-hub"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
STATE_DIR="$HOME/.annotation-hub/state"
HUB_LOG="$STATE_DIR/hub.log"
ALIAS_NAME="annotation-hub"
HUB_PORT="7632"
BUN_BIN=""
DRY_RUN=0
COMPONENTS=()
SHELL_FILES=()

# bun is provisioned by mise (pinned in the dotfiles repo, config/mise/config.toml).
# Resolve it late and fail with the exact command that fixes it — a missing bun
# otherwise surfaces as a LaunchAgent exiting 78 in a log nobody reads.
need_bun() {
  [[ -n "$BUN_BIN" ]] && return 0
  BUN_BIN="$(command -v bun || true)"
  [[ -n "$BUN_BIN" ]] && return 0
  if command -v mise >/dev/null 2>&1; then
    die "bun not found on PATH, but mise is installed.
    bun is a mise-managed dependency of the hub. Install it with:
      mise install bun            # uses the pin in ~/.config/mise/config.toml
    or, from the dotfiles repo, the task that owns this whole component:
      mise run setup:annotation-hub
    If 'mise install bun' reports no version, the dotfiles pin is missing —
    add   bun = \"<version>\"   to config/mise/config.toml and re-run."
  fi
  die "bun not found on PATH, and mise is not installed either.
    This machine provisions dev tools with mise. Install mise first
    (https://mise.jdx.dev), then:  mise install bun"
}

say()  { printf '%s\n' "$*"; }
note() { printf '    %s\n' "$*"; }
die()  { printf 'install: error: %s\n' "$*" >&2; exit 1; }

usage() { sed -n '2,19p' "$0" | sed 's/^# \{0,1\}//'; exit 2; }

while [[ $# -gt 0 ]]; do
  case "$1" in
    --dry-run) DRY_RUN=1 ;;
    --all) COMPONENTS=(hub crit plannotator-env portless helium) ;;
    --component) [[ -n "${2:-}" ]] || die "--component needs a value"; COMPONENTS+=("$2"); shift ;;
    --port) [[ -n "${2:-}" ]] || die "--port needs a value"; HUB_PORT="$2"; shift ;;
    --shell-file) [[ -n "${2:-}" ]] || die "--shell-file needs a value"; SHELL_FILES+=("$2"); shift ;;
    -h|--help) usage ;;
    *) die "unknown flag: $1 (see --help)" ;;
  esac
  shift
done

[[ "$HUB_PORT" =~ ^[0-9]+$ ]] || die "--port must be numeric"
(( HUB_PORT >= 1 && HUB_PORT <= 65535 )) || die "--port must be within 1..65535"

if [[ ${#COMPONENTS[@]} -eq 0 ]]; then
  COMPONENTS=(hub crit plannotator-env)
fi

DRY_FLAG=()
if (( DRY_RUN )); then DRY_FLAG=(--dry-run); fi

run() { # run <argv...> — respects --dry-run
  if (( DRY_RUN )); then
    say "  [dry-run] $*"
  else
    "$@"
  fi
}

MANAGED_START='# >>> annotation-hub (managed) >>>'
MANAGED_END='# <<< annotation-hub (managed) <<<'

write_env_block() { # $1 = shell file
  local f="$1"
  if (( DRY_RUN )); then say "  [dry-run] append managed block -> $f"; return; fi
  touch "$f"
  if grep -qF "$MANAGED_START" "$f"; then
    say "  already present in $f — skipping"
    return
  fi
  cat >>"$f" <<EOF

$MANAGED_START
# Prevents plannotator from auto-opening a browser in shells that source this
# file (first-party env switch, PLANNOTATOR_SKIP_BROWSER_OPEN=1). New shells
# only; remove with: scripts/uninstall.sh --component plannotator-env
export PLANNOTATOR_SKIP_BROWSER_OPEN=1
$MANAGED_END
EOF
  say "  appended managed block -> $f"
  mkdir -p "$STATE_DIR"
  touch "$STATE_DIR/shell-files.txt"
  grep -qxF "$f" "$STATE_DIR/shell-files.txt" || printf '%s\n' "$f" >>"$STATE_DIR/shell-files.txt"
}

install_hub() {
  say "[hub] user LaunchAgent ($LABEL) on 127.0.0.1:$HUB_PORT"
  need_bun
  if [[ -f "$PLIST" ]] && ! grep -q 'annotation-hub managed' "$PLIST"; then
    die "$PLIST exists and is not managed by annotation-hub — refusing to overwrite."
  fi
  run mkdir -p "$HOME/Library/LaunchAgents" "$STATE_DIR"
  if (( DRY_RUN )); then
    say "  [dry-run] write $PLIST"
    say "  [dry-run] launchctl bootstrap gui/$(id -u) $PLIST"
    return
  fi
  cat >"$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!-- annotation-hub managed -->
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>$BUN_BIN</string>
    <string>run</string>
    <string>$ROOT/src/index.ts</string>
  </array>
  <key>WorkingDirectory</key><string>$ROOT</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>ANNOTATION_HUB_PORT</key><string>$HUB_PORT</string>
    <key>ANNOTATION_HUB_HOST</key><string>127.0.0.1</string>
    <key>PATH</key><string>$HOME/.local/bin:$(dirname "$BUN_BIN"):/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>$HUB_LOG</string>
  <key>StandardErrorPath</key><string>$HUB_LOG</string>
</dict>
</plist>
EOF
  say "  wrote $PLIST"
  if launchctl bootstrap "gui/$(id -u)" "$PLIST" 2>/dev/null; then
    say "  loaded via launchctl bootstrap"
  else
    launchctl unload "$PLIST" 2>/dev/null || true
    launchctl load "$PLIST"
    say "  loaded via launchctl load"
  fi
  note "logs: $HUB_LOG   stop/disable: scripts/uninstall.sh --component hub"
}

install_crit() {
  say "[crit] global no_open (browser auto-open off) via supported config file"
  need_bun
  run "$BUN_BIN" run "$ROOT/scripts/crit-config.ts" set --home "$HOME" ${DRY_FLAG[@]+"${DRY_FLAG[@]}"}
  note "two-level crit config: a project .crit.config.json may re-enable opening"
  note "inside that repo; that stays under the repo owner's control."
}

install_plannotator_env() {
  say "[plannotator-env] PLANNOTATOR_SKIP_BROWSER_OPEN=1 in shell startup files"
  local files=()
  if [[ ${#SHELL_FILES[@]} -gt 0 ]]; then
    files=("${SHELL_FILES[@]}")
  else
    files=("$HOME/.zshrc")
  fi
  for f in "${files[@]}"; do
    write_env_block "$f"
  done
  note "scope: NEW interactive shells that source these files only."
  note "NOT covered: already-running terminals, launchd GUI apps, and most"
  note "agent harnesses. For those, start plannotator with the env explicitly:"
  note "  PLANNOTATOR_SKIP_BROWSER_OPEN=1 plannotator review ..."
}

install_portless() {
  say "[portless] static alias https://$ALIAS_NAME.localhost -> 127.0.0.1:$HUB_PORT"
  if ! command -v portless >/dev/null 2>&1; then
    say "  portless not found — skipping. Install it first (npm i -g portless)."
    return
  fi
  run portless alias "$ALIAS_NAME" "$HUB_PORT" --force
  if (( ! DRY_RUN )); then note "resolved URL: $(portless get "$ALIAS_NAME")"; fi
  note "the alias only resolves while the portless proxy is running; use 'portless get $ALIAS_NAME' for the exact URL (custom proxy ports are included)."
  note "to survive reboots (needs YOUR admin password — run these yourself):"
  note "  sudo portless service install    # launchd service, HTTPS on 443"
  note "  sudo portless trust               # trust local CA (system keychain)"
  note "HTTP-only alternative: sudo portless service install --no-tls"
  note "verify: portless list   health: portless doctor"
}

install_helium() {
  say "[helium] dedicated credential-free profile + launcher"
  run mkdir -p "$HOME/.annotation-hub/helium-profile"
  note "launcher: bash scripts/helium.sh open http://127.0.0.1:$HUB_PORT"
  note "profile dir: ~/.annotation-hub/helium-profile (separate from your daily"
  note "Helium profile; it stores no credentials you don't give it)."
  note "memory: a fresh profile avoids loading daily-profile tabs/extensions —"
  note "modest, workload-dependent savings; no fixed MB claims."
  note "updating Helium is manual (Sparkle auto-check off in current builds):"
  note "  bash scripts/helium.sh check-updates; then Helium menu -> Check for Updates"
  note "channel: quit the hub-profile Helium instance first, then run"
  note "  bash scripts/helium.sh channel stable|beta"
}

seen=" "
for c in ${COMPONENTS[@]+"${COMPONENTS[@]}"}; do
  case " $seen " in *" $c "*) continue ;; esac
  seen="$seen $c"
  case "$c" in
    hub) install_hub ;;
    crit) install_crit ;;
    plannotator-env) install_plannotator_env ;;
    portless) install_portless ;;
    helium) install_helium ;;
    *) die "unknown component: $c (hub|crit|plannotator-env|portless|helium)" ;;
  esac
done

say "done. hub UI: http://127.0.0.1:$HUB_PORT"
