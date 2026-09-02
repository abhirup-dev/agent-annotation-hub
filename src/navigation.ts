import type { SessionKind, ToolName } from "./types";

/**
 * Return the browser route selected by the tool for a review surface.
 *
 * Crit's daemon root is the source/diff reviewer. Its own v0.19.0 launcher
 * opens `/preview` and `/live` for rendered HTML and proxied apps
 * (`cmd/crit/cli_serve.go`). Plannotator records the complete reopen URL in
 * its registry and `plannotator sessions --open` uses that URL unchanged.
 */
export function surfacePath(tool: ToolName, kind: SessionKind): string {
  if (tool !== "crit") return "";
  if (kind === "html-preview") return "/preview";
  if (kind === "live-web-review") return "/live";
  return "";
}

export function sessionOpenUrl(tool: ToolName, baseUrl: string | null, kind: SessionKind): string | null {
  if (!baseUrl) return null;
  const suffix = surfacePath(tool, kind);
  if (!suffix) return baseUrl;
  return `${baseUrl.replace(/\/$/, "")}${suffix}`;
}
