import { mkdtempSync, realpathSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, test } from "bun:test";
import { detectOriginByAncestors, isPidAlive, lsofCwd, runCapture } from "../src/proc";

function spawnSleeper(cwd?: string): Bun.Subprocess {
  return Bun.spawn(["sleep", "30"], { cwd, stdin: "ignore", stdout: "ignore", stderr: "ignore" });
}

describe("isPidAlive", () => {
  test("live vs dead", async () => {
    const child = spawnSleeper();
    const pid = child.pid!;
    expect(isPidAlive(pid)).toBeTrue();
    child.kill();
    await child.exited;
    expect(isPidAlive(pid)).toBeFalse();
  });
  test("impossible pid", () => {
    expect(isPidAlive(4194304)).toBeFalse();
  });
});

describe("runCapture", () => {
  test("captures stdout and never throws", async () => {
    const r = await runCapture(["echo", "hi"]);
    expect(r.ok).toBeTrue();
    expect(r.stdout.trim()).toBe("hi");
  });
  test("non-zero exit is not ok", async () => {
    const r = await runCapture(["false"]);
    expect(r.ok).toBeFalse();
  });
  test("missing binary never throws", async () => {
    const r = await runCapture(["definitely-not-a-binary-xyz", "--version"]);
    expect(r.ok).toBeFalse();
    expect(r.stdout).toBe("");
  });
});

describe("lsofCwd", () => {
  test("recovers the cwd of a same-user child process", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "aah-cwd-"));
    const child = spawnSleeper(dir);
    try {
      const cwd = await lsofCwd(child.pid!);
      // lsof reports the symlink-resolved path (macOS /var -> /private/var).
      expect(cwd).toBe(realpathSync(dir));
    } finally {
      child.kill();
      await child.exited;
    }
  });
  test("dead pid yields null", async () => {
    const child = spawnSleeper();
    const pid = child.pid!;
    child.kill();
    await child.exited;
    expect(await lsofCwd(pid)).toBeNull();
  });
});

describe("detectOriginByAncestors", () => {
  test("returns string|null and never throws for any pid", async () => {
    const v = await detectOriginByAncestors(process.pid);
    expect(v === null || typeof v === "string").toBeTrue();
    expect(await detectOriginByAncestors(1)).toBeNull();
  });
});
