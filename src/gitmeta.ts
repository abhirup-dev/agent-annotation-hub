/**
 * Git metadata for a session cwd, with a small TTL cache so the ~2s poll loop
 * does not spawn `git` for unchanged directories.
 *
 * Only metadata is read: current branch and linked-worktree detection.
 * Worktrees are detected by comparing `--git-dir` with `--git-common-dir`
 * (they differ inside `git worktree add` checkouts). No file contents are read.
 */
import path from "node:path";
import { runCapture } from "./proc";

export interface GitInfo {
  repo: boolean;
  branch: string | null;
  worktree: boolean | null;
  toplevel: string | null;
  /** Main checkout root, shared by linked worktrees. */
  repositoryRoot: string | null;
}

const NO_REPO: GitInfo = { repo: false, branch: null, worktree: null, toplevel: null, repositoryRoot: null };

async function probeGit(cwd: string): Promise<GitInfo> {
  const rev = await runCapture(
    ["git", "-C", cwd, "rev-parse", "--show-toplevel", "--git-dir", "--git-common-dir"],
    2500,
  );
  if (!rev.ok) return NO_REPO;
  const lines = rev.stdout.trim().split("\n");
  if (lines.length < 3) return NO_REPO;
  const toplevel = lines[0]?.trim() || null;
  const gitDir = lines[1]?.trim() ?? "";
  const commonDir = lines[2]?.trim() ?? "";
  if (!gitDir || !commonDir) return NO_REPO;
  const norm = (p: string) => (path.isAbsolute(p) ? path.normalize(p) : path.resolve(cwd, p));
  const normalizedCommon = norm(commonDir);
  const worktree = norm(gitDir) !== normalizedCommon;
  const repositoryRoot = path.basename(normalizedCommon) === ".git" ? path.dirname(normalizedCommon) : toplevel;

  const b = await runCapture(["git", "-C", cwd, "branch", "--show-current"], 2500);
  const branch = b.ok ? b.stdout.trim() || null : null; // empty => detached HEAD
  return { repo: true, branch, worktree, toplevel, repositoryRoot };
}

export class GitMetaCache {
  private readonly ttlMs: number;
  private readonly cache = new Map<string, { at: number; value: GitInfo }>();

  constructor(ttlMs = 10_000) {
    this.ttlMs = ttlMs;
  }

  async get(cwd: string): Promise<GitInfo> {
    const hit = this.cache.get(cwd);
    if (hit && Date.now() - hit.at < this.ttlMs) return hit.value;
    const value = await probeGit(cwd);
    this.cache.set(cwd, { at: Date.now(), value });
    return value;
  }

  clear(): void {
    this.cache.clear();
  }
}
