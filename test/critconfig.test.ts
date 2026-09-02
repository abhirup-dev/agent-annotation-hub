import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "bun:test";

const SCRIPT = path.resolve(import.meta.dir, "..", "scripts", "crit-config.ts");
const homes: string[] = [];

function newHome(): string {
  const h = mkdtempSync(path.join(os.tmpdir(), "aah-critcfg-"));
  homes.push(h);
  return h;
}

afterEach(() => {
  for (const h of homes) rmSync(h, { recursive: true, force: true });
  homes.length = 0;
});

async function run(home: string, ...args: string[]): Promise<{ code: number; out: string }> {
  const proc = Bun.spawn(["bun", "run", SCRIPT, ...args, "--home", home], {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const out = await new Response(proc.stdout).text();
  const err = await new Response(proc.stderr).text();
  const code = await proc.exited;
  return { code, out: out + err };
}

function readConfig(home: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path.join(home, ".crit.config.json"), "utf8"));
}

describe("scripts/crit-config.ts", () => {
  test("set creates config, preserves foreign keys, records prior state", async () => {
    const home = newHome();
    writeFileSync(path.join(home, ".crit.config.json"), JSON.stringify({ open_cmd: "/usr/bin/true" }));

    const r = await run(home, "set");
    expect(r.code).toBe(0);

    const cfg = readConfig(home);
    expect(cfg.no_open).toBe(true); // our key
    expect(cfg.open_cmd).toBe("/usr/bin/true"); // foreign key preserved

    const before = JSON.parse(
      readFileSync(path.join(home, ".annotation-hub", "state", "crit-config.before.json"), "utf8"),
    );
    expect(before).toEqual({ present: false, value: null });
    expect(existsSync(path.join(home, ".annotation-hub", "state", "crit-config.backup.json"))).toBeTrue();
  });

  test("set is idempotent when no_open is already true", async () => {
    const home = newHome();
    writeFileSync(path.join(home, ".crit.config.json"), JSON.stringify({ no_open: true, keep: 1 }));
    const r = await run(home, "set");
    expect(r.code).toBe(0);
    expect(r.out).toContain("already true");
    expect(readConfig(home)).toEqual({ no_open: true, keep: 1 });
    expect(existsSync(path.join(home, ".annotation-hub", "state", "crit-config.before.json"))).toBeFalse();
  });

  test("restore removes exactly what we set, preserving keys added since", async () => {
    const home = newHome();
    mkdirSync(path.join(home), { recursive: true });
    writeFileSync(path.join(home, ".crit.config.json"), JSON.stringify({ alpha: 1 }));
    expect((await run(home, "set")).code).toBe(0);
    // user (or crit) adds another key after our install
    writeFileSync(path.join(home, ".crit.config.json"), JSON.stringify({ alpha: 1, no_open: true, beta: 2 }));

    const r = await run(home, "restore");
    expect(r.code).toBe(0);
    expect(readConfig(home)).toEqual({ alpha: 1, beta: 2 }); // no_open gone, others intact
  });

  test("restore leaves a user-changed value alone", async () => {
    const home = newHome();
    expect((await run(home, "set")).code).toBe(0);
    // user explicitly re-enables opening after our install
    writeFileSync(path.join(home, ".crit.config.json"), JSON.stringify({ no_open: false }));
    const r = await run(home, "restore");
    expect(r.code).toBe(0);
    expect(readConfig(home)).toEqual({ no_open: false });
  });

  test("set refuses to touch unparsable config", async () => {
    const home = newHome();
    writeFileSync(path.join(home, ".crit.config.json"), "{ broken");
    const r = await run(home, "set");
    expect(r.code).toBe(1);
    expect(readFileSync(path.join(home, ".crit.config.json"), "utf8")).toBe("{ broken");
  });

  test("restore without prior set is a no-op", async () => {
    const home = newHome();
    const r = await run(home, "restore");
    expect(r.code).toBe(0);
    expect(r.out).toContain("not managed");
    expect(existsSync(path.join(home, ".crit.config.json"))).toBeFalse();
  });

  test("dry-run writes nothing", async () => {
    const home = newHome();
    const r = await run(home, "set", "--dry-run");
    expect(r.code).toBe(0);
    expect(existsSync(path.join(home, ".crit.config.json"))).toBeFalse();
    expect(existsSync(path.join(home, ".annotation-hub"))).toBeFalse();
  });
});
