/**
 * Loopback / strict-numeric validation helpers.
 *
 * Everything the hub exposes as a clickable URL must resolve to loopback.
 * Anything else (remote hosts, tunnels, unparsable values) is rejected.
 */

const LOOPBACK_HOSTS = new Set(["localhost", "::1", "[::1]", "0:0:0:0:0:0:0:1"]);

export function isLoopbackHost(host: string): boolean {
  const h = host.trim().toLowerCase().replace(/\.$/, "");
  if (h === "") return false;
  if (LOOPBACK_HOSTS.has(h)) return true;
  // 127.0.0.0/8 — any 127.x.x.x address is loopback.
  if (/^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(h)) {
    const parts = h.split(".").map(Number);
    return parts.every((p) => p >= 0 && p <= 255);
  }
  return false;
}

/** Strict TCP port: positive integer in range. No strings, no floats. */
export function parseStrictPort(v: unknown): number | null {
  if (typeof v !== "number" || !Number.isInteger(v)) return null;
  if (v < 1 || v > 65535) return null;
  return v;
}

/** Strict PID: positive integer, below the macOS PID_MAX. */
export function parseStrictPid(v: unknown): number | null {
  if (typeof v !== "number" || !Number.isInteger(v)) return null;
  if (v < 1 || v > 4194304) return null;
  return v;
}

export interface SanitizedUrl {
  url: string | null;
  note: string | null;
}

/**
 * Accept only http/https URLs whose hostname is loopback.
 * Used for values discovered in registries (never trusted blindly).
 */
export function sanitizeLoopbackUrl(raw: unknown): SanitizedUrl {
  if (typeof raw !== "string" || raw.trim() === "") {
    return { url: null, note: "no url recorded" };
  }
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    return { url: null, note: "unparsable url" };
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") {
    return { url: null, note: `unsupported protocol ${u.protocol}` };
  }
  if (!isLoopbackHost(u.hostname)) {
    return { url: null, note: "non-loopback host ignored" };
  }
  return { url: u.toString(), note: null };
}

/**
 * Crit registry `host` is "127.0.0.1" by default (or empty). Only expose the
 * daemon when it is loopback; anything else (public bind) is not linked.
 */
export function critLoopbackUrl(host: string, port: number): SanitizedUrl {
  if (host !== "" && !isLoopbackHost(host)) {
    return { url: null, note: `non-loopback host "${host}" ignored` };
  }
  // crit's DisplayHost() maps 127.0.0.1 -> localhost for display purposes.
  return { url: `http://localhost:${port}`, note: null };
}
