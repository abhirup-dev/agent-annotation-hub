import { describe, expect, test } from "bun:test";
import { sessionOpenUrl, surfacePath } from "../src/navigation";

describe("tool navigation parity", () => {
  test("Crit rendered surfaces use the same paths as the v0.19 launcher", () => {
    expect(surfacePath("crit", "html-preview")).toBe("/preview");
    expect(surfacePath("crit", "live-web-review")).toBe("/live");
    expect(surfacePath("crit", "code-review")).toBe("");
    expect(surfacePath("crit", "plan-review")).toBe("");
    expect(surfacePath("crit", "story-review")).toBe("");
    expect(sessionOpenUrl("crit", "http://localhost:6000", "html-preview")).toBe("http://localhost:6000/preview");
    expect(sessionOpenUrl("crit", "http://localhost:6000/prefix", "live-web-review")).toBe("http://localhost:6000/prefix/live");
  });

  test("Plannotator registry URLs are authoritative for every mode", () => {
    for (const kind of ["code-review", "artifact-annotation", "html-preview", "live-web-review", "last-message-annotation", "plan-review", "archive-browser", "goal-setup"] as const) {
      expect(sessionOpenUrl("plannotator", "http://localhost:7000/custom", kind)).toBe("http://localhost:7000/custom");
    }
  });
});
