#!/usr/bin/env bun
/** Read-only installed-tool and live-navigation compatibility check. */
import { readCritRaw } from "../src/critsource";
import { readPlanRaw, resolvePlannotatorDataDir } from "../src/plannotatorsource";
import { classifySession } from "../src/classify";
import { critLoopbackUrl, sanitizeLoopbackUrl } from "../src/loopback";
import { sessionOpenUrl } from "../src/navigation";
import { isPidAlive, runCapture } from "../src/proc";

const failures: string[] = [];
const checks: string[] = [];

for (const bin of ["crit", "plannotator"]) {
  const r = await runCapture([bin, "--version"], 5000);
  const version = (r.stdout + r.stderr).trim().split("\n").find((line) => line.toLowerCase().includes(bin)) ?? "unavailable";
  if (!r.ok) failures.push(`${bin}: --version failed`);
  else checks.push(`${bin}: ${version}`);
}

for (const entry of readCritRaw()) {
  if (!entry.pid || !entry.port || !isPidAlive(entry.pid)) continue;
  const mode = entry.args.length === 0 ? "review" : entry.args[0] ?? "file";
  const c = classifySession({ tool: "crit", mode, label: entry.args.join(" ") || null, args: entry.args });
  let base: string | null = null;
  if (entry.publicUrl) base = sanitizeLoopbackUrl(entry.publicUrl).url;
  base ??= critLoopbackUrl(entry.host, entry.port).url;
  const expected = sessionOpenUrl("crit", base, c.kind);
  if (!expected) continue;
  try {
    const r = await fetch(expected, { redirect: "manual", signal: AbortSignal.timeout(1500) });
    if (r.status >= 500) failures.push(`${entry.key}: ${expected} returned ${r.status}`);
    else checks.push(`${entry.key}: ${c.kind} -> ${new URL(expected).pathname || "/"}`);
  } catch {
    failures.push(`${entry.key}: ${expected} unreachable`);
  }
}

for (const entry of readPlanRaw(resolvePlannotatorDataDir())) {
  if (!entry.pid || !entry.url || !isPidAlive(entry.pid)) continue;
  const safe = sanitizeLoopbackUrl(entry.url).url;
  if (!safe) continue;
  const expected = sessionOpenUrl("plannotator", safe, "unknown");
  if (expected !== safe) failures.push(`plannotator:${entry.pid}: registry URL was rewritten`);
  try {
    const r = await fetch(safe, { redirect: "manual", signal: AbortSignal.timeout(1500) });
    if (r.status >= 500) failures.push(`plannotator:${entry.pid}: ${safe} returned ${r.status}`);
    else checks.push(`plannotator:${entry.pid}: ${entry.mode ?? "unknown"} -> registry URL unchanged`);
  } catch {
    failures.push(`plannotator:${entry.pid}: ${safe} unreachable`);
  }
}

for (const line of checks) console.log(`✓ ${line}`);
if (failures.length) {
  for (const line of failures) console.error(`✗ ${line}`);
  process.exit(1);
}
console.log(`\nParity check passed (${checks.length} checks).`);
