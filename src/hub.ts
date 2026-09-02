/**
 * The hub: read-only discovery + health polling.
 *
 * Every `poll()`:
 *   1. Reads crit + plannotator registries (supported per-user state).
 *   2. Drops entries whose PID is dead (view-only pruning — registry files
 *      themselves are never modified).
 *   3. Sanitizes URLs to loopback only; non-loopback hosts are never exposed
 *      as click targets.
 *   4. Enriches with lsof cwd recovery (plannotator), git branch/worktree,
 *      best-effort origin heuristic, and a short-timeout daemon health probe.
 *
 * The hub never launches sessions or reads review contents. It terminates a
 * session only after an explicit confirmed UI request, and never shells out
 * with interpolated strings.
 */
import os from "node:os";
import path from "node:path";
import { classifySession } from "./classify";
import { readCritRaw } from "./critsource";
import { GitMetaCache, type GitInfo } from "./gitmeta";
import { critLoopbackUrl, isLoopbackHost, sanitizeLoopbackUrl } from "./loopback";
import { sessionOpenUrl } from "./navigation";
import { detectAgentAncestor, isPidAlive, lsofCwd, processCommand, runCapture, type AgentAncestor } from "./proc";
import { readPlanRaw, resolvePlannotatorDataDir } from "./plannotatorsource";
import type { Health, HubSnapshot, RawCritEntry, RawPlanEntry, SessionInfo } from "./types";
import { basename, errMessage } from "./util";

const CRIT_MODE_VERBS = new Set(["review", "live", "preview", "plan"]);

export interface HubOptions {
  /** Poll interval (ms). Default 2000 per project contract. */
  pollIntervalMs?: number;
  /** Override `~/.crit` (tests). */
  critHome?: string;
  /** Override plannotator data dir (tests). */
  plannotatorDataDir?: string;
  healthTimeoutMs?: number;
  gitTtlMs?: number;
}

interface Cached<T> {
  at: number;
  value: T;
}

async function probeHealth(url: string, timeoutMs: number): Promise<Health> {
  try {
    const res = await fetch(url, { redirect: "manual", signal: AbortSignal.timeout(timeoutMs) });
    return res.status < 500 ? "ok" : "unreachable";
  } catch {
    return "unreachable";
  }
}

export class Hub {
  readonly pollIntervalMs: number;
  readonly critHome: string;
  readonly plannotatorDataDir: string;
  lastPollAtMs = 0;

  private readonly healthTimeoutMs: number;
  private readonly git: GitMetaCache;
  private readonly originCache = new Map<number, Cached<AgentAncestor | null>>();
  private readonly cwdCache = new Map<number, Cached<string | null>>();
  private sessions = new Map<string, SessionInfo>();
  private lastError: string | null = null;
  private toolVersions: Promise<Record<string, string | null>> | null = null;

  constructor(opts: HubOptions = {}) {
    this.pollIntervalMs = opts.pollIntervalMs ?? 2000;
    this.critHome = opts.critHome ?? path.join(os.homedir(), ".crit");
    this.plannotatorDataDir = opts.plannotatorDataDir ?? resolvePlannotatorDataDir();
    this.healthTimeoutMs = opts.healthTimeoutMs ?? 800;
    this.git = new GitMetaCache(opts.gitTtlMs ?? 10_000);
  }

  /** Best-effort one-shot CLI version capture (diagnostics only). */
  getToolVersions(): Promise<Record<string, string | null>> {
    this.toolVersions ??= (async () => {
      const grab = async (bin: string) => {
        const r = await runCapture([bin, "--version"], 2000);
        return r.ok ? r.stdout.trim().split("\n")[0]?.trim() ?? null : null;
      };
      return {
        crit: await grab("crit"),
        plannotator: await grab("plannotator"),
      };
    })();
    return this.toolVersions;
  }

  private cached<T>(map: Map<number, Cached<T>>, pid: number, ttl: number, load: () => Promise<T>): Promise<T> {
    const hit = map.get(pid);
    if (hit && Date.now() - hit.at < ttl) return Promise.resolve(hit.value);
    return load().then((value) => {
      map.set(pid, { at: Date.now(), value });
      return value;
    });
  }

  private async originFor(pid: number): Promise<AgentAncestor | null> {
    return this.cached(this.originCache, pid, 30_000, () => detectAgentAncestor(pid));
  }

  private async cwdFor(pid: number): Promise<string | null> {
    return this.cached(this.cwdCache, pid, 15_000, () => lsofCwd(pid));
  }

  private async gitFor(cwd: string | null): Promise<GitInfo> {
    if (!cwd) return { repo: false, branch: null, worktree: null, toplevel: null, repositoryRoot: null };
    return this.git.get(cwd);
  }

