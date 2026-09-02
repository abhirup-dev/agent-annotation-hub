export const VERIFIED_TOOL_VERSIONS = {
  crit: "0.19.0",
  plannotator: "0.27.8",
} as const;

export type CompatibilityStatus = "verified" | "unverified" | "unavailable";

export interface ToolCompatibility {
  installed: string | null;
  verifiedAgainst: string;
  status: CompatibilityStatus;
}

function extractVersion(text: string | null): string | null {
  return text?.match(/\b(\d+\.\d+\.\d+)\b/)?.[1] ?? null;
}

export function assessCompatibility(versions: Record<string, string | null>): Record<keyof typeof VERIFIED_TOOL_VERSIONS, ToolCompatibility> {
  return Object.fromEntries(Object.entries(VERIFIED_TOOL_VERSIONS).map(([tool, verifiedAgainst]) => {
    const installed = extractVersion(versions[tool] ?? null);
    return [tool, {
      installed,
      verifiedAgainst,
      status: installed === null ? "unavailable" : installed === verifiedAgainst ? "verified" : "unverified",
    }];
  })) as Record<keyof typeof VERIFIED_TOOL_VERSIONS, ToolCompatibility>;
}
