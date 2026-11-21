import { ClawChatApiError, createClawChatApiClient, type FetchLike } from "../clawchat/api-client";
import type { ConnectStateStore } from "../persistence/state";
import type { ActivationCredentials } from "../types";

function claims(token: string): Record<string, unknown> | null {
  try {
    if (token.length > 32768) return null;
    const parts = token.split(".");
    if (parts.length !== 3 || !parts.every((part) => /^[A-Za-z0-9_-]+$/.test(part))) return null;
    const header = JSON.parse(Buffer.from(parts[0], "base64url").toString("utf8"));
    if (!header || typeof header.alg !== "string" || header.alg.toLowerCase() === "none") return null;
    const data = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
    return data && typeof data === "object" && !Array.isArray(data) && Number.isSafeInteger(data.exp) ? data : null;
  } catch {
    return null;
  }
}
function sameIdentity(a: ActivationCredentials, b: ActivationCredentials): boolean {
  return (
    a.localAgentId === b.localAgentId &&
    a.userId === b.userId &&
    a.ownerUserId === b.ownerUserId &&
    a.serverAgentId === b.serverAgentId &&
    a.conversationId === b.conversationId
  );
}
function matches(data: Record<string, unknown>, activation: ActivationCredentials, deviceId: string): boolean {
  return (
    data.sub === activation.userId &&
    data.oid === activation.ownerUserId &&
    data.aid === activation.serverAgentId &&
    data.did === deviceId
  );
}

/** Rotate only a definitively expired startup credential. No reconnect, tool, prompt or refresh retry occurs here. */
export async function startupCredentials(options: {
  activation: ActivationCredentials;
  deviceId: string;
  baseUrl: string;
  store: ConnectStateStore;
  fetchImpl?: FetchLike;
  now?: () => number;
}): Promise<ActivationCredentials> {
  const { activation, deviceId, store } = options;
  const now = options.now ?? Date.now;
  const initial = claims(activation.accessToken);
  // Opaque credentials and live sessions retain their existing authentication behavior.
  if (!initial || Number(initial.exp) * 1000 > now()) return activation;
  if (!activation.refreshToken || !matches(initial, activation, deviceId))
    throw new Error("Expired ClawChat startup credential cannot be refreshed safely; re-pair this Binding");
  const claim = await store.beginActivationRefresh(activation, deviceId);
  if (!claim) {
    const current = await store.getCompletedActivationRefresh(activation, deviceId);
    const currentClaims = current && claims(current.accessToken);
    if (
      current &&
      sameIdentity(current, activation) &&
      current.accessToken !== activation.accessToken &&
      currentClaims &&
      matches(currentClaims, current, deviceId) &&
      Number(currentClaims.exp) * 1000 > now()
    )
      return current;
    throw new Error(
      "ClawChat startup refresh is pending or already attempted; re-pair this Binding without replaying it",
    );
  }
  let tokens: { accessToken: string; refreshToken: string };
  try {
    tokens = await createClawChatApiClient({
      baseUrl: options.baseUrl,
      deviceId,
      fetchImpl: options.fetchImpl,
    }).refreshSession(activation.refreshToken);
  } catch (error) {
    const rejected = error instanceof ClawChatApiError && error.kind === "auth";
    await store.completeActivationRefresh(activation, deviceId, claim, rejected ? "rejected" : "unknown");
    throw new Error(
      rejected
        ? "ClawChat startup refresh was rejected; re-pair this Binding"
        : "ClawChat startup refresh outcome is unknown; automatic replay is blocked",
    );
  }
  const renewed = claims(tokens.accessToken);
  if (!renewed || !matches(renewed, activation, deviceId) || Number(renewed.exp) * 1000 <= now()) {
    await store.completeActivationRefresh(activation, deviceId, claim, "unknown");
    throw new Error("ClawChat startup refresh identity or expiry check failed; credentials were preserved");
  }
  if (!(await store.completeActivationRefresh(activation, deviceId, claim, tokens)))
    throw new Error("ClawChat startup refresh lost its Binding revision; current credentials were preserved");
  return { ...activation, ...tokens };
}
