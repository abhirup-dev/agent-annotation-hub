# Research: Crit 0.18.1 & Plannotator 0.27.7 metadata surfaces for the local annotation hub

Scope: read-only investigation (upstream source at `tomasz-tomczyk/crit@main`, official plannotator docs, and safe live file probes on this machine). No project files or persistent settings were edited. **[F]** marks a verified fact; **[H]** marks a hypothesis/inference.

---

## Summary

Both tools expose metadata-only surfaces sufficient for counts and interaction signals without retaining comment text. Crit is the richer target: `~/.crit/sessions/<key>.json` (live registry), `~/.crit/stats.json` (per-session counts/rounds/timestamps, no text — live-verified), `GET /api/rounds` (round + per-round `comment_count` + `captured_at`), `GET /api/session` (per-file `comment_count`, `review_round`, `hidden_unresolved`), `GET /api/health` (`browser_clients`), and `crit status --json` (unresolved/resolved counts, no bodies). Plannotator 0.27.7 exposes only the session registry `<dataDir>/sessions/<pid>.json` plus an explicitly **unstable** local HTTP API whose one "stable" surface (`/api/external-annotations`) still returns annotation text — there is **no counts-only endpoint and no externally observable decision state** (the server exits on decision and unregisters). Reliable per-agent-process grouping via PPID ancestry is **not possible for crit daemons** (Setsid + orphan-reparenting to launchd once the client exits) and only **transiently reliable for plannotator** (server is a live child of the spawning hook/agent for the whole session). Neither tool records the parent agent's session UUID.

---

## 1. Metadata-only comment counts (no comment text retained)

**Crit** — all counts below are derivable without ever materializing a comment body:

1. **[F] `crit status --json`** outputs counts computed *from* the review file but emits only integers: `comments: {unresolved, resolved}` plus `round`, `review_type`, `origin`, `review_file`, `review_file_exists`, `daemon {running, pid, port}`, `sessions[] {id, args, branch, review_file, pid, port}`. Source: `internal/session/status_cli.go` (`addReviewStats`, `countComments`). Caveat: it is CWD-scoped (resolves sessions for the current directory/repo) and requires spawning the CLI — conflicts with the hub's "never launches crit" charter; a policy decision, not a technical one.
2. **[F] `~/.crit/stats.json`** (live-verified on this machine, mode values seen: `git`, `files`, `preview`, `plan`):
   ```json
   { "totals": {"sessions","duration_seconds","files_reviewed","comments_submitted"},
     "sessions": [{"started_at","ended_at","duration_seconds","files_reviewed",
                   "comments_submitted","branch?","mode","rounds","review_key?","args?"}] }
   ```
   No comment text. Written on `/api/finish` (approval) and daemon shutdown; `comments_submitted` counts only comments authored by the configured user author (`sessionActivity` author filter in `stats.go`); skipped entirely if zero activity; opt-out via `disable_stats`; not concurrency-safe (documented in-source); file mode 0644.
3. **[F] `GET /api/rounds`** on the daemon: `{current_round, rounds: [{n, additions, deletions, comment_count, captured_at}]}` — pure counts + timestamps. Files/plan modes only; git mode returns `current_round` with empty `rounds`. Source: `handleRounds` in `internal/server/server.go`.
4. **[F] `GET /api/session`**: per-file `comment_count` (visible comments, resolved + unresolved) and top-level `hidden_unresolved` — but the same payload embeds full `review_comments[]` objects *including bodies* (see §5). Resolved/unresolved *split* is not available via HTTP without reading comment objects.
5. **[F] Review file `~/.crit/reviews/<key>/review.json`** (CritJSON) is where the truth lives: `branch, base_ref, updated_at, review_round, review_comments[], cli_args, files{path→{status,file_hash,comments[]}}, review_type?, origin?, story?`; comments carry `id, start_line, end_line, body, quote, anchor, author, created_at, updated_at, resolved?, resolved_round?, review_round?, replies[]`. Reading it means touching bodies. **[H]** If the hub ever relaxes its "never read review contents" rule, a streaming parser that counts `resolved` booleans and discards `body`/`quote`/`anchor`/`replies[].body` satisfies "no text retained" — but the current README declares review contents out of bounds, so the supported equivalent is `crit status --json`.
6. **[F] `crit comments --json`** (`crit comments [--session <id>] [--json] [--all]`) lists unresolved comments **with bodies** — not metadata-only.

