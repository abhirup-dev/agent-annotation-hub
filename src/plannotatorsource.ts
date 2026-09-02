/**
 * Plannotator session discovery — primary source: the per-user registry at
 * `<data-dir>/sessions/<pid>.json`.
 *
 * Verified against plannotator 0.27.7:
 *   { pid, port, url, mode, project, startedAt, label }
 *
 * Data-dir resolution order (per upstream docs, verified on this machine):
 *   PLANNOTATOR_DATA_DIR -> existing ~/.plannotator -> $XDG_DATA_HOME/plannotator
 *   (when absolute) -> ~/.plannotator
 *
 * The registry does not record `cwd`; when the PID is alive the hub recovers
 * it read-only via `lsof`. Registry files are never written or deleted here
 * (the server unregisters itself on exit; our pruning is view-only).
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseStrictPid, parseStrictPort } from "./loopback";
import type { RawPlanEntry } from "./types";
import { normalizeTimestamp } from "./util";

const PID_FILE_RE = /^(\d{1,8})\.json$/;

export function resolvePlannotatorDataDir(
  env: Record<string, string | undefined> = process.env,
  homedirFn: () => string = os.homedir,
  exists: (p: string) => boolean = existsSync,
): string {
  const fromEnv = env.PLANNOTATOR_DATA_DIR?.trim();
  if (fromEnv) return fromEnv;
  const dot = path.join(homedirFn(), ".plannotator");
  if (exists(dot)) return dot;
  const xdg = env.XDG_DATA_HOME?.trim();
  if (xdg && path.isAbsolute(xdg)) return path.join(xdg, "plannotator");
  return dot;
}

export function readPlanRaw(dataDir: string): RawPlanEntry[] {
  const dir = path.join(dataDir, "sessions");
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  const out: RawPlanEntry[] = [];
  for (const name of names) {
    const m = PID_FILE_RE.exec(name);
    if (!m) continue;
    const filePid = parseStrictPid(Number(m[1]));
    const filePath = path.join(dir, name);
    let obj: unknown;
    try {
      obj = JSON.parse(readFileSync(filePath, "utf8"));
    } catch {
      continue;
    }
    if (obj === null || typeof obj !== "object" || Array.isArray(obj)) continue;
    const o = obj as Record<string, unknown>;
    out.push({
      // Prefer the recorded pid; fall back to the filename pid.
      pid: parseStrictPid(o.pid) ?? filePid,
      port: parseStrictPort(o.port),
      url: typeof o.url === "string" ? o.url : null,
      mode: typeof o.mode === "string" ? o.mode : null,
      project: typeof o.project === "string" ? o.project : null,
      startedAt: normalizeTimestamp(o.startedAt),
      registryUpdatedAt: (() => { try { return statSync(filePath).mtime.toISOString(); } catch { return null; } })(),
      label: typeof o.label === "string" ? o.label : null,
    });
  }
  return out;
}
