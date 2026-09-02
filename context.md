# Code Context

## Files Retrieved
1. `src/types.ts` (lines 9-79) - current raw registry and public session metadata; no kind/surface/target fields yet.
2. `src/critsource.ts` (lines 1-65) - Crit registry safely exposes launch `args`, CWD, branch, and review identity path without dereferencing review content.
3. `src/plannotatorsource.ts` (lines 1-74) - Plannotator registry exposes only `mode`, `label`, `project`, URL/port/PID; target details require live process argv.
4. `src/hub.ts` (lines 145-234, 238-285) - current Crit classification collapses most launches to `file`; Plannotator passes registry mode through unchanged.
5. Installed `crit --help`, `plannotator review --help`, `plannotator annotate --help`, `plannotator annotate-last --help` - authoritative launch grammar.

## Key Code

Current weak point (`src/hub.ts:154-159`):
```ts
const mode = e.args.length === 0 ? "review"
  : CRIT_MODE_VERBS.has(e.args[0] ?? "") ? e.args[0] : "file";
```
This cannot distinguish code diff, plan, document, live app, HTML preview, PR/range, or story.

Recommended public vocabulary (orthogonal, stable across tools):

```ts
type SessionKind = "review" | "annotation" | "archive" | "setup" | "unknown";
type SessionSurface =
  | "code-diff" | "pull-request" | "plan" | "document" | "document-folder"
  | "assistant-message" | "live-app" | "web-page" | "html-preview"
  | "story" | "decision-archive" | "unknown";
// sessionTarget: sanitized path/URL or semantic label; null if unknowable.
```

### Crit derivation (use registry `args`; no process lookup needed)

Parse options without treating option values as positional targets.

| Launch shape in `RawCritEntry.args` | kind | surface | target |
|---|---|---|---|
| `[]` | review | code-diff | `cwd` |
| `--pr <n|url>` | review | pull-request | number or sanitized URL |
| `--range <base>..<head>` | review | code-diff | range string |
| `plan --name <slug> <file>` | review | plan | file path (slug optional secondary metadata) |
| `story` | review | story | `cwd` |
| `live <url>` | review | live-app | sanitized URL |
| `preview <file.html>` | review | html-preview | file path |
| bare loopback `http(s)://...` | review | live-app | sanitized URL |
| bare remote `http(s)://...` | review | web-page | sanitized URL |
| bare `.html`/`.htm` | review | html-preview | path |
| other bare file(s) | review | document | path list/first target |
| bare directory (only if `stat` says directory) | review | document-folder | path |
| unrecognized verb/shape | review | unknown | first safe positional token or null |

`--session` reconnect should preserve the daemon registry's original `args` if Crit does so; otherwise classify unknown rather than guessing. Strip userinfo, query, and fragment from URL display targets. Never dereference `review_path` (`src/critsource.ts:12-15`).

### Plannotator derivation

Registry `mode` is authoritative for coarse kind; obtain live argv best-effort from PID (`ps -ww -o command= -p PID` or a `procArgv(pid)` helper), but do not persist full command strings.

| registry mode / argv shape | kind | surface | target |
|---|---|---|---|
| mode `review`, argv `review` | review | code-diff | recovered CWD |
| mode `review`, argv `review <PR_URL>` | review | pull-request | sanitized URL |
| mode `plan` (hook-launched) | review | plan | null or registry label only |
| mode `annotate`, argv `annotate <file>` | annotation | document | path |
| mode `annotate`, `.html/.htm` target | annotation | html-preview | path |
| mode `annotate`, folder target | annotation | document-folder | path |
| mode `annotate`, loopback URL or `--app` | annotation | live-app | sanitized URL |
| mode `annotate`, remote URL or `--static` | annotation | web-page | sanitized URL |
| argv `last` / `annotate-last` / `copilot-last` | annotation | assistant-message | literal `Latest assistant message` (never inspect agent logs) |
| mode/argv `archive` | archive | decision-archive | null |
| setup-goal modes | setup | unknown | registry label only |
| unknown mode/argv unavailable | unknown | unknown | null |

Important: `--gate`, `--json`, `--hook`, `--require-approval`, and `--result-file` change decision/transport semantics, not the reviewed surface. They may become a separate `sessionGate: boolean` later.

Plannotator labels such as `annotate-demo.md` are lossy and should only be fallback evidence. Live observations showed registry `mode:"annotate"`, label `annotate-<basename>`, while process argv retained `plannotator annotate /path/file.md --gate`.

### Safety and confidence

Add `sessionClassificationSource: "registry-args" | "registry-mode+process-argv" | "registry-mode"` and optionally confidence `exact | inferred | unknown`. Parse argv only in memory into enumerated fields. Do not return/store full argv. URL target sanitization must remove credentials/query/fragment; target paths are already launch metadata and do not require reading contents. If process ancestry/argv disappeared after reparenting, fall back to registry mode/label and surface `unknown` rather than overstate.

## Test Cases

