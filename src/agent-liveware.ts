import {
  createLivewareExposureDependencies,
  isConnectManagedLivewareAppName,
  LIVEWARE_APP_NAME,
  type LivewareControlSession,
  resolveLivewareExecutablePath,
} from "./liveware-exposure";
import { ClawChatToolApiError } from "./tool-executor";
import type { ActivationCredentials } from "./types";

export const AGENT_LIVEWARE_OPERATIONS = [
  "liveware_app_list",
  "liveware_app_inspect",
  "liveware_app_create",
  "liveware_app_access",
  "liveware_app_delete",
  "liveware_tunnel_bind",
  "liveware_tunnel_unbind",
] as const;

export type AgentLivewareOperation = (typeof AGENT_LIVEWARE_OPERATIONS)[number];

export function isAgentLivewareOperation(value: string): value is AgentLivewareOperation {
  return (AGENT_LIVEWARE_OPERATIONS as readonly string[]).includes(value);
}

export function validateAgentLivewareInput(operation: AgentLivewareOperation, input: unknown): Record<string, unknown> {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("input must be a JSON object");
  const value = input as Record<string, unknown>;
  const text = (key: string) => {
    if (typeof value[key] !== "string" || !String(value[key]).trim()) throw new Error(`${key} is required`);
    return String(value[key]).trim();
  };
  if (operation !== "liveware_app_list") text(operation === "liveware_app_create" ? "name" : "appId");
  if (operation === "liveware_app_create" || operation === "liveware_app_access") {
    const policy = String(value.policy ?? "private");
    if (policy !== "private" && policy !== "public") throw new Error("policy must be private or public");
    value.policy = policy;
  }
  if (operation === "liveware_app_create" && isConnectManagedLivewareAppName(text("name")))
    throw new Error(`the app name ${LIVEWARE_APP_NAME} is reserved`);
  if (operation === "liveware_tunnel_bind") validateLoopbackUpstream(text("upstream"));
  return value;
}

export async function executeAgentLiveware(
  operation: AgentLivewareOperation,
  rawInput: Record<string, unknown>,
  options: {
    activation: ActivationCredentials;
    clawChatBaseUrl: string;
    deviceId: string;
    registerApp(name: string, appId: string, url: string): Promise<unknown>;
    unregisterApp(appId: string): Promise<unknown>;
    managedAppId?: string | null;
    connectControl?: (accessToken: string) => Promise<LivewareControlSession>;
  },
): Promise<unknown> {
  const input = validateAgentLivewareInput(operation, rawInput);
  const control = options.connectControl
    ? await options.connectControl(options.activation.accessToken)
    : await createLivewareExposureDependencies({
        livewarePath: await resolveLivewareExecutablePath(),
        clawChatBaseUrl: options.clawChatBaseUrl,
      }).controlPlane.connect(options.activation.accessToken);
  const appId = typeof input.appId === "string" ? input.appId : "";
  switch (operation) {
    case "liveware_app_list":
      return await control.listApps();
    case "liveware_app_inspect":
      return await inspect(control, appId);
    case "liveware_app_create":
      return await control.createApp(String(input.name), input.policy as "private" | "public");
    case "liveware_app_access":
      await assertMutable(control, appId, options.managedAppId);
      await control.setAccessPolicy(appId, input.policy as "private" | "public");
      return await inspect(control, appId);
    case "liveware_app_delete":
      await assertMutable(control, appId, options.managedAppId);
      await unregisterAppIfPresent(options.unregisterApp, appId);
      await control.deleteApp(appId);
      return { deleted: true, appId };
    case "liveware_tunnel_bind": {
      const app = await assertMutable(control, appId, options.managedAppId);
      const publicUrl = await control.bindTunnel(appId, String(input.upstream));
      await options.registerApp(app.name, appId, publicUrl);
      return { appId, name: app.name, publicUrl, registeredInClawChat: true };
    }
    case "liveware_tunnel_unbind":
      await assertMutable(control, appId, options.managedAppId);
      await unregisterAppIfPresent(options.unregisterApp, appId);
      if (!control.unbindTunnel) throw new Error("bundled Liveware does not support tunnel unbind");
      await control.unbindTunnel(appId);
      return { appId, unbound: true, unregisteredFromClawChat: true };
  }
}

async function unregisterAppIfPresent(
  unregisterApp: (appId: string) => Promise<unknown>,
  appId: string,
): Promise<void> {
  try {
    await unregisterApp(appId);
  } catch (error) {
    if (error instanceof ClawChatToolApiError && error.code === 16016) return;
    throw error;
  }
}

async function assertMutable(control: LivewareControlSession, appId: string, managedAppId?: string | null) {
  const app = await inspect(control, appId);
  if (app.appId === managedAppId || isConnectManagedLivewareAppName(app.name))
    throw new Error(`the managed ${LIVEWARE_APP_NAME} app cannot be changed`);
  return app;
}

async function inspect(control: LivewareControlSession, appId: string) {
  if (control.inspectApp) return await control.inspectApp(appId);
  const app = (await control.listApps()).find((candidate) => candidate.appId === appId);
  if (!app) throw new Error(`Liveware app ${appId} was not found`);
  return app;
}

function validateLoopbackUpstream(value: string): void {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("upstream must be http://127.0.0.1:<port>");
  }
  const port = Number(url.port);
  if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" || !Number.isInteger(port) || port < 1 || port > 65_535)
    throw new Error("upstream must be http://127.0.0.1:<1-65535>");
  if (url.pathname !== "/" || url.search || url.hash)
    throw new Error("upstream must not include a path, query, or fragment");
}
