/**
 * Crit session discovery — primary source: the per-user registry at
 * `~/.crit/sessions/<key>.json` (one JSON file per daemon; `<key>.log` and
 * `<key>.lock` siblings are ignored).
 *
 * Verified against crit 0.18.1:
 *   { pid, port, host, cwd, args, branch, review_path, started_at }
 *
 * Notes:
 * - Registry files are read-only for the hub; pruning happens in our view
 *   only (we never delete crit's files or run `crit cleanup`).
 * - Review *contents* (review.json) are intentionally never read — they hold
 *   review/comment text.
 * - `review_path` points at the identity *directory*; it is surfaced as a
 *   path only, never dereferenced.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseStrictPid, parseStrictPort } from "./loopback";
import type { RawCritEntry } from "./types";
import { normalizeTimestamp } from "./util";

const KEY_RE = /^[0-9a-f]{4,64}$/i;

export function defaultCritHome(): string {
  return path.join(os.homedir(), ".crit");
}

export function readCritRaw(critHome: string = defaultCritHome()): RawCritEntry[] {
  const dir = path.join(critHome, "sessions");
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return []; // crit not used yet, or dir unreadable — not an error state
  }
  const out: RawCritEntry[] = [];
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    const key = name.slice(0, -5);
    if (!KEY_RE.test(key)) continue;
    const filePath = path.join(dir, name);
    let obj: unknown;
    try {
      obj = JSON.parse(readFileSync(filePath, "utf8"));
    } catch {
      continue; // tolerate corrupt/partial writes
    }
    if (obj === null || typeof obj !== "object" || Array.isArray(obj)) continue;
    const o = obj as Record<string, unknown>;
    out.push({
      key,
      pid: parseStrictPid(o.pid),
      port: parseStrictPort(o.port),
      host: typeof o.host === "string" ? o.host : "",
      publicUrl: typeof o.public_url === "string" ? o.public_url : null,
      cwd: typeof o.cwd === "string" ? o.cwd : null,
      args: Array.isArray(o.args) ? o.args.filter((a): a is string => typeof a === "string") : [],
      branch: typeof o.branch === "string" ? o.branch : null,
      reviewPath: typeof o.review_path === "string" ? o.review_path : null,
      startedAt: normalizeTimestamp(o.started_at),
      registryUpdatedAt: (() => { try { return statSync(filePath).mtime.toISOString(); } catch { return null; } })(),
    });
  }
  return out;
}
