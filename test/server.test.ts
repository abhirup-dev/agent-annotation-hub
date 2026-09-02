import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, test } from "bun:test";
import { Hub } from "../src/hub";
import { startServer } from "../src/server";

const tmpRoots: string[] = [];
afterAll(() => {
  // temp dirs are left for the OS to clean; nothing persistent is created here
  void tmpRoots;
});

function freshDirs(): { critHome: string; planDir: string } {
  const root = mkdtempSync(path.join(os.tmpdir(), "aah-server-"));
  tmpRoots.push(root);
  return { critHome: path.join(root, "crit"), planDir: path.join(root, "plan") };
}

describe("HTTP server", () => {
  test("binds loopback, serves UI + JSON, 404s unknown, rejects non-GET", async () => {
    const dirs = freshDirs();
    const hub = new Hub({ critHome: dirs.critHome, plannotatorDataDir: dirs.planDir, pollIntervalMs: 60_000, healthTimeoutMs: 100 });
    const run = startServer(hub, { hostname: "127.0.0.1", port: 0 });
    try {
      const base = `http://127.0.0.1:${run.port}`;

      const health = await (await fetch(`${base}/api/health`)).json();
      expect(health.status).toBe("ok");
      expect(health.hostname).toBe("127.0.0.1");
      expect(health.pollIntervalMs).toBe(60_000);
      expect(health.sessionCounts).toEqual({ crit: 0, plannotator: 0 });
      expect(health.versions).toHaveProperty("crit");
      expect(health.versions).toHaveProperty("plannotator");
      expect(health.compatibility.crit).toHaveProperty("verifiedAgainst", "0.19.0");
      expect(health.compatibility.plannotator).toHaveProperty("verifiedAgainst", "0.27.8");

      const sessions = await (await fetch(`${base}/api/sessions`)).json();
      expect(sessions.count).toBe(0);
      expect(sessions.sessions).toEqual([]);
      expect(sessions.pollIntervalMs).toBe(60_000);

      const html = await (await fetch(base)).text();
      expect(html).toContain("Agent Annotation Hub");
      expect(html).toContain('target=\"_blank\"');
      expect(html).toContain('rel=\"noopener\"');
      expect(html).toContain('id=\"table-view\"');
      expect(html).toContain('List (classic)');
      expect(html).toContain('Review kind');
      expect(html).toContain('addEventListener("dblclick"');
      expect(html).toContain("Close session?");
      expect(html).toContain("x-annotation-hub-action");

      const notFound = await fetch(`${base}/api/nope`);
      expect(notFound.status).toBe(404);
      expect((await notFound.json()).error).toBe("not found");

      const post = await fetch(`${base}/api/sessions`, { method: "POST" });
      expect(post.status).toBe(405);

      // no-store so the UI never shows stale session lists
      const cache = (await fetch(`${base}/api/sessions`)).headers.get("cache-control");
      expect(cache).toContain("no-store");
    } finally {
      await run.stop();
    }
  });

  test("close endpoint requires confirmation header and terminates only a discovered session", async () => {
    const dirs = freshDirs();
    const sessionsDir = path.join(dirs.planDir, "sessions");
    mkdirSync(sessionsDir, { recursive: true });
    const child = Bun.spawn(["sleep", "30"], { stdout: "ignore", stderr: "ignore" });
    writeFileSync(
      path.join(sessionsDir, `${child.pid}.json`),
      JSON.stringify({
        pid: child.pid,
        port: 49123,
        url: "http://localhost:49123",
        mode: "review",
        project: "close-test",
        startedAt: new Date().toISOString(),
      }),
    );
    const hub = new Hub({ critHome: dirs.critHome, plannotatorDataDir: dirs.planDir, pollIntervalMs: 60_000, healthTimeoutMs: 20 });
    const run = startServer(hub, { hostname: "127.0.0.1", port: 0 });
    try {
      await run.forcePoll();
      const base = `http://127.0.0.1:${run.port}`;
      const endpoint = `${base}/api/sessions/${encodeURIComponent(`plannotator:${child.pid}`)}/close`;

      expect((await fetch(endpoint, { method: "POST" })).status).toBe(403);
      expect(child.exitCode).toBeNull();

      const closed = await fetch(endpoint, {
        method: "POST",
        headers: { "x-annotation-hub-action": "close-session" },
      });
      expect(closed.status).toBe(202);
      expect((await closed.json()).signal).toBe("SIGTERM");
      await child.exited;
      expect(() => process.kill(child.pid, 0)).toThrow();

      const unknown = await fetch(`${base}/api/sessions/plannotator%3A999999/close`, {
        method: "POST",
        headers: { "x-annotation-hub-action": "close-session" },
      });
      expect(unknown.status).toBe(404);
    } finally {
      if (child.exitCode === null) child.kill("SIGKILL");
      await run.stop();
    }
  });

  test("refuses to bind a non-loopback hostname", () => {
    const dirs = freshDirs();
    const hub = new Hub({ ...dirs });
    expect(() => startServer(hub, { hostname: "0.0.0.0", port: 0 })).toThrow(/loopback/);
  });
});
