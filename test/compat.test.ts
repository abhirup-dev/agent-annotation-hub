import { describe, expect, test } from "bun:test";
import { assessCompatibility } from "../src/compat";

describe("tool compatibility reporting", () => {
  test("marks exact source-audited versions verified", () => {
    expect(assessCompatibility({ crit: "crit 0.19.0 (brew)", plannotator: "plannotator 0.27.8" })).toEqual({
      crit: { installed: "0.19.0", verifiedAgainst: "0.19.0", status: "verified" },
      plannotator: { installed: "0.27.8", verifiedAgainst: "0.27.8", status: "verified" },
    });
  });

  test("never silently calls a future or missing version verified", () => {
    const result = assessCompatibility({ crit: "crit 0.20.0", plannotator: null });
    expect(result.crit.status).toBe("unverified");
    expect(result.plannotator.status).toBe("unavailable");
  });
});