  async poll(): Promise<SessionInfo[]> {
    const nowMs = Date.now();
    this.lastPollAtMs = nowMs;
    const now = new Date(nowMs).toISOString();
    const next = new Map<string, SessionInfo>();
    const enrich: Array<Promise<void>> = [];

    const errors: string[] = [];
    let critEntries: RawCritEntry[] = [];
    let planEntries: RawPlanEntry[] = [];
    try {
      critEntries = readCritRaw(this.critHome);
    } catch (e) {
      errors.push(`crit registry: ${errMessage(e)}`);
    }
    try {
      planEntries = readPlanRaw(this.plannotatorDataDir);
    } catch (e) {
      errors.push(`plannotator registry: ${errMessage(e)}`);
    }
    this.lastError = errors.length > 0 ? errors.join("; ") : null;

    for (const e of critEntries) {
      const notes: string[] = [];
      if (e.pid === null) {
        notes.push("invalid pid in registry");
        continue; // cannot validate liveness — do not expose
      }
      const pid = e.pid; // narrowed local survives the async closure below
      if (!isPidAlive(pid)) continue; // stale daemon entry — pruned from view

      let url: string | null = null;
      let urlNote: string | null = null;
      if (e.publicUrl) {
        const advertised = sanitizeLoopbackUrl(e.publicUrl);
        url = advertised.url;
        urlNote = advertised.note;
        if (!url) notes.push(`recorded public_url rejected: ${advertised.note}`);
      }
      if (url === null && e.port !== null) {
        const s = critLoopbackUrl(e.host, e.port);
        url = s.url;
        urlNote = s.note;
      } else if (url === null && e.port === null) {
        urlNote = urlNote ?? "no port in registry";
      }

      const mode =
        e.args.length === 0
          ? "review" // git-mode review daemon: empty args
          : CRIT_MODE_VERBS.has(e.args[0] ?? "")
            ? (e.args[0] ?? null)
            : "file";

      const classification = classifySession({ tool: "crit", mode, label: e.args.join(" ") || null, args: e.args });
      // Crit serves every surface from one daemon, but its own launcher selects
      // rendered preview/live frontends by path. Keep this policy centralized
      // and tested in navigation.ts; Plannotator registry URLs stay unchanged.
      url = sessionOpenUrl("crit", url, classification.kind);
      const info: SessionInfo = {
        id: `crit:${e.key}`,
        tool: "crit",
        pid,
        port: e.port,
        url,
        urlNote,
        cwd: e.cwd,
        branch: e.branch,
        worktree: null,
        repoRoot: null,
        repository: null,
        category: classification.category,
        kind: classification.kind,
        target: classification.target,
        classificationSource: classification.source,
        origin: null,
        originSource: null,
        parentAgentPid: null,
        parentAgentGroup: null,
        mode,
        label: e.args.length > 0 ? e.args.join(" ") : null,
        project: basename(e.cwd),
        reviewPath: e.reviewPath,
        startedAt: e.startedAt,
        updatedAt: e.registryUpdatedAt,
        commentCount: null,
        resolvedCommentCount: null,
        unresolvedCommentCount: null,
        reviewRound: null,
        browserClients: null,
        interacted: null,
        firstSeenAt: now,
        lastSeenAt: now,
        health: "unknown",
        notes,
      };
      next.set(info.id, info);

      enrich.push(
        (async () => {
          const git = await this.gitFor(e.cwd);
          if (e.cwd) {
            // Prefer live git state; fall back to the branch crit recorded at spawn.
            info.branch = git.repo ? git.branch : e.branch || null;
            info.worktree = git.repo ? git.worktree : null;
            info.repoRoot = git.repositoryRoot ?? git.toplevel;
            info.repository = basename(git.repositoryRoot ?? git.toplevel);
          }
          const origin = await this.originFor(pid);
          if (origin) {
            info.origin = origin.origin;
            info.originSource = "ancestor-process-name (heuristic)";
            info.parentAgentPid = origin.pid;
            info.parentAgentGroup = origin.group;
          }
          if (info.url && info.port !== null) {
            const base = `http://127.0.0.1:${info.port}`;
            try {
              const health = await fetch(`${base}/api/health`, { redirect: "manual", signal: AbortSignal.timeout(this.healthTimeoutMs) });
              info.health = health.status < 500 ? "ok" : "unreachable";
              const body = await health.json() as Record<string, unknown>;
              info.browserClients = typeof body.browser_clients === "number" || typeof body.browser_clients === "boolean" ? body.browser_clients : null;
            } catch { info.health = "unreachable"; }
            try {
              const rounds = await fetch(`${base}/api/rounds`, { redirect: "manual", signal: AbortSignal.timeout(this.healthTimeoutMs) });
              if (rounds.ok) {
                const body = await rounds.json() as { current_round?: unknown; rounds?: unknown };
                info.reviewRound = typeof body.current_round === "number" ? body.current_round : null;
                if (Array.isArray(body.rounds)) {
                  info.commentCount = body.rounds.reduce((sum, r) => {
                    const count = r && typeof r === "object" ? (r as Record<string, unknown>).comment_count : null;
                    return sum + (typeof count === "number" ? count : 0);
                  }, 0);
                  const timestamps = body.rounds.map(r => r && typeof r === "object" ? (r as Record<string, unknown>).captured_at : null).filter((v): v is string => typeof v === "string");
                  if (timestamps.length) info.updatedAt = timestamps.sort().at(-1) ?? info.updatedAt;
                }
              }
            } catch { /* optional metadata */ }
            info.interacted = (info.commentCount ?? 0) > 0 || (info.reviewRound ?? 1) > 1 || info.browserClients === true || (typeof info.browserClients === "number" && info.browserClients > 0);
          }
        })(),
      );
    }

    for (const e of planEntries) {
      if (e.pid === null) continue; // cannot validate
      const pid = e.pid; // narrowed local survives the async closure below
      if (!isPidAlive(pid)) continue; // server exited; self-unregistered or stale

      const notes: string[] = [];
      const san = sanitizeLoopbackUrl(e.url);
      let url = san.url;
      let urlNote = san.note;
      if (url === null && e.port !== null) {
        // Registry URL missing/malformed/remote — reconstruct from the port,
        // which is loopback by construction. A remote URL is never linked.
        if (e.url === null || e.url === "") {
          url = `http://localhost:${e.port}`;
          urlNote = "url reconstructed from registry port";
        } else {
          notes.push(`recorded url rejected: ${san.note}`);
        }
      }

      const classification = classifySession({ tool: "plannotator", mode: e.mode, label: e.label });
      const info: SessionInfo = {
        id: `plannotator:${pid}`,
        tool: "plannotator",
        pid,
        port: e.port,
        url,
        urlNote,
        cwd: null,
        branch: null,
        worktree: null,
        repoRoot: null,
        repository: null,
        category: classification.category,
        kind: classification.kind,
        target: classification.target,
        classificationSource: classification.source,
        origin: null,
        originSource: null,
        parentAgentPid: null,
        parentAgentGroup: null,
        mode: e.mode,
        label: e.label,
        project: e.project,
        reviewPath: null,
        startedAt: e.startedAt,
        updatedAt: e.registryUpdatedAt,
        commentCount: null,
        resolvedCommentCount: null,
        unresolvedCommentCount: null,
        reviewRound: null,
        browserClients: null,
        interacted: null,
        firstSeenAt: now,
        lastSeenAt: now,
        health: "unknown",
        notes,
      };
      next.set(info.id, info);

      enrich.push(
        (async () => {
          info.cwd = await this.cwdFor(pid);
          const git = await this.gitFor(info.cwd);
          if (git.repo) {
            info.branch = git.branch;
            info.worktree = git.worktree;
            info.repoRoot = git.repositoryRoot ?? git.toplevel;
            info.repository = basename(git.repositoryRoot ?? git.toplevel);
          }
          const command = await processCommand(pid);
          const refined = classifySession({ tool: "plannotator", mode: e.mode, label: e.label, command });
          info.category = refined.category;
          info.kind = refined.kind;
          info.target = refined.target;
          info.classificationSource = refined.source;
          const origin = await this.originFor(pid);
          if (origin) {
            info.origin = origin.origin;
            info.originSource = "ancestor-process-name (heuristic)";
            info.parentAgentPid = origin.pid;
            info.parentAgentGroup = origin.group;
          }
          if (info.url) {
            info.health = await probeHealth(info.url, this.healthTimeoutMs);
          }
        })(),
      );
    }

    await Promise.allSettled(enrich);

    // Preserve firstSeenAt across polls for sessions still present.
    for (const info of next.values()) {
      const prev = this.sessions.get(info.id);
      if (prev) info.firstSeenAt = prev.firstSeenAt;
    }
    this.sessions = next;

    return [...next.values()].sort((a, b) => (a.firstSeenAt < b.firstSeenAt ? 1 : -1));
  }