Table-driven unit tests for a pure `classifyCrit(args,cwd,stat?)` and `classifyPlannotator(mode,label,argv,cwd,stat?)`:

1. Crit `[]` => `review/code-diff`, target CWD.
2. Crit `['--pr','https://github.com/o/r/pull/7?token=x#f']` => `review/pull-request`, target `https://github.com/o/r/pull/7`.
3. Crit `['--range','main..feature']` => `review/code-diff`.
4. Crit `['plan','--name','demo','/tmp/plan.md']` => `review/plan`.
5. Crit `['live','http://localhost:4173/?secret=x']` => `review/live-app`, sanitized target.
6. Crit `['preview','/tmp/app.html']` and bare HTML => `review/html-preview`.
7. Crit bare markdown => `review/document`; directory with injected stat => `document-folder`.
8. Crit `['story']` => `review/story`.
9. Plannotator mode `review`, argv `plannotator review` => `review/code-diff`.
10. Plannotator mode `review`, PR argv => `review/pull-request`, sanitized URL.
11. Plannotator mode `annotate`, markdown argv => `annotation/document`.
12. Plannotator annotate loopback URL => `annotation/live-app`; same with `--static` => `annotation/web-page`; `--app` overrides probe ambiguity.
13. Plannotator annotate remote URL => `annotation/web-page`.
14. Plannotator `last` and `annotate-last --gate` => `annotation/assistant-message`, semantic target only.
15. Plannotator mode `plan`, argv unavailable => `review/plan`, source registry-mode.
16. Unknown mode and dead/reparented PID => all unknown/null, no fabricated target.
17. Flags containing paths (`--result-file /tmp/result.json`) must never become sessionTarget.
18. Ensure output JSON contains no full argv and no URL secret/query/fragment.

## Architecture

Discovery stays registry-first. Crit already records sufficient argument structure. Plannotator uses registry mode as authority, enriched with ephemeral process argv while PID is live, analogous to current CWD recovery (`src/plannotatorsource.ts:12-14`). A pure classifier should sit between source parsing and `SessionInfo` assembly in `src/hub.ts`; keep filesystem checks dependency-injected for deterministic tests.

## Start Here

Open `src/hub.ts` at lines 145-191. Replace the current Crit `mode` ternary with a shared pure classifier, then invoke the Plannotator classifier before constructing its `SessionInfo` at lines 258-285.

## Findings

- **high** — `src/hub.ts:154-159`: current classification collapses semantically distinct Crit sessions, so UI cannot satisfy requested kind filtering.
- **medium** — `src/plannotatorsource.ts:61-71`: Plannotator registry lacks launch target; mode/label alone cannot reliably distinguish document, last-message, live-app, remote page, or folder.
- **medium** — Process argv can disappear after launcher exit/reparenting; classification must expose uncertainty and never infer from label alone as fact.
- **low/security** — Raw URL argv may contain credentials or query tokens; sanitize before API/UI exposure and never retain full argv.

```acceptance-report
{
  "criteriaSatisfied": [
    {
      "id": "criterion-1",
      "status": "satisfied",
      "evidence": "Concrete severity-ranked findings cite src/hub.ts, src/plannotatorsource.ts, src/critsource.ts, and src/types.ts; mapping and 18 test cases are included."
    }
  ],
  "changedFiles": [
    "context.md"
  ],
  "testsAddedOrUpdated": [],
  "commandsRun": [
    {
      "command": "crit --help; plannotator review/annotate/annotate-last --help",
      "result": "passed",
      "summary": "Confirmed authoritative launch grammars and option semantics."
    },
    {
      "command": "inspect ~/.crit/sessions/*.json and ~/.plannotator/sessions/*.json",
      "result": "passed",
      "summary": "Confirmed live registry schemas and observed annotate label/argv behavior without reading content."
    },
    {
      "command": "ps -ww for live session PIDs",
      "result": "passed",
      "summary": "Confirmed Plannotator process argv retains target/flags while registry does not."
    }
  ],
  "validationOutput": [
    "Crit registry includes args/cwd/branch/review_path.",
    "Plannotator registry includes mode/project/label but not target.",
    "Live Plannotator argv exposed annotate target and --gate without review text."
  ],
  "residualRisks": [
    "Plannotator process argv is unavailable after process exit or some reparenting/wrapping patterns.",
    "Upstream mode/label schemas are not explicitly versioned and need unknown-safe fallbacks.",
    "Filesystem stat can distinguish file/folder but must never read target content."
  ],
  "noStagedFiles": true,
  "diffSummary": "Documentation-only scouting artifact; no source files edited.",
  "reviewFindings": [
    "high: src/hub.ts:154-159 - Crit mode derivation collapses distinct session surfaces.",
    "medium: src/plannotatorsource.ts:61-71 - registry lacks enough detail to classify annotate targets without ephemeral argv.",
    "low: URL targets from argv require credential/query/fragment redaction."
  ],
  "manualNotes": "Use orthogonal kind/surface/target fields plus classification source; do not overload existing mode."
}
```
