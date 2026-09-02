# Agent Annotation Hub

A tiny **observer** service for macOS that lists every live
[Crit](https://github.com/tomasz-tomczyk/crit) and
[Plannotator](https://github.com/backnotprop/plannotator) annotation session on
your machine, in one loopback-only web UI.

- **Metadata-first.** Never launches, wraps, or shadows `crit` / `plannotator`, and never reads review text. Session termination is available only through an explicit, confirmed UI action.
- **Loopback-only.** Binds `127.0.0.1:7632`; any discovered URL that is not
  loopback is never exposed as a link.
- **No runtime dependencies** beyond [Bun](https://bun.sh) and standard macOS
  CLIs (`lsof`, `ps`, `git`). No build step — the UI is embedded.
- **Table-first explorer.** Sortable tool/kind/repository/branch/CWD/PID/parent-PID/comment/round/time columns plus composable filters and batch open/close. The prior vertical-list UI remains available through **List (classic)**.
- **Launch-aware semantics.** Distinguishes code/PR/range/plan/story reviews, artifact/folder/web/last-message annotations, and live-web/HTML review surfaces from registry metadata and live process argv—without reading reviewed content.

```
┌────────────┐  reads (read-only)   ┌──────────────────────────────┐
│            │◄─────────────────────│ ~/.crit/sessions/<key>.json  │  crit 0.19.0
│  agent-    │◄─────────────────────│ ~/.plannotator/sessions/     │  plannotator 0.27.8
│ annotation │                      │        <pid>.json            │
│    hub     │  validates           └──────────────────────────────┘
│            │  · PID alive?               │ missing metadata only
│  Bun/TS    │  · port loopback?            ▼
│  127.0.0.1 │  · daemon /health       lsof (cwd) · git (branch,
│    :7632   │  · prune dead PIDs          worktree) · ps (origin
└─────┬──────┘                              heuristic)
      │ GET /  /api/sessions  /api/health
      ▼
   hub UI (auto-refresh ~2s, click = new tab)
```

## Quick start

```bash
bun run src/index.ts
# Agent Annotation Hub (observer)
#   listening   http://127.0.0.1:7632   (loopback only)
```

Start any session elsewhere (`crit …`, `plannotator …`) and it appears in the
UI within ~2 seconds. Env overrides: `ANNOTATION_HUB_PORT`,
`ANNOTATION_HUB_HOST` (must be loopback), `ANNOTATION_HUB_POLL_MS`.

## Architecture

| File | Role |
|---|---|
| `src/critsource.ts` | Reads `~/.crit/sessions/*.json` (verified Crit 0.19.0 schema, including optional `public_url`). Tolerant of corrupt files, missing dir, unknown shapes. |
| `src/plannotatorsource.ts` | Resolves the Plannotator data dir (`PLANNOTATOR_DATA_DIR` → existing `~/.plannotator` → `$XDG_DATA_HOME/plannotator` → `~/.plannotator`) and reads `sessions/<pid>.json` (verified 0.27.8 schema). |
| `src/classify.ts` | Pure, tested launch-metadata classifier for coarse `category`, fine `kind`, and target. Crit uses registry args; Plannotator is refined with its live process command. |
| `src/hub.ts` | ~2s poll loop: read registries → drop dead PIDs (view-only pruning) → sanitize URLs to loopback → enrich (lsof cwd, git repository/branch/worktree with TTL cache, launch classification, origin heuristic) → probe daemon health with a short-timeout fetch. |
| `src/proc.ts` | `kill -0` liveness, `lsof -a -p <pid> -d cwd -Fn` cwd recovery, `ps` ancestor walk. All spawns use **argv arrays**, never shell strings. |
| `src/loopback.ts` | Strict numeric PID/port parsing; only `localhost` / `127.0.0.0/8` / `::1` URLs survive sanitization. |
| `src/navigation.ts` | Tested browser-route policy: Crit rendered HTML uses `/preview`, Crit proxied apps use `/live`, all other Crit surfaces use `/`; Plannotator's registry URL is authoritative and remains unchanged. |
| `src/server.ts` | `Bun.serve` on loopback. Routes below. |
| `src/ui.ts` | Single embedded HTML page (no build, no external assets). |

### Poll semantics

- **Source of truth is the supported per-user registries** (the same files the
  tools themselves maintain), *not* scraped CLI output.
- An entry is shown only while its recorded PID is alive. When the daemon
  exits, it disappears on the next poll. Registry files themselves are never
  written or deleted by the hub (the tools manage their own lifecycle).
- Daemon health is probed read-only (`GET /api/health` for crit; `GET /` for
  plannotator) with an 800 ms timeout. An unreachable daemon is still listed,
  with a red dot.
- `firstSeenAt` (when the hub first observed the session) is preserved across
  polls; `startedAt` comes from the tool's registry.

## API

- `GET /api/sessions` — all live sessions:

```json
{
  "generatedAt": "2026-08-24T16:40:00.000Z",
  "pollIntervalMs": 2000,
  "count": 2,
  "sessions": [
    {
      "id": "crit:958431b24524",
      "tool": "crit",
      "pid": 50561,
      "port": 57181,
      "url": "http://localhost:57181",
      "urlNote": null,
      "cwd": "/Users/you/repo",
      "branch": "feature/hub",
      "worktree": false,
      "repoRoot": "/Users/you/repo",
      "repository": "repo",
      "category": "live-artifact",
      "kind": "html-preview",
      "target": "/path/to/x.html",
      "classificationSource": "crit registry args",
      "origin": null,
      "originSource": null,
      "mode": "preview",
      "label": "preview /path/to/x.html",
      "project": "repo",
      "reviewPath": "/Users/you/.crit/reviews/958431b24524",
      "startedAt": "2026-08-24T16:24:34.897Z",
      "firstSeenAt": "2026-08-24T16:25:01.101Z",
      "lastSeenAt": "2026-08-24T16:40:00.000Z",
      "health": "ok",
      "notes": []
    },
    {
      "id": "plannotator:45678",
      "tool": "plannotator",
      "pid": 45678,
      "port": 51723,
      "url": "http://localhost:51723",
      "cwd": "/Users/you/other-repo",
      "branch": "main",
      "worktree": null,
      "mode": "plan",
      "label": "plan-plan.md",
      "project": "other-repo",
      "health": "ok",
      "notes": []
    }
  ],
  "lastError": null
}
```

- `GET /api/health` — `{ status, hostname, port, uptimeSeconds,
  pollIntervalMs, lastPollAt, sessionCounts: {crit, plannotator}, lastError,
  versions: {crit, plannotator}, compatibility }`. Compatibility is `verified` only for the exact source-audited versions; future or unavailable versions are surfaced as warnings in the UI rather than silently assumed compatible.
- `GET /` — the UI.

## Privacy

- **Review contents are never read.** The hub reads session *registries*
  only. `review_path` from crit's registry is surfaced as a path string and
  never dereferenced (review JSON holds comments and code — out of bounds).
- **No process environments are read.** `ps eww` is unusable against
  hardened-runtime binaries on macOS and is not attempted; agent-origin is
  inferred from process *names* only (see below).
- **Loopback-only.** The server refuses non-loopback binds, and discovered
  URLs with non-loopback hosts (tunnels, remote plannotator sessions) are
  listed without a link — never opened, never proxied.
- The hub makes no outbound network connections except short-timeout `fetch` calls to the loopback daemons it lists. Crit metadata probes consume counts and timestamps only (`/api/health`, `/api/rounds`), never comment bodies.

## Origin detection (honest limits)

`origin` is a **best-effort heuristic**: an ancestor-process-name walk
(`ps -o ppid=,comm=`) matching known agent CLI names (`claude-code`, `codex`,
`copilot-cli`, `opencode`, `gemini-cli`, `droid`, `kiro-cli`, `amp`, `pi`,
`oh-my-pi`). A hit is evidence, not proof; a miss yields `null`. In
particular, plannotator's own `claude-code` *default* is not treated as
evidence by this hub, and nothing here claims per-spawn environment capture —
the hub is an observer, not a launcher.

## Install / uninstall (persistent changes are explicit)

`scripts/install.sh` and `scripts/uninstall.sh` manage five components, are
idempotent, support `--dry-run`, and only ever touch things they own. **The
project's build and tests make no persistent changes whatsoever** — installing
anything is a separate, explicit step.

```bash
scripts/install.sh --dry-run            # preview default set (hub, crit, plannotator-env)
scripts/install.sh                      # user-domain changes only
scripts/install.sh --all                # + portless alias + helium profile
scripts/install.sh --component portless --component helium
scripts/uninstall.sh                    # reverse default set
scripts/uninstall.sh --all --purge-data # also delete ~/.annotation-hub
```

| Component | What it does (user-domain) | Uninstall |
|---|---|---|
| `hub` | Writes `~/Library/LaunchAgents/local.annotation-hub.plist` (runs the observer at login, `KeepAlive`, logs to `~/.annotation-hub/state/hub.log`). Refuses to overwrite a foreign plist. | boots out + removes the plist. |
| `crit` | Merges `{"no_open": true}` into `~/.crit.config.json` — crit's first-party global switch — preserving every other key; snapshots prior state. Never touches an unparsable file. | Restores the previous `no_open` value (absent/false) **only if** it is still the value we wrote. |
| `plannotator-env` | Appends a clearly delimited block to `~/.zshrc` (or `--shell-file` targets) exporting `PLANNOTATOR_SKIP_BROWSER_OPEN=1` — plannotator's first-party suppression env. | Strips exactly that block. |
| `portless` | `portless alias annotation-hub 7632 --force` routes the stable `annotation-hub.localhost` name to `127.0.0.1:7632`. Run `portless get annotation-hub` for the exact URL; custom proxy configurations include their port (this machine currently uses `:1355`). User-level state lives in `~/.portless`. | `portless alias --remove annotation-hub`. |
| `helium` | Creates the empty profile dir `~/.annotation-hub/helium-profile`; the launcher is invoked with `bash scripts/helium.sh`. Nothing else. | Profile data removed only with `--purge-data`. |

Persistent-change ledger (things that need **your** hands, never done by this
repo's code or tests):

- `sudo portless service install` / `sudo portless trust` — root-owned
  launchd service + system keychain CA trust (needed for HTTPS
  `*.localhost`). HTTP-only alternative: `sudo portless service install
  --no-tls`. The alias only resolves while the portless proxy runs.
- Updating Helium — manual via Sparkle (current builds ship with automatic
  checks off): `scripts/helium.sh check-updates`, then Helium menu → *Check
  for Updates*. Channel switch: `scripts/helium.sh channel stable|beta`.
- Shell-profile exports only affect **new** shells; see limits below.

### Preventing browser auto-open (supported mechanisms only)

- **Crit**: global `~/.crit.config.json` `no_open: true` (what the installer
  sets) or the `--no-open` flag per invocation. Note a *project-level*
  `.crit.config.json` can re-enable opening inside that repo — when a human
  or agent spawns crit and must not open a browser, pass `--no-open`
  explicitly. There is no `CRIT_NO_OPEN` env var.
- **Plannotator**: `PLANNOTATOR_SKIP_BROWSER_OPEN=1` is the first-party kill
  switch. There is **no supported global config-file mechanism**, so the
  installer offers the opt-in shell-startup export with clearly delimited
  markers. **Scope limits:** it reaches only new interactive shells that
  source that file — not already-running terminals, not launchd GUI apps, not
  most agent harnesses. For those, start plannotator with the env explicitly:
  `PLANNOTATOR_SKIP_BROWSER_OPEN=1 plannotator review …`. If you *want*
  sessions in Helium instead of suppressed, use
  `PLANNOTATOR_BROWSER=Helium`. Do **not** use `BROWSER=none`-style
  sentinels — plannotator treats them as unset and falls back to the system
  opener.
- The hub itself never opens browsers and never spawns these tools, so it
  needs no interception. No binary shadowing/wrapping of any kind.

### Helium (imput Chromium fork) — lean, credential-free profile

```bash
scripts/helium.sh open http://127.0.0.1:7632        # hub UI in the dedicated profile
scripts/helium.sh open http://localhost:57181       # a crit session
```

Uses a dedicated `--user-data-dir` (`~/.annotation-hub/helium-profile`) plus
conservative flags (`--no-first-run --no-default-browser-check
--window-size=1280,900`). Nothing security-relevant is disabled and background
timer throttling is left intact. **Memory, honestly:** a fresh profile simply
avoids loading your daily profile's tabs and extensions — modest,
workload-dependent savings; there is no fixed MB number. Repeated `open -na`
calls with the same profile are forwarded to the running instance by
Chromium's singleton lock (a second instance on the *same* profile is not
possible; `open -a Helium <url>` would target your daily instance instead).

## Limitations

- Registry schemas verified against **Crit 0.19.0** and **Plannotator
  0.27.8** (source-audited and live-probed). Both tools' on-disk formats are
  version-sensitive; parsers here are deliberately tolerant (corrupt files
  skipped, unknown fields ignored) but re-verify on major upgrades.
- The hub displays lsof's **symlink-resolved** cwd (macOS `/tmp` →
  `/private/tmp`), matching crit's own resolution behavior.
- Git branch/worktree metadata is cached ~10 s per cwd; health probes run
  every poll with an 800 ms timeout.
- Parent-agent grouping is best-effort. Crit daemonization can reparent the daemon to launchd, making parent attribution unavailable; multiple agents in the same CWD/branch can intentionally share one Crit daemon. Plannotator ancestry is usually available while its blocking process remains alive. Neither tool records the parent agent's session UUID.
- Resolved/unresolved Crit counts are currently left unknown because the safe counts-only `/api/rounds` surface exposes totals but not resolution state. Plannotator 0.27.7 exposes no metadata-only comment-count endpoint; the hub will not ingest annotation text merely to count it.
- Origin heuristics can miss agents launched via wrappers with unrelated process names.
- Plannotator session identity uses its registry PID. After an abnormal `kill -9`, a stale registry entry combined with rare PID reuse could briefly appear as a phantom until its loopback health probe fails; it remains visibly marked unreachable.
- Session kind is a launch-metadata classification, not content inspection. Crit classification uses registry argv. Plannotator classification uses registry mode/label plus read-only `ps -ww -o command=` while the process is alive. Unknown/future launch grammar degrades honestly to `unknown` or the broader artifact category.
- If you installed the portless system service, the alias survives reboots
  only while that service runs. Use `portless get annotation-hub` rather than assuming HTTPS port 443; otherwise use `http://127.0.0.1:7632` directly (the hub never requires Portless).

## Development

```bash
bun test          # parsers, launch classification, loopback policy, proc/lsof, hub integration, HTTP, install-config safety
bun run typecheck # tsc --noEmit (strict)
bun run parity    # installed versions + every live session's safe navigation endpoint
```

`bun run parity` is the non-hermetic installed-tool check: it reports installed versions, validates every live Crit surface against its expected route (`/`, `/preview`, or `/live`), and confirms every Plannotator URL is used exactly as recorded. Run it after either tool updates.

Tests are hermetic: temp registry dirs, real short-lived child processes for
liveness/lsof/cwd coverage, an ephemeral-port server, and a sandboxed `HOME`
for the crit-config script. Nothing in `bun test` writes outside temp dirs.

Registry schemas were verified live during development with hermetic probes
(temp `HOME` / `PLANNOTATOR_DATA_DIR`, self-cleaning) against crit 0.18.1 and
plannotator 0.27.7 on this machine.

## Command cheat sheet

```bash
# run
bun run src/index.ts                       # 127.0.0.1:7632
ANNOTATION_HUB_PORT=0 bun run src/index.ts # ephemeral port (prints actual URL)

# observe the same data the hub sees
cat ~/.crit/sessions/*.json
ls ~/.plannotator/sessions/
lsof -a -p <PID> -d cwd -Fn                # cwd fallback for plannotator
crit status --json                          # per-cwd crit view (not used by the hub)

# lifecycle of the installed service
scripts/install.sh --dry-run --all
scripts/uninstall.sh --all
launchctl print "gui/$(id -u)/local.annotation-hub"   # inspect
tail -f ~/.annotation-hub/state/hub.log
```