  /**
   * Gracefully terminate one session that is still present in the tool-owned
   * registry. The fresh poll narrows the authority to a currently discovered
   * session; arbitrary PIDs from the client are never accepted.
   */
  async closeSession(id: string): Promise<{ ok: true; session: SessionInfo } | { ok: false; reason: "not-found" | "refused" }> {
    await this.poll();
    const session = this.sessions.get(id);
    if (!session || session.pid === null) return { ok: false, reason: "not-found" };
    const pid = session.pid;
    if (pid === process.pid || pid <= 1) return { ok: false, reason: "refused" };
    try {
      process.kill(pid, "SIGTERM");
      return { ok: true, session };
    } catch {
      return { ok: false, reason: "not-found" };
    }
  }

  snapshot(): HubSnapshot {
    const sessions = [...this.sessions.values()].sort((a, b) =>
      a.firstSeenAt < b.firstSeenAt ? 1 : a.firstSeenAt > b.firstSeenAt ? -1 : a.id.localeCompare(b.id),
    );
    return {
      generatedAt: new Date().toISOString(),
      pollIntervalMs: this.pollIntervalMs,
      count: sessions.length,
      sessions,
      lastError: this.lastError,
    };
  }
}

/** Re-exported for server bind validation. */
export { isLoopbackHost };
