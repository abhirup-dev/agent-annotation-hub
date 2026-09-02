/**
 * Shared domain types for the annotation hub.
 *
 * The hub discovers sessions without interception and never reads review text.
 * It may terminate a currently discovered session only through the confirmed
 * close API. All services and click targets remain loopback-only.
 */

export type ToolName = "crit" | "plannotator";
export type SessionCategory = "review" | "annotate" | "live-artifact" | "browse" | "other";
export type SessionKind =
  | "code-review"
  | "pull-request-review"
  | "merge-request-review"
  | "commit-range-review"
  | "plan-review"
  | "story-review"
  | "artifact-annotation"
  | "folder-annotation"
  | "web-page-annotation"
  | "last-message-annotation"
  | "live-web-review"
  | "html-preview"
  | "guided-review"
  | "archive-browser"
  | "goal-setup"
  | "unknown";

/** Daemon reachability, probed with a short-timeout loopback HTTP request. */
export type Health = "ok" | "unreachable" | "unknown";

/** Raw entry parsed from `~/.crit/sessions/<key>.json` (schema per crit 0.18.1). */
export interface RawCritEntry {
  /** Registry filename key (12 hex chars on current crit; tolerant to other lengths). */
  key: string;
  pid: number | null;
  port: number | null;
  host: string;
  publicUrl: string | null;
  cwd: string | null;
  args: string[];
  branch: string | null;
  reviewPath: string | null;
  startedAt: string | null;
  registryUpdatedAt: string | null;
}

/** Raw entry parsed from `<plannotator-data-dir>/sessions/<pid>.json`. */
export interface RawPlanEntry {
  pid: number | null;
  port: number | null;
  url: string | null;
  mode: string | null;
  project: string | null;
  startedAt: string | null;
  registryUpdatedAt: string | null;
  label: string | null;
}

/** A single live session as exposed by the API and UI. */
export interface SessionInfo {
  /** Stable across polls: `<tool>:<registry-key-or-pid>`. */
  id: string;
  tool: ToolName;
  pid: number | null;
  port: number | null;
  /** Loopback-validated click target; null when no safe URL is known. */
  url: string | null;
  /** Why `url` is null, when applicable (e.g. non-loopback host was ignored). */
  urlNote: string | null;
  cwd: string | null;
  branch: string | null;
  worktree: boolean | null;
  /** Git repository root when the cwd is inside a repository. */
  repoRoot: string | null;
  repository: string | null;
  /** Coarse and fine review semantics derived from launch metadata only. */
  category: SessionCategory;
  kind: SessionKind;
  target: string | null;
  classificationSource: string;
  /** Best-effort agent-origin heuristic (ancestor process name). Not proof. */
  origin: string | null;
  originSource: string | null;
  /** Nearest recognized agent process, when ancestry is still intact. */
  parentAgentPid: number | null;
  parentAgentGroup: string | null;
  mode: string | null;
  label: string | null;
  project: string | null;
  reviewPath: string | null;
  startedAt: string | null;
  /** Registry or safe metadata timestamp; an activity proxy, not guaranteed user input. */
  updatedAt: string | null;
  commentCount: number | null;
  resolvedCommentCount: number | null;
  unresolvedCommentCount: number | null;
  reviewRound: number | null;
  browserClients: number | boolean | null;
  interacted: boolean | null;
  /** ISO time the hub first observed this session (survives polls). */
  firstSeenAt: string;
  /** ISO time of the most recent poll that still saw the session. */
  lastSeenAt: string;
  health: Health;
  notes: string[];
}

export interface HubSnapshot {
  generatedAt: string;
  pollIntervalMs: number;
  count: number;
  sessions: SessionInfo[];
  /** Non-fatal discovery errors from the most recent poll, if any. */
  lastError: string | null;
}
