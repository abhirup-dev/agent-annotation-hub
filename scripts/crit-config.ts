#!/usr/bin/env bun
/**
 * Manage crit's global `~/.crit.config.json` `no_open` key safely.
 *
 *   set     merge `{"no_open": true}` while preserving every other key;
 *           snapshot the pre-existing state so uninstall restores *only* what
 *           we own. Refuses to touch unparsable config files.
 *   restore undo exactly our change: only when `no_open` is still the value
 *           we wrote (if the user changed it since, we leave it alone).
 *
 * Flags: --dry-run  print actions without writing
 *        --home DIR operate as if HOME were DIR (used by tests)
 *
 * This is first-party crit configuration (config file + CLI flags); the hub
 * never shadows or wraps the crit binary.
 */
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const LABEL = "annotation-hub";

function usage(): never {
  console.error("usage: bun run scripts/crit-config.ts set|restore [--dry-run] [--home DIR]");
  process.exit(2);
}

const args = process.argv.slice(2);
const command = args[0];
if (command !== "set" && command !== "restore") usage();

const dryRun = args.includes("--dry-run");
const homeIdx = args.indexOf("--home");
const home = homeIdx !== -1 && args[homeIdx + 1] ? path.resolve(args[homeIdx + 1]!) : os.homedir();

const configPath = path.join(home, ".crit.config.json");
const stateDir = path.join(home, ".annotation-hub", "state");
const beforePath = path.join(stateDir, "crit-config.before.json");
const backupPath = path.join(stateDir, "crit-config.backup.json");

interface ConfigFile {
  exists: boolean;
  obj: Record<string, unknown> | null; // null => exists but unparsable
  raw: string;
}

function readConfig(): ConfigFile {
  if (!existsSync(configPath)) return { exists: false, obj: {}, raw: "" };
  const raw = readFileSync(configPath, "utf8");
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { exists: true, obj: null, raw };
    }
    return { exists: true, obj: parsed as Record<string, unknown>, raw };
  } catch {
    return { exists: true, obj: null, raw };
  }
}

function writeConfig(obj: Record<string, unknown>): void {
  if (dryRun) return;
  const tempPath = `${configPath}.annotation-hub.${process.pid}.tmp`;
  const fd = openSync(tempPath, "wx", 0o600);
  try {
    writeFileSync(fd, JSON.stringify(obj, null, 2) + "\n", "utf8");
  } finally {
    closeSync(fd);
  }
  try {
    renameSync(tempPath, configPath);
  } catch (error) {
    rmSync(tempPath, { force: true });
    throw error;
  }
}

if (command === "set") {
  const cur = readConfig();
  if (cur.obj === null) {
    console.error(`${LABEL}: ${configPath} exists but is not valid JSON — refusing to modify it.`);
    console.error(`${LABEL}: set "no_open": true manually, then re-run to record state.`);
    process.exit(1);
  }
  if (cur.obj.no_open === true) {
    console.log(`${LABEL}: crit no_open already true — nothing to do.`);
    process.exit(0);
  }
  const before = { present: "no_open" in cur.obj, value: cur.obj.no_open ?? null };
  if (dryRun) {
    console.log(`[dry-run] would back up ${configPath} -> ${backupPath}`);
    console.log(`[dry-run] would record prior state -> ${beforePath}`);
    console.log(`[dry-run] would write ${configPath} with no_open: true (other keys preserved)`);
    process.exit(0);
  }
  mkdirSync(stateDir, { recursive: true });
  if (cur.exists && !existsSync(backupPath)) {
    writeFileSync(backupPath, cur.raw, "utf8"); // first snapshot wins
  }
  writeFileSync(beforePath, JSON.stringify(before, null, 2) + "\n", "utf8");
  writeConfig({ ...cur.obj, no_open: true });
  console.log(`${LABEL}: crit no_open set to true (browser auto-open disabled for all crit invocations).`);
  console.log(`${LABEL}: prior state recorded in ${beforePath}`);
  process.exit(0);
}

// restore
if (!existsSync(beforePath)) {
  console.log(`${LABEL}: crit config not managed by us — nothing to restore.`);
  process.exit(0);
}
let before: { present: boolean; value: unknown };
try {
  before = JSON.parse(readFileSync(beforePath, "utf8")) as { present: boolean; value: unknown };
} catch (e) {
  console.error(`${LABEL}: cannot read ${beforePath} (${e instanceof Error ? e.message : e}) — leaving crit config as-is.`);
  process.exit(1);
}
const cur = readConfig();
if (cur.obj === null) {
  console.error(`${LABEL}: ${configPath} is not valid JSON — leaving it alone.`);
  process.exit(1);
}
if (cur.obj.no_open !== true) {
  console.log(`${LABEL}: no_open is no longer true (changed since install) — leaving user value in place.`);
  if (!dryRun) rmSync(beforePath, { force: true });
  process.exit(0);
}
if (before.present && before.value === true) {
  console.log(`${LABEL}: no_open was already true before install — leaving it true.`);
  if (!dryRun) rmSync(beforePath, { force: true });
  process.exit(0);
}
if (dryRun) {
  console.log(`[dry-run] would restore no_open to ${before.present ? JSON.stringify(before.value) : "absent"} in ${configPath}`);
  process.exit(0);
}
const next = { ...cur.obj };
if (before.present) next.no_open = before.value;
else delete next.no_open;
writeConfig(next);
rmSync(beforePath, { force: true });
rmSync(backupPath, { force: true });
console.log(`${LABEL}: crit no_open restored to ${before.present ? JSON.stringify(before.value) : "absent"}.`);
