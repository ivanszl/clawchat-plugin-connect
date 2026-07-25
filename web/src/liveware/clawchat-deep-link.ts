const LIVEWARE_HOST_SUFFIX = ".apps.clawling.io";
const CLAWCHAT_USER_AGENT = /(?:^|\s)clawchat(?:\/[\w.-]+)?(?:\s|$)/iu;

export function isClawChatLivewareContext(hostname: string, userAgent: string): boolean {
  const normalizedHost = hostname.trim().toLowerCase();
  return (
    (normalizedHost.length > LIVEWARE_HOST_SUFFIX.length && normalizedHost.endsWith(LIVEWARE_HOST_SUFFIX)) ||
    CLAWCHAT_USER_AGENT.test(userAgent)
  );
}

export function continueInClawChatHref(clawChatUserId: string | null, sessionRef: string): string | null {
  const userId = clawChatUserId?.trim() ?? "";
  const ref = sessionRef.trim().toUpperCase();
  if (!userId || !ref) return null;
  return `clawchat://u/${encodeURIComponent(userId)}?chat=1&draft=${encodeURIComponent(`/switch ${ref}`)}`;
}
