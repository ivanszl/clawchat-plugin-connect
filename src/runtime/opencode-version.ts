export const OPENCODE_SDK_VERSION = "1.18.13" as const;
export const OPENCODE_SEMANTIC_VERSION_PATTERN =
  "(?:0|[1-9]\\d*)\\.(?:0|[1-9]\\d*)\\.(?:0|[1-9]\\d*)(?:-(?:0|[1-9]\\d*|\\d*[A-Za-z-][0-9A-Za-z-]*)(?:\\.(?:0|[1-9]\\d*|\\d*[A-Za-z-][0-9A-Za-z-]*))*)?(?:\\+[0-9A-Za-z-]+(?:\\.[0-9A-Za-z-]+)*)?";

const OPENCODE_VERSION_OUTPUT = new RegExp(`(?:^|\\s)(${OPENCODE_SEMANTIC_VERSION_PATTERN})(?:\\s|$)`, "u");

export function parseOpenCodeVersion(raw: string): string {
  const match = OPENCODE_VERSION_OUTPUT.exec(raw.trim());
  if (!match?.[1]) throw new Error(`Failed to read OpenCode version: ${raw.trim() || "empty output"}`);
  return match[1];
}
