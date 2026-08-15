export const OPENCODE_SDK_VERSION = "1.18.13" as const;
export const SUPPORTED_OPENCODE_VERSIONS = ["1.18.10", OPENCODE_SDK_VERSION] as const;

export type SupportedOpenCodeVersion = (typeof SUPPORTED_OPENCODE_VERSIONS)[number];

export function parseOpenCodeVersion(raw: string): string {
  const match = /(?:^|\s)(\d+\.\d+\.\d+)(?:\s|$)/u.exec(raw.trim());
  if (!match?.[1]) throw new Error(`Failed to read OpenCode version: ${raw.trim() || "empty output"}`);
  return match[1];
}

export function isSupportedOpenCodeVersion(version: string): version is SupportedOpenCodeVersion {
  return SUPPORTED_OPENCODE_VERSIONS.includes(version as SupportedOpenCodeVersion);
}
