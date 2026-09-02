import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, test } from "bun:test";
import { readCritRaw } from "../src/critsource";
import { readPlanRaw, resolvePlannotatorDataDir } from "../src/plannotatorsource";

function tmp(): string {
  return mkdtempSync(path.join(os.tmpdir(), "aah-sources-"));
}

describe("readCritRaw", () => {
  test("parses a verified-schema registry entry and tolerates junk", () => {
    const home = tmp();
    const sessions = path.join(home, "sessions");
    mkdirSync(sessions, { recursive: true });
    // Live-verified shape (crit 0.18.1).
    writeFileSync(
      path.join(sessions, "abc123def456.json"),
      JSON.stringify({
        pid: 123,
        port: 49171,
        host: "127.0.0.1",
        public_url: "http://localhost:49171/prefix",
        cwd: "/tmp/repo",
        args: ["preview", "/tmp/repo/x.html"],
        branch: "main",
        review_path: "/Users/x/.crit/reviews/abc123def456",
        started_at: "2026-08-19T06:59:38.771342Z",
      }),
    );
    // Malformed JSON is skipped, not fatal.
    writeFileSync(path.join(sessions, "badbadbad000.json"), "{not json");
    // Non-session files ignored.
    writeFileSync(path.join(sessions, "abc123def456.log"), "log");
    writeFileSync(path.join(sessions, "README.md"), "{}");

    const entries = readCritRaw(home);
    expect(entries).toHaveLength(1);
    const e = entries[0]!;
    expect(e.key).toBe("abc123def456");
    expect(e.pid).toBe(123);
    expect(e.port).toBe(49171);
    expect(e.publicUrl).toBe("http://localhost:49171/prefix");
    expect(e.cwd).toBe("/tmp/repo");
    expect(e.args).toEqual(["preview", "/tmp/repo/x.html"]);
    expect(e.branch).toBe("main");
    expect(e.startedAt).toBe("2026-08-19T06:59:38.771Z");
  });

  test("invalid pid/port types degrade to null instead of crashing", () => {
    const home = tmp();
    const sessions = path.join(home, "sessions");
    mkdirSync(sessions, { recursive: true });
    writeFileSync(
      path.join(sessions, "ffffffffffff.json"),
      JSON.stringify({ pid: "123", port: null, cwd: 42, args: "nope", host: 7 }),
    );
    const entries = readCritRaw(home);
    expect(entries).toHaveLength(1);
    expect(entries[0]!.pid).toBeNull();
    expect(entries[0]!.port).toBeNull();
    expect(entries[0]!.cwd).toBeNull();
    expect(entries[0]!.args).toEqual([]);
    expect(entries[0]!.host).toBe("");
  });

  test("missing sessions dir is an empty result", () => {
    expect(readCritRaw(path.join(tmp(), "nope"))).toEqual([]);
  });
});

describe("readPlanRaw", () => {
  test("parses a verified-schema registry entry and falls back to filename pid", () => {
    const dataDir = tmp();
    const sessions = path.join(dataDir, "sessions");
    mkdirSync(sessions, { recursive: true });
    // Live-verified shape (plannotator 0.27.7).
    writeFileSync(
      path.join(sessions, "45678.json"),
      JSON.stringify({
        pid: 45678,
        port: 51723,
        url: "http://localhost:51723",
        mode: "plan",
        project: "my-repo",
        startedAt: "2026-08-20T10:15:30.000Z",
        label: "plan-plan.md",
      }),
    );
    writeFileSync(path.join(sessions, "corrupt.json"), "]]]");
    const entries = readPlanRaw(dataDir);
    expect(entries).toHaveLength(1);
    const e = entries[0]!;
    expect(e.pid).toBe(45678);
    expect(e.url).toBe("http://localhost:51723");
    expect(e.mode).toBe("plan");
    expect(e.startedAt).toBe("2026-08-20T10:15:30.000Z");
  });

  test("filename pid used when body pid is garbage", () => {
    const dataDir = tmp();
    const sessions = path.join(dataDir, "sessions");
    mkdirSync(sessions, { recursive: true });
    writeFileSync(path.join(sessions, "999.json"), JSON.stringify({ pid: "x", port: 1, url: null }));
    const entries = readPlanRaw(dataDir);
    expect(entries[0]!.pid).toBe(999);
  });
});

describe("resolvePlannotatorDataDir", () => {
  const existsNone = () => false;
  test("env var wins", () => {
    expect(resolvePlannotatorDataDir({ PLANNOTATOR_DATA_DIR: "/x/y" }, () => "/h", existsNone)).toBe("/x/y");
  });
  test("existing ~/.plannotator beats XDG", () => {
    expect(
      resolvePlannotatorDataDir({ XDG_DATA_HOME: "/xdg" }, () => "/h", (p) => p === "/h/.plannotator"),
    ).toBe("/h/.plannotator");
  });
  test("absolute XDG used when ~/.plannotator absent", () => {
    expect(resolvePlannotatorDataDir({ XDG_DATA_HOME: "/xdg" }, () => "/h", existsNone)).toBe("/xdg/plannotator");
  });
  test("relative XDG ignored -> default", () => {
    expect(resolvePlannotatorDataDir({ XDG_DATA_HOME: "rel" }, () => "/h", existsNone)).toBe("/h/.plannotator");
  });
});
