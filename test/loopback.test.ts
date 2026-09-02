import { describe, expect, test } from "bun:test";
import {
  critLoopbackUrl,
  isLoopbackHost,
  parseStrictPid,
  parseStrictPort,
  sanitizeLoopbackUrl,
} from "../src/loopback";
import { normalizeTimestamp } from "../src/util";

describe("isLoopbackHost", () => {
  test("accepts loopback forms", () => {
    expect(isLoopbackHost("localhost")).toBeTrue();
    expect(isLoopbackHost("LOCALHOST.")).toBeTrue();
    expect(isLoopbackHost("127.0.0.1")).toBeTrue();
    expect(isLoopbackHost("127.0.1.5")).toBeTrue();
    expect(isLoopbackHost("::1")).toBeTrue();
    expect(isLoopbackHost("[::1]")).toBeTrue();
  });
  test("rejects non-loopback", () => {
    expect(isLoopbackHost("example.com")).toBeFalse();
    expect(isLoopbackHost("192.168.1.4")).toBeFalse();
    expect(isLoopbackHost("0.0.0.0")).toBeFalse();
    expect(isLoopbackHost("localhost.evil.com")).toBeFalse();
    expect(isLoopbackHost("")).toBeFalse();
    expect(isLoopbackHost("127.999.0.1")).toBeFalse();
  });
});

describe("parseStrictPort / parseStrictPid", () => {
  test("port strictness", () => {
    expect(parseStrictPort(8080)).toBe(8080);
    expect(parseStrictPort(0)).toBeNull();
    expect(parseStrictPort(65536)).toBeNull();
    expect(parseStrictPort(8080.5)).toBeNull();
    expect(parseStrictPort("8080")).toBeNull();
    expect(parseStrictPort(null)).toBeNull();
  });
  test("pid strictness", () => {
    expect(parseStrictPid(12345)).toBe(12345);
    expect(parseStrictPid(0)).toBeNull();
    expect(parseStrictPid(-1)).toBeNull();
    expect(parseStrictPid("12345")).toBeNull();
    expect(parseStrictPid(1e12)).toBeNull();
  });
});

describe("sanitizeLoopbackUrl", () => {
  test("accepts loopback http/https", () => {
    expect(sanitizeLoopbackUrl("http://localhost:51723/").url).toBe("http://localhost:51723/");
    // URL normalization drops the default port — acceptable.
    expect(sanitizeLoopbackUrl("https://127.0.0.1:443/x").url).toBe("https://127.0.0.1/x");
  });
  test("rejects remote hosts", () => {
    const r = sanitizeLoopbackUrl("https://my-app.loca.lt/session");
    expect(r.url).toBeNull();
    expect(r.note).toContain("non-loopback");
  });
  test("rejects junk", () => {
    expect(sanitizeLoopbackUrl("").url).toBeNull();
    expect(sanitizeLoopbackUrl(undefined).url).toBeNull();
    expect(sanitizeLoopbackUrl("not a url").url).toBeNull();
    expect(sanitizeLoopbackUrl("ftp://localhost:21").url).toBeNull();
    expect(sanitizeLoopbackUrl(42).url).toBeNull();
  });
});

describe("critLoopbackUrl", () => {
  test("default host maps to localhost display form", () => {
    expect(critLoopbackUrl("", 49171)).toEqual({ url: "http://localhost:49171", note: null });
    expect(critLoopbackUrl("127.0.0.1", 49171).url).toBe("http://localhost:49171");
  });
  test("non-loopback crit host is not linked", () => {
    const r = critLoopbackUrl("0.0.0.0", 49171);
    expect(r.url).toBeNull();
    expect(r.note).toContain("non-loopback");
  });
});

describe("normalizeTimestamp", () => {
  test("trims sub-ms precision from crit RFC3339 nanoseconds", () => {
    expect(normalizeTimestamp("2026-08-19T06:59:38.771342Z")).toBe("2026-08-19T06:59:38.771Z");
  });
  test("keeps valid, rejects junk", () => {
    expect(normalizeTimestamp("2026-08-24T16:26:00.210Z")).toBe("2026-08-24T16:26:00.210Z");
    expect(normalizeTimestamp("")).toBeNull();
    expect(normalizeTimestamp("yesterday")).toBeNull();
    expect(normalizeTimestamp(123)).toBeNull();
  });
});
