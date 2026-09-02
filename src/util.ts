/** Small shared utilities. */

/** Trim sub-millisecond digits (crit emits RFC3339 with nanoseconds). */
export function normalizeTimestamp(v: unknown): string | null {
  if (typeof v !== "string" || v.trim() === "") return null;
  const s = v.trim().replace(/(\.\d{3})\d+/, "$1");
  if (!Number.isFinite(Date.parse(s))) return null;
  return s;
}

export function errMessage(e: unknown): string {
  if (e instanceof Error) return e.message;
  return String(e);
}

export function basename(p: string | null): string | null {
  if (!p) return null;
  const parts = p.replace(/\/+$/, "").split("/");
  return parts[parts.length - 1] !== "" ? parts[parts.length - 1]! : p;
}
