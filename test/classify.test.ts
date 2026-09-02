import { describe, expect, test } from "bun:test";
import { classifySession } from "../src/classify";

describe("classifySession", () => {
  test("distinguishes Crit review surfaces from launch args", () => {
    expect(classifySession({ tool: "crit", mode: "review", label: null, args: [] }).kind).toBe("code-review");
    expect(classifySession({ tool: "crit", mode: "live", label: null, args: ["live", "http://localhost:3000"] })).toMatchObject({ category: "live-artifact", kind: "live-web-review" });
    expect(classifySession({ tool: "crit", mode: "preview", label: null, args: ["preview", "/tmp/app.html"] }).kind).toBe("html-preview");
    expect(classifySession({ tool: "crit", mode: "plan", label: null, args: ["plan", "--name", "x", "/tmp/plan.md"] }).kind).toBe("plan-review");
    expect(classifySession({ tool: "crit", mode: "review", label: null, args: ["--range", "main..HEAD"] }).kind).toBe("commit-range-review");
    expect(classifySession({ tool: "crit", mode: "review", label: null, args: ["--mr", "https://gitlab.com/a/b/-/merge_requests/4"] }).kind).toBe("merge-request-review");
    expect(classifySession({ tool: "crit", mode: "file", label: "http://localhost:3000", args: ["http://localhost:3000"] }).kind).toBe("live-web-review");
  });

  test("refines Plannotator semantics from process command", () => {
    expect(classifySession({ tool: "plannotator", mode: "review", label: "review", command: "plannotator review" }).kind).toBe("code-review");
    expect(classifySession({ tool: "plannotator", mode: "annotate", label: "notes.md", command: "plannotator annotate /tmp/notes.md --gate" }).kind).toBe("artifact-annotation");
    expect(classifySession({ tool: "plannotator", mode: "annotate", label: "last", command: "plannotator last --gate" }).kind).toBe("last-message-annotation");
    expect(classifySession({ tool: "plannotator", mode: "annotate", label: "app", command: "plannotator annotate http://localhost:4321/ --app" })).toMatchObject({ category: "live-artifact", kind: "live-web-review" });
    expect(classifySession({ tool: "plannotator", mode: "annotate", label: "page.html", command: "plannotator annotate /tmp/page.html" }).kind).toBe("html-preview");
    expect(classifySession({ tool: "plannotator", mode: "goal-setup", label: "goal-setup-interview-demo", command: "plannotator setup-goal interview bundle.json" }).kind).toBe("goal-setup");
    expect(classifySession({ tool: "plannotator", mode: "review", label: "mr-review-project-4", command: "plannotator review" }).kind).toBe("merge-request-review");
  });
});
