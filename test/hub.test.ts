import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, test } from "bun:test";
import { Hub } from "../src/hub";

const children: Bun.Subprocess[] = [];
afterAll(() => {
  for (const c of children) c.kill();
});

function tmp(): string {
  return mkdtempSync(path.join(os.tmpdir(), "aah-hub-"));
}

function spawnSleeper(cwd: string): Bun.Subprocess {
  const c = Bun.spawn(["sleep", "30"], { cwd, stdin: "ignore", stdout: "ignore", stderr: "ignore" });
  children.push(c);
  return c;
}

function makeHub(critHome: string, planDir: string): Hub {
  return new Hub({
    critHome,
    plannotatorDataDir: planDir,
    pollIntervalMs: 2000,
    healthTimeoutMs: 250,
    gitTtlMs: 60_000,
  });
}

describe("Hub poll (integration against real registries + real processes)", () => {
  test("discovers, enriches, and prunes sessions", async () => {
    const critHome = tmp();
    const planDir = tmp();
    const planWorkdir = tmp();
    mkdirSync(path.join(critHome, "sessions"), { recursive: true });
    mkdirSync(path.join(planDir, "sessions"), { recursive: true });

    // --- crit: one live daemon (this test process), one stale entry ---
    writeFileSync(
      path.join(critHome, "sessions", "aaaa11112222.json"),
      JSON.stringify({
        pid: process.pid,
        port: 1, // nothing listens on privileged port 1 -> health "unreachable", still listed
        host: "127.0.0.1",
        cwd: planWorkdir, // not a git repo -> branch null
        args: ["preview", "/tmp/x.html"],
        branch: "stale-branch-from-registry",
        review_path: "/x/.crit/reviews/aaaa11112222",
        started_at: "2026-08-19T06:59:38.771342Z",
      }),
    );
    writeFileSync(
      path.join(critHome, "sessions", "deaddeaddead.json"),
      JSON.stringify({ pid: 4194304, port: 2, host: "", cwd: "/tmp", args: [], branch: "" }),
    );

    // --- plannotator: two live children — one loopback url, one remote url ---
    const good = spawnSleeper(planWorkdir);
    const remote = spawnSleeper(planWorkdir);
    writeFileSync(
      path.join(planDir, "sessions", `${good.pid}.json`),
      JSON.stringify({
        pid: good.pid,
        port: 1,
        url: "http://localhost:1",
        mode: "annotate",
        project: "probe",
        startedAt: "2026-08-24T16:26:00.210Z",
        label: "annotate-d.md",
      }),
    );
    writeFileSync(
      path.join(planDir, "sessions", `${remote.pid}.json`),
      JSON.stringify({
        pid: remote.pid,
        port: 443,
        url: "https://tunnel.example.com/abc",
        mode: "review",
        project: "tun",
        startedAt: "2026-08-24T16:26:00.210Z",
        label: "review",
      }),
    );

    const hub = makeHub(critHome, planDir);
    let sessions = await hub.poll();

    expect(sessions).toHaveLength(3); // dead crit entry pruned from view

    const crit = sessions.find((s) => s.id === "crit:aaaa11112222")!;
    expect(crit.tool).toBe("crit");
    expect(crit.url).toBe("http://localhost:1/preview");
    expect(crit.health).toBe("unreachable"); // down daemon is listed, just marked
    expect(crit.mode).toBe("preview");
    expect(crit.branch).toBe("stale-branch-from-registry"); // cwd is not a repo: crit's recorded value is kept
    expect(crit.worktree).toBeNull();
    expect(crit.reviewPath).toBe("/x/.crit/reviews/aaaa11112222");
    expect(crit.pid).toBe(process.pid);
    // startedAt normalized from nanosecond precision
    expect(crit.startedAt).toBe("2026-08-19T06:59:38.771Z");

    const goodPlan = sessions.find((s) => s.id === `plannotator:${good.pid}`)!;
    expect(goodPlan.url).toBe("http://localhost:1/");
    expect(goodPlan.cwd).toBe(realpathSync(planWorkdir)); // lsof resolves /var -> /private/var
    expect(goodPlan.mode).toBe("annotate");
    expect(goodPlan.project).toBe("probe");
    expect(goodPlan.health).toBe("unreachable");

    const remotePlan = sessions.find((s) => s.id === `plannotator:${remote.pid}`)!;
    expect(remotePlan.url).toBeNull(); // remote URL is never exposed as a link
    expect(remotePlan.urlNote ?? remotePlan.notes.join("; ")).toContain("non-loopback");

    // --- firstSeenAt is stable across polls ---
    const firstSeen = crit.firstSeenAt;
    await new Promise((r) => setTimeout(r, 20));
    sessions = await hub.poll();
    expect(sessions.find((s) => s.id === "crit:aaaa11112222")!.firstSeenAt).toBe(firstSeen);

    // --- pruning on exit ---
    good.kill();
    await good.exited;
    sessions = await hub.poll();
    expect(sessions.find((s) => s.id === `plannotator:${good.pid}`)).toBeUndefined();
    expect(sessions).toHaveLength(2);

    const snap = hub.snapshot();
    expect(snap.count).toBe(2);
    expect(snap.sessions.every((s) => s.url === null || s.url.includes("localhost"))).toBeTrue();
    expect(snap.lastError).toBeNull();

    remote.kill();
    await remote.exited;
  });

  test("crit registry with non-loopback public host is listed but not linked", async () => {
    const critHome = tmp();
    const planDir = tmp();
    mkdirSync(path.join(critHome, "sessions"), { recursive: true });
    writeFileSync(
      path.join(critHome, "sessions", "bbbb33334444.json"),
      JSON.stringify({
        pid: process.pid,
        port: 8443,
        host: "0.0.0.0",
        cwd: null,
        args: [],
        branch: null,
      }),
    );
    const hub = makeHub(critHome, planDir);
    const sessions = await hub.poll();
    const s = sessions.find((x) => x.id === "crit:bbbb33334444")!;
    expect(s.url).toBeNull();
    expect(s.urlNote).toContain("non-loopback");
    expect(s.health).toBe("unknown"); // never probed without a loopback url
  });

  test("empty registries produce a clean empty snapshot", async () => {
    const hub = makeHub(tmp(), tmp());
    const sessions = await hub.poll();
    expect(sessions).toEqual([]);
    expect(hub.snapshot().count).toBe(0);
  });
});
