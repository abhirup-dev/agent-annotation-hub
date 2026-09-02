import path from "node:path";
import type { SessionCategory, SessionKind, ToolName } from "./types";

export interface ClassificationInput {
  tool: ToolName;
  mode: string | null;
  label: string | null;
  args?: string[];
  command?: string | null;
}

export interface SessionClassification {
  category: SessionCategory;
  kind: SessionKind;
  target: string | null;
  source: string;
}

const URL_RE = /^https?:\/\//i;
const HTML_RE = /\.html?$/i;

function cleanTarget(value: string | null | undefined): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  return trimmed || null;
}

function targetFromCommand(command: string | null | undefined, verb: string): string | null {
  if (!command) return null;
  const escaped = verb.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = command.match(new RegExp(`(?:^|\\s)${escaped}\\s+(?:--[^\\s]+\\s+)*([^\\s]+)`, "i"));
  return cleanTarget(match?.[1]);
}

export function classifySession(input: ClassificationInput): SessionClassification {
  const mode = (input.mode ?? "").toLowerCase();
  const label = cleanTarget(input.label);
  const args = input.args ?? [];
  const command = input.command ?? null;

  if (input.tool === "crit") {
    const verb = (args[0] ?? mode).toLowerCase();
    if (verb === "live") return { category: "live-artifact", kind: "live-web-review", target: cleanTarget(args[1]), source: "crit registry args" };
    if (verb === "preview") return { category: "live-artifact", kind: "html-preview", target: cleanTarget(args[1]), source: "crit registry args" };
    if (verb === "plan") return { category: "review", kind: "plan-review", target: cleanTarget(args.at(-1)), source: "crit registry args" };
    if (verb === "story") return { category: "review", kind: "story-review", target: null, source: "crit registry args" };
    if (args.includes("--pr")) return { category: "review", kind: "pull-request-review", target: cleanTarget(args[args.indexOf("--pr") + 1]), source: "crit registry args" };
    if (args.includes("--mr")) return { category: "review", kind: "merge-request-review", target: cleanTarget(args[args.indexOf("--mr") + 1]), source: "crit registry args" };
    if (args.includes("--range")) return { category: "review", kind: "commit-range-review", target: cleanTarget(args[args.indexOf("--range") + 1]), source: "crit registry args" };
    if (args.length === 0 || verb === "review") return { category: "review", kind: "code-review", target: null, source: "crit registry args" };
    const target = cleanTarget(args.find((arg) => !arg.startsWith("-")) ?? label);
    if (target && HTML_RE.test(target)) return { category: "live-artifact", kind: "html-preview", target, source: "crit registry args" };
    if (target && URL_RE.test(target)) return { category: "live-artifact", kind: "live-web-review", target, source: "crit registry args" };
    return { category: "annotate", kind: "artifact-annotation", target, source: "crit registry args" };
  }

  if (/\bsetup-goal\b/i.test(command ?? "") || mode === "goal-setup") return { category: "review", kind: "goal-setup", target: label, source: command ? "process command" : "plannotator registry" };
  if (/\b(?:annotate-last|last|copilot-last)\b/i.test(command ?? "") || mode.includes("last") || /(?:^|-)last(?:-|$)/i.test(label ?? "")) {
    return { category: "annotate", kind: "last-message-annotation", target: null, source: command ? "process command" : "plannotator registry" };
  }
  if (/\barchive\b/i.test(command ?? "") || mode === "archive") return { category: "browse", kind: "archive-browser", target: null, source: command ? "process command" : "plannotator registry" };
  if (/\bguide\b/i.test(command ?? "") || mode.includes("guide")) return { category: "review", kind: "guided-review", target: label, source: command ? "process command" : "plannotator registry" };
  if (mode === "plan" || mode.includes("plan")) return { category: "review", kind: "plan-review", target: label, source: "plannotator registry" };
  if (/\breview\b/i.test(command ?? "") || mode === "review") {
    const change = command?.match(/https?:\/\/[^\s]+\/(?:pull|merge_requests)\/\d+/i)?.[0] ?? null;
    const isMr = !!change?.includes("/merge_requests/") || /^mr-review-/i.test(label ?? "");
    const isPr = !!change?.includes("/pull/") || /^pr-review-/i.test(label ?? "");
    return { category: "review", kind: isMr ? "merge-request-review" : isPr ? "pull-request-review" : "code-review", target: change, source: command ? "process command" : "plannotator registry" };
  }

  const target = targetFromCommand(command, "annotate") ?? label;
  const appForced = /\s--app(?:\s|$)/.test(command ?? "");
  const localUrl = !!target && /^http:\/\/(?:localhost|127\.0\.0\.1|\[::1\])(?::\d+)?(?:\/|$)/i.test(target);
  if (appForced || localUrl || mode.includes("app") || mode.includes("live")) {
    return { category: "live-artifact", kind: "live-web-review", target, source: command ? "process command" : "plannotator registry" };
  }
  if (target && HTML_RE.test(target)) return { category: "live-artifact", kind: "html-preview", target, source: command ? "process command" : "plannotator registry" };
  if (target && URL_RE.test(target)) return { category: "annotate", kind: "web-page-annotation", target, source: command ? "process command" : "plannotator registry" };
  if (target && /[\\/]$/.test(target)) return { category: "annotate", kind: "folder-annotation", target, source: command ? "process command" : "plannotator registry" };
  if (mode === "annotate" || /\bannotate\b/i.test(command ?? "")) return { category: "annotate", kind: "artifact-annotation", target, source: command ? "process command" : "plannotator registry" };
  return { category: "other", kind: "unknown", target, source: "insufficient metadata" };
}

export function displayTarget(target: string | null): string | null {
  if (!target) return null;
  if (URL_RE.test(target)) return target;
  return path.basename(target) || target;
}