**Plannotator**:

7. **[F]** No counts-only surface exists in documented behavior. The registry (below) has no comment/annotation counts. The only "stable integration surface" is `POST /api/external-annotations` (+ GET snapshot with `?since`, SSE event stream, 30s heartbeat), which returns **annotation objects including text** (verified against v0.25.0; official docs: "The remaining routes support the bundled browser UI. They can change with a Plannotator release."). **[H]** A snapshot fetch whose text fields are immediately discarded would give a live annotation count, but the text transits hub memory — same policy question as crit's review file.

## 2. Interaction signals

| Signal | Crit 0.18.1 | Plannotator 0.27.7 |
|---|---|---|
| Browser clients connected | **[F]** `GET /api/health` includes `browser_clients` (SSE-connected tabs; PR #177 added it; missing field = old daemon, "assume browser exists"). Full field list not enumerated — treat as `{status, browser_clients, …}`. | **[H]** No equivalent documented; SSE heartbeats exist only on external-annotations stream. |
| Annotations/drafts | **[F]** per-file `comment_count` via `/api/session`; per-round `comment_count` via `/api/rounds`; historical `comments_submitted` in `stats.json`. Drafts: none persisted (comments write-through on 200ms debounce). | **[H]** Draft routes exist in plan sessions ("draft annotations" in official route-family docs); exact endpoints/persistence unverified (see Gaps). |
| Review round | **[F]** `review_round` in `/api/session` and `review.json`; `current_round` in `/api/rounds`; `rounds` in `stats.json`. **Note: `GET /api/review-cycle` returns 405 — it is POST-only** (verified: commit 7d768b7 regression test asserts GET/PUT/DELETE → 405; AGENTS.md's "GET /api/review-cycle" line is docs drift). | **[H]** Plan sessions have "previous versions / plan history" routes; no documented round number in registry. Version count inferable **[H]** from plan version files (crit-owned `~/.crit/plans/<slug>/vNNN.md` is crit's plan flow, not plannotator). |
| Approved / dismissed / submitted | **[F]** `POST /api/review-cycle` returns `{approved, prompt, next_command, stats}` to the *blocking client* — a state-changing long-poll; an observer must **never** call it (it races the real agent client). After finish: `cleanup_on_approve` may delete the review file; `stats.json` row is appended on approve. No GET endpoint exposes "approved". | **[F]** Decision routes are POSTs (`/api/approve`, `/api/deny`, `/api/feedback`) and "the server normally exits when you approve, send feedback, or close the session" (official docs). Registry file is removed on exit (self-unregister). **[H]** Therefore the only metadata-visible decision signal is *session disappearance*; `{"decision":"approved"|"dismissed"|"annotated"}` JSON goes only to the spawning process's stdout. |
| Last activity / update timestamps | **[F]** registry `started_at`; review.json `updated_at` (content file — avoid); `/api/rounds` `captured_at` per round; `stats.json` `started_at`/`ended_at`. **[H]** filesystem mtime of `review.json` is a proxy the hub could `stat` without reading (path only). | **[F]** registry `startedAt` only. **[H]** mtime of `<pid>.json` file as activity proxy is wrong (written once at startup). |
| Mode / labels | **[F]** registry `args` (first verb: `review|live|preview|plan`), `branch`, `cwd`, `review_path`; `/api/session` `mode` (git|files|plan), `review_type`, live `origin`. | **[F]** registry `mode` ∈ `plan|annotate|review|archive|goal-setup`, `label`, `project`. |

## 3. Plannotator equivalent surfaces & exact schemas

- **[F] Registry (verified live against 0.27.7 during hub development; parser in `src/plannotatorsource.ts`)**: `<dataDir>/sessions/<pid>.json` with `PID_FILE_RE = /^(\d{1,8})\.json$/`:
  ```json
  {"pid": 45678, "port": 51723, "url": "http://localhost:51723",
   "mode": "plan", "project": "other-repo",
   "startedAt": "2026-08-24T16:24:34.897Z", "label": "plan-plan.md"}
  ```
- **[F] Data-dir resolution**: `PLANNOTATOR_DATA_DIR` → existing `~/.plannotator` → `$XDG_DATA_HOME/plannotator` (absolute only) → `~/.plannotator`. A *relative* `PLANNOTATOR_DATA_DIR` resolves from the launcher's cwd (official config reference) — use absolute paths when probing.
- **[F] Crit registry (verified live, 0.18.1)**: `~/.crit/sessions/<key>.json`, key = `sha256(cwd + "\0" + branch)[:12]` (git mode) or `sha256(cwd + "\0" + args…)[:12]` (file mode); fields `{pid, port, host, cwd, args, branch, review_path, started_at}`. Siblings `<key>.log`, `<key>.lock` ignored. Atomic writes (temp+fsync+rename), 0700 dir.
- **[F] HTTP**: session-scoped, unauthenticated, loopback by default (`127.0.0.1`), remote mode `0.0.0.0` (no auth either — never expose). Unknown `/api/*` → JSON 404 (not HTML). SPA fallback for non-API paths. **Not a versioned API**; only `/api/external-annotations` is documented as tested/stable.
- **[F] Third-party-documented endpoints (opencodeDocs mirror, updated 2026-01-24 — treat as drift-prone)**: `GET /api/plan → {plan, origin, permissionMode, sharingEnabled}`; `POST /api/approve`, `POST /api/deny → {ok, savedPath}`; code review: `GET /api/diff`, `POST /api/diff/switch`, `POST /api/feedback`; shared: `GET /api/image`, `POST /api/upload` (uploads persist in `/tmp/plannotator`, not cleaned).
- **[F] `plannotator sessions`** subcommand lists/opens/cleans sessions (PR #242); subprocess — hub charter says no.

## 4. Grouping sessions by parent Claude/Pi/Codex process (process ancestry)

- **[F] Crit daemonizes with `Setsid: true`** (`internal/daemon/daemon_unix.go`): new session, detached from the controlling terminal, explicitly "so daemon survives" client exit (PR #224 replaced Setpgid). Consequence: **[F]** the thin `crit` client blocks for the whole round, so *during an active round* the chain daemon → client → agent CLI is walkable; once the client exits (feedback returned), the daemon is orphaned and reparented to launchd (PPID 1) — ancestry from the registry PID is permanently broken between rounds. `Ctrl+C` kills the client-started daemon; `crit stop [--all]` kills daemons.
- **[F] Crit's registry records no agent identity.** `Origin` is only the live-mode upstream URL (verified in `session.go` CritJSON comment + `Session.Origin`). `agent_cmd` config is a command crit *sends comments to*, not provenance. `crit plan-hook --mode claude|codex` exists but doesn't persist the mode into the registry.
- **[F] Two agents in the same cwd+branch deliberately share one crit daemon** (session key collision = same review). Per-agent-process grouping is therefore semantically wrong for crit; the correct grouping unit is (cwd, branch) or (cwd, args), i.e., the 12-hex session key.
- **[F] Plan-mode grouping is first-party**: `~/.crit/plan-sessions.json` (**live-verified on this machine**: `{"<sessionKey>": {"slug": "…", "created_at": "…"}}`, pruned after 7 days) maps a session key to a plan slug; plan storage at `~/.crit/plans/<slug>/{current.md, vNNN.md}`; plan session key = `sha256(cwd + "\0" + "__plan:" + slug)[:12]`.
- **[F/H] Plannotator**: the server process is spawned by the hook/slash-command process, which is a child of the agent CLI, and the server lives until a decision — so the ancestor walk from registry PID works for the *entire session lifetime* **[H]** in the common hook path, provided no wrapper shell with an unrelated name sits in between and the session wasn't launched from a terminal by a human. No recorded agent id; identity = PID → stale-registry + PID-reuse phantom risk (README documents this).
- **[F] Neither registry persists the parent agent's session UUID** (Claude session id / Codex / Pi). Env-based attribution (`PLANNOTATOR_ORIGIN`) is not readable by an observer on macOS (hardened runtime blocks `ps eww`; README verified).
- **Verdict**: PPID ancestry is a *transient heuristic*, not a reliable grouping key. For crit, group by session key (deterministic from cwd+branch/args) and treat ancestry as enrichment only while the review round is active; for plannotator, ancestry is usable while alive but disappears exactly when the decision is made (the moment you'd want to record it).

## 5. Privacy & version risks

**Privacy**
1. **[F]** Crit `review.json` holds comment bodies, quoted source, anchors; `snapshots.json` holds **full file content copies** per round. Never dereference `review_path`.
2. **[F]** Crit `GET /api/config` returns `delete_token`, `hosted_token`, `agent_cmd`, `auth_*` state — secrets; the hub must never fetch/log it (it does include `version`/`latest_version`, tempting for the version badge — prefer `crit --version` diagnostics already in `hub.ts`).
3. **[F]** Crit `GET /api/session` embeds review-level comment bodies; even "count-only" consumption means bodies transit hub memory transiently. `/api/rounds` is the clean counts-only HTTP surface.
4. **[F]** `stats.json` (0644) leaks workspace metadata: branch names and absolute `args` paths — the live sample on this machine contains agent scratchpad paths (`/private/tmp/claude-501/…`). No comment text.
5. **[F]** Both HTTP APIs are unauthenticated on loopback; any local process can read comment contents (`/api/file/comments` crit; external-annotations snapshot plannotator). Crit adds DNS-rebinding (Host check) + `Sec-Fetch-Site` CSRF guards (GETs always allowed); plannotator has neither documented. Remote plannotator binds `0.0.0.0` with no auth — the hub's URL sanitization (loopback-only links) is the correct mitigation.
6. **[F]** Plannotator: automatic GitHub release check on every surface load (cannot be disabled), background `git ls-remote origin`, avatar lookups (GitLab variant sends commit-author emails), `/tmp/plannotator` uploads not cleaned, document history may contain full file copies in the data dir, approved/denied plans saved to `~/.plannotator/plans/…md`.
7. **[F]** POST endpoints are off-limits for an observer: crit `/api/review-cycle` is the blocking client long-poll (calling it steals/races the agent's round result); `/api/finish`, `/api/round-complete`, plannotator `/api/approve|/api/deny|/api/feedback` all mutate state or end sessions.

**Version**
8. **[F]** Crit review storage underwent v3 (flat `.json`) → v4 (folder `review.json` + `snapshots.json`) migration, still auto-migrated on read; registry/stats schemas are unversioned. Docs-vs-code drift exists (AGENTS.md documents `GET /api/review-cycle`; code returns 405) — parse defensively, trust live probes over docs.
9. **[F]** Plannotator's local API is explicitly "not a versioned public web API… can change with a release"; the stable external-annotations surface was last verified against **v0.25.0** (installed: 0.27.7) — re-verify before relying on it. Registry schema could drift likewise (hub's tolerant parser + filename-regex approach is the right defense).
10. **[F]** Crit `stats.json` may be absent (`disable_stats: true` or zero-activity sessions) — absence must not be an error.

---

## Implementation-ready field table

| # | Tool | Surface | Endpoint / Path | Fields to consume | Safe parsing strategy | Confidence |
|---|------|---------|-----------------|-------------------|----------------------|------------|
| 1 | crit | Registry (live sessions) | `~/.crit/sessions/<key>.json` | `pid, port, host, cwd, args[], branch, review_path, started_at` | `JSON.parse` with per-file try/catch; skip non-hex keys, non-`.json`; strict pid/port ints; ignore `.log`/`.lock` | High (live + source) |
| 2 | crit | Lifetime stats | `~/.crit/stats.json` | `sessions[].{started_at, ended_at, duration_seconds, files_reviewed, comments_submitted, branch?, mode, rounds, review_key?, args?}`, `totals` | Parse whole file; tolerate absence; never surface `args` paths without truncation | High (live-verified) |
| 3 | crit | Plan mapping | `~/.crit/plan-sessions.json` | `<sessionKey> → {slug, created_at}` | Parse; entries auto-prune at 7d — absence ≠ error | High (live-verified) |
| 4 | crit | Daemon health | `GET http://127.0.0.1:<port>/api/health` | `status`, `browser_clients` (missing ⇒ legacy daemon) | Status-code + tiny-body parse, 800ms timeout; missing `browser_clients` → "assume connected" | Med-High (browser_clients via PR #177; full schema not enumerated) |
| 5 | crit | Rounds | `GET …/api/rounds` | `current_round`, `rounds[].{n, comment_count, captured_at, additions, deletions}` | GET-only; 503 until ready (retry); git mode ⇒ empty rounds | High (source-verified) |
| 6 | crit | Session meta | `GET …/api/session` | `mode, branch, base_ref, review_round, session_key, cwd, files[].comment_count, hidden_unresolved, review_type?, focus` | **Discard `review_comments[]` immediately (bodies)**; poll until non-503 before other calls | High (source-verified) |
| 7 | crit | Version/config | `GET …/api/config` | `version, latest_version, review_type?` | **Do not log** `delete_token`/`hosted_token`/`agent_cmd`; prefer `crit --version` one-shot (already in `hub.ts`) | High (source-verified) |
| 8 | crit | Status CLI (opt-in) | `crit status --json` (in session cwd) | `comments.{unresolved,resolved}, round, daemon, sessions[]` | Requires spawn — policy decision vs. hub charter; counts-only output | High schema / policy-gated |
| 9 | crit | Counting fallback | `~/.crit/reviews/<key>/review.json` | count `files[].comments[].resolved` + `review_comments[].resolved` | Streaming parse, discard bodies/quotes/replies — currently **out of bounds** per hub charter | High schema / charter-gated |
| 10 | crit | FORBIDDEN | `POST /api/review-cycle`, `/api/finish`, `/api/round-complete` | — | Never call: blocking/state-changing, races agent client; GET review-cycle = 405 | High |
| 11 | plannotator | Registry | `<dataDir>/sessions/<pid>.json` (`PLANNOTATOR_DATA_DIR` → `~/.plannotator` → XDG) | `pid, port, url, mode, project, startedAt, label` | Filename regex `^\d{1,8}\.json$`; prefer file pid, fall back to name; sanitize url to loopback | High (live + PR #242) |
| 12 | plannotator | Stable-ish API | `GET/POST …/api/external-annotations` (+ `?since`, SSE, 30s heartbeat) | annotation count (if text discarded) | Only stable surface, but returns text; last verified v0.25.0 — re-probe on upgrade | Medium |
| 13 | plannotator | Plan origin (opt-in) | `GET …/api/plan` | `origin` ("claude-code"\|"opencode") | Response includes plan text — avoid unless needed | Medium (third-party docs, 2026-01) |
| 14 | plannotator | Decision state | (none) | session disappearance = decision made | Watch registry file removal + PID liveness; no GET endpoint exists | Hypothesis (documented behavior) |
| 15 | plannotator | FORBIDDEN | `POST /api/approve`, `/api/deny`, `/api/feedback`, `/api/diff/switch` | — | State-changing; decision routes terminate the session | High |
| 16 | both | Grouping | PPID ancestry (`ps -o ppid=,comm=` walk) | ancestor process names (`claude-code`, `codex`, `pi`, …) | Enrichment-only; crit: valid only while round-active (daemon Setsid → PPID 1 after client exit); plannotator: valid for session lifetime; cache ~30s | Verified limitation, heuristic use |

## Verified facts vs. hypotheses (summary)

**Verified [F]** — source (crit `main` clone), official plannotator docs, PRs, or live probes on this machine: registry schemas (both), stats.json schema + live sample, plan-sessions.json live sample, Setsid daemon spawn, `browser_clients` in `/api/health`, `/api/session` + `/api/rounds` + `/api/config` shapes, POST-only `/api/review-cycle` (GET 405), crit session-key derivation, plannotator data-dir order + server-exits-on-decision + unauthenticated/unstable API, crit review-file/CritJSON/Comment schema, `disable_stats`, cleanup_on_approve, v3→v4 layout, CSRF/DNS-rebinding guards, plannotator privacy behaviors (release check, ls-remote, avatars, /tmp uploads).

**Hypotheses [H]** — plausible but unverified: exact `/api/health` full field list; `/api/files/list` payload; plannotator draft endpoints/persistence paths; annotation-count-only use of external-annotations snapshot; mtime-of-review.json as activity proxy; plannotator ancestry reliability in non-hook launch paths; PID-reuse phantom window duration.

## Sources

- Kept: crit AGENTS.md / README / `internal/{session,server,daemon,review}/*.go` source (tomasz-tomczyk/crit@main clone) — primary ground truth for schemas, endpoints, Setsid, stats; PRs #165, #224 (Setsid daemon), #177 (`browser_clients`), #613/5e26329 (stats.json), #256 (session registry), #677/#678 (crit comments), 7d768b7 (review-cycle GET=405), 72d2cdc (finish/review-cycle comments array); crit.md changelog (v0.18.x lineage); plannotator docs.plannotator.ai — local-api, external-annotations, privacy-and-data-flow, configuration, hooks/annotate-gates (decision JSON); backnotprop/plannotator PR #242 (session registry source), #795 (PLANNOTATOR_DATA_DIR); opencodeDocs plannotator API mirror (endpoint reference, drift-prone); agent-annotation-hub README + `src/{critsource,plannotatorsource,hub}.ts` (live-verified schemas on 0.18.1/0.27.7); live probes: `~/.crit/stats.json`, `~/.crit/plan-sessions.json`.
- Dropped: pkg-go.dev crit v0.7.0 page (stale vs 0.18.1); daemon(7)/man7/freedktop daemon pages (generic Unix background, kept only as corroboration of orphan reparenting); ashlr/untether stats.json hits (unrelated tools); hoody.com health docs (unrelated product); cephalochromoscope mirror pages (redundant with PR #242).

## Gaps

1. Exact full JSON of crit `GET /api/health` (only `browser_clients` + liveness verified) — one live `curl 127.0.0.1:<port>/api/health` during an active session would settle it; couldn't be done here (no live crit daemon during research, no shell tool).
2. `GET /api/files/list` exact payload ("lighter than /api/session") — read `handleFilesList` in `server.go` lines ~1200–3260 (not reached) or probe.
3. Plannotator draft-annotation endpoints and any on-disk draft/history persistence under `<dataDir>` — needs a live 0.27.7 session probe or reading `packages/server/*` at the v0.27.7 tag.
4. Whether crit's SSE `/api/events` increments `browser_clients` for non-browser subscribers (would an observer's EventSource pollute the count?) — read `handleEvents`.
5. Whether plannotator's registry/`plannotator sessions` gains counts or decision state in ≥0.27.x — release notes for v0.27.0–0.27.7 were not exhaustively read.
6. No shell tool was available in this run: all "live probes" were read-only file reads via the read tool; no HTTP probes, no `ps`/`lsof` runs. Reparenting-to-launchd for the Setsid'd orphan daemon is standard macOS/Unix semantics, corroborated by PR #224's intent, but not directly observed with `ps` here.
