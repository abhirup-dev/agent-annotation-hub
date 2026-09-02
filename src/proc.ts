/**
 * Read-only process introspection.
 *
 * - `ps eww` (environment reading) is NOT used: hardened-runtime binaries on
 *   macOS reject it. We never read other processes' environments.
 * - `lsof` cwd recovery and `ps` parent/comm walks work for same-user
 *   processes and are the only OS-level fallbacks the hub relies on.
 * - Origin detection from ancestor process names is a *heuristic*, not proof.
 */

/** `kill -0` liveness probe. EPERM means the process exists but is not ours. */
export function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException)?.code === "EPERM";
  }
}

/**
 * Run a CLI and capture stdout/stderr. Always uses an argv array — never a
 * shell string — so discovered values can never inject shell syntax.
 * Never throws; timeouts kill the child.
 */
export async function runCapture(
  cmd: string[],
  timeoutMs = 3000,
): Promise<{ ok: boolean; code: number | null; stdout: string; stderr: string }> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const proc = Bun.spawn(cmd, { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
    timer = setTimeout(() => {
      try {
        proc.kill();
      } catch {
        /* already exited */
      }
    }, timeoutMs);
    const [stdout, stderr] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    const code = await proc.exited;
    return { ok: code === 0, code, stdout, stderr };
  } catch {
    return { ok: false, code: null, stdout: "", stderr: "" };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Best-effort full launch command. Used only to classify session surfaces. */
export async function processCommand(pid: number): Promise<string | null> {
  const r = await runCapture(["ps", "-ww", "-o", "command=", "-p", String(pid)], 2000);
  const command = r.ok ? r.stdout.trim() : "";
  return command || null;
}

/** Recover a same-user process's working directory via lsof. Read-only. */
export async function lsofCwd(pid: number): Promise<string | null> {
  const r = await runCapture(["lsof", "-a", "-p", String(pid), "-d", "cwd", "-Fn"]);
  if (!r.ok) return null;
  for (const line of r.stdout.split("\n")) {
    if (line.startsWith("n") && line.length > 1) return line.slice(1);
  }
  return null;
}

/**
 * Ancestor process-name walk. Matches the same agent names plannotator's
 * origin ladder recognizes, but via `ps` comm strings. Best-effort only:
 * a miss returns null; a hit is evidence, not proof.
 */
const ORIGIN_RULES: ReadonlyArray<readonly [RegExp, string]> = [
  [/^claude(-code)?$/i, "claude-code"],
  [/^codex$/i, "codex"],
  [/^copilot(-cli)?$/i, "copilot-cli"],
  [/^opencode$/i, "opencode"],
  [/^gemini(-cli)?$/i, "gemini-cli"],
  [/^droid$/i, "droid"],
  [/^kiro(-cli)?$/i, "kiro-cli"],
  [/^amp$/i, "amp"],
  [/^pi$/i, "pi"],
  [/^oh-my-pi$/i, "oh-my-pi"],
];

export interface AgentAncestor {
  origin: string;
  pid: number;
  group: string;
}

export async function detectAgentAncestor(startPid: number, maxDepth = 8): Promise<AgentAncestor | null> {
  let pid = startPid;
  const seen = new Set<number>();
  for (let depth = 0; depth < maxDepth; depth++) {
    if (!Number.isInteger(pid) || pid <= 1 || seen.has(pid)) break;
    seen.add(pid);
    const r = await runCapture(["ps", "-o", "ppid=,comm=", "-p", String(pid)], 2000);
    if (!r.ok) break;
    const line = r.stdout.trim();
    if (!line) break;
    const m = line.match(/^\s*(\d+)\s+(.+)$/);
    if (!m) break;
    const comm = m[2]!.trim();
    const stem = (comm.split("/").pop() ?? comm).replace(/\.(exe|command)$/i, "");
    for (const [re, name] of ORIGIN_RULES) {
      if (re.test(stem)) return { origin: name, pid, group: `${name}:${pid}` };
    }
    pid = Number(m[1]);
    if (!Number.isInteger(pid)) break;
  }
  return null;
}

export async function detectOriginByAncestors(startPid: number, maxDepth = 8): Promise<string | null> {
  return (await detectAgentAncestor(startPid, maxDepth))?.origin ?? null;
}
