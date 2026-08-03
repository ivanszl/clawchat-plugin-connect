const CODEBUDDY_SESSION_PREFIX = "codebuddy-session:";

export type WorkBuddyRuntimeTargetKind = "codebuddy-session" | "workbuddy-task";

export function encodeCodeBuddySessionId(sessionId: string): string {
  return `${CODEBUDDY_SESSION_PREFIX}${sessionId}`;
}

export function decodeCodeBuddySessionId(runtimeSessionId: string | null): string | null {
  if (!runtimeSessionId || !isCodeBuddySessionRuntimeTarget(runtimeSessionId)) return null;
  return runtimeSessionId.slice(CODEBUDDY_SESSION_PREFIX.length) || null;
}

export function isCodeBuddySessionRuntimeTarget(runtimeSessionId: string | null): boolean {
  return runtimeSessionId?.startsWith(CODEBUDDY_SESSION_PREFIX) ?? false;
}

export function workBuddyRuntimeTargetKind(runtimeSessionId: string | null): WorkBuddyRuntimeTargetKind | null {
  if (!runtimeSessionId) return null;
  return isCodeBuddySessionRuntimeTarget(runtimeSessionId) ? "codebuddy-session" : "workbuddy-task";
}
