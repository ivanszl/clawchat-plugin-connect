import { createClawChatApiClient, type FetchLike } from "./api-client";
import { getAgent, loadConfig } from "./config";
import { type ConnectStateStore, createStateStore } from "./state";
import type { ConnectConfig } from "./types";

export interface AccountProfilePatch {
  nickname?: string;
  avatar_url?: string;
  bio?: string;
}

export interface UpdateAccountProfileOptions {
  agentId?: string;
  configPath?: string;
  config?: ConnectConfig;
  stateStore?: ConnectStateStore;
  fetchImpl?: FetchLike;
  patch: AccountProfilePatch;
}

export interface UpdateAccountProfileResult {
  agentId: string;
  profile: unknown;
}

export async function updateAccountProfile(options: UpdateAccountProfileOptions): Promise<UpdateAccountProfileResult> {
  const config = options.config ?? (await loadConfig(options.configPath));
  const agentId = options.agentId?.trim() || config.defaultAgent;
  if (!agentId) throw new Error("agent is required; pass --agent or configure defaultAgent");
  getAgent(config, agentId);
  const patch = normalizeAccountProfilePatch(options.patch);
  const stateStore = options.stateStore ?? createStateStore({ dbPath: config.stateDbPath });
  const ownsStateStore = !options.stateStore;
  try {
    const activation = await stateStore.getActivation(agentId);
    if (!activation)
      throw new Error(
        `clawchat-connect agent ${agentId} is not activated; run \`clawchat-connect activate ${agentId} <code>\` first`,
      );
    const profile = await createClawChatApiClient({
      baseUrl: config.baseUrl,
      token: activation.accessToken,
      fetchImpl: options.fetchImpl,
    }).updateMyProfile(patch);
    return { agentId, profile };
  } finally {
    if (ownsStateStore) await stateStore.close();
  }
}

export function normalizeAccountProfilePatch(patch: AccountProfilePatch): AccountProfilePatch {
  const normalized: AccountProfilePatch = {};
  if (patch.nickname !== undefined) normalized.nickname = patch.nickname.trim();
  if (patch.avatar_url !== undefined) normalized.avatar_url = patch.avatar_url.trim();
  if (patch.bio !== undefined) normalized.bio = patch.bio.trim();
  if (Object.keys(normalized).length === 0)
    throw new Error("profile update requires at least one Profile field: nickname, avatar URL, or bio");
  return normalized;
}
