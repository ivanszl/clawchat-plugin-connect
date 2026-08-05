import { constants } from "node:fs";
import { access } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { ConnectStateStore } from "../persistence/state";
import type { ActivationCredentials, LivewareAccessPolicy, LivewareExposureRecord } from "../types";

export const LIVEWARE_APP_NAME = "ClawChat Connect";
const LIVEWARE_APP_BINDING_SEPARATOR = " · ";
export const LIVEWARE_APP_SUBTITLE = "Connect Web";
export const DEFAULT_LIVEWARE_API_URL = "https://api-liveware.clawling.io";
export const DEFAULT_LIVEWARE_RELAY_URL = "https://tunnel-liveware.clawling.io";
const LIVEWARE_APP_CONVERGENCE_RETRY_DELAY_MS = 500;
const LIVEWARE_APP_CONVERGENCE_ATTEMPTS = 5;

type EnabledLivewareAccessPolicy = Exclude<LivewareAccessPolicy, "off">;

export interface LivewareApp {
  appId: string;
  name: string;
  publicUrl: string;
}

export interface LivewareControlSession {
  listApps(): Promise<LivewareApp[]>;
  inspectApp?(appId: string): Promise<LivewareApp>;
  createApp(name: string, accessPolicy: EnabledLivewareAccessPolicy): Promise<LivewareApp>;
  setAccessPolicy(appId: string, accessPolicy: EnabledLivewareAccessPolicy): Promise<void>;
  bindTunnel(appId: string, upstream: string): Promise<string>;
  unbindTunnel?(appId: string): Promise<void>;
  deleteApp(appId: string): Promise<void>;
  startAgent(): Promise<LivewareAgentProcess>;
}

export interface LivewareControlPlanePort {
  connect(clawChatAccessToken: string): Promise<LivewareControlSession>;
}

export interface ClawChatLivewareRegistration {
  livewareId: string;
  name: string;
  subtitle: string;
  url: string;
}

export interface ClawChatLivewarePort {
  list(activation: ActivationCredentials, deviceId: string): Promise<ClawChatLivewareRegistration[]>;
  register(
    activation: ActivationCredentials,
    deviceId: string,
    registration: ClawChatLivewareRegistration,
  ): Promise<void>;
  unregister(activation: ActivationCredentials, deviceId: string, livewareId: string): Promise<void>;
}

export interface PrepareLivewareExposureOptions {
  activation: ActivationCredentials;
  deviceId: string;
  upstream: string;
  accessPolicy: EnabledLivewareAccessPolicy;
  stateStore: ConnectStateStore;
}

export interface RetireLivewareExposureOptions {
  activation: ActivationCredentials;
  deviceId: string;
  stateStore: ConnectStateStore;
}

export interface LivewareExposureDependencies {
  controlPlane: LivewareControlPlanePort;
  clawChat: ClawChatLivewarePort;
  delay?: (milliseconds: number) => Promise<void>;
}

export interface LivewareAgentProcess {
  exited: Promise<number>;
  stop(): Promise<void>;
}

export interface LivewareExposureHandle {
  record: LivewareExposureRecord;
  close(): Promise<void>;
}

export interface StartLivewareExposureOptions extends PrepareLivewareExposureOptions {
  writeError?: (message: string) => void;
}

export interface LivewareProcessResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export type RunLivewareProcess = (command: string[], env: Record<string, string>) => Promise<LivewareProcessResult>;

export type SpawnLivewareAgent = (command: string[], env: Record<string, string>) => Promise<LivewareAgentProcess>;

export interface ProductionLivewareExposureOptions {
  livewarePath: string;
  clawChatBaseUrl: string;
  livewareApiUrl?: string;
  livewareRelayUrl?: string;
  fetchImpl?: typeof fetch;
  runProcess?: RunLivewareProcess;
  spawnAgent?: SpawnLivewareAgent;
}

export function createLivewareExposureDependencies(
  options: ProductionLivewareExposureOptions,
): LivewareExposureDependencies {
  const livewarePath = requireText(options.livewarePath, "livewarePath");
  const clawChatBaseUrl = normalizeBaseUrl(options.clawChatBaseUrl, "clawChatBaseUrl");
  const livewareApiUrl = normalizeBaseUrl(options.livewareApiUrl ?? DEFAULT_LIVEWARE_API_URL, "livewareApiUrl");
  const livewareRelayUrl = normalizeBaseUrl(options.livewareRelayUrl ?? DEFAULT_LIVEWARE_RELAY_URL, "livewareRelayUrl");
  const fetchImpl = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
  const runProcess = options.runProcess ?? runLivewareProcess;
  const spawnAgent = options.spawnAgent ?? spawnLivewareAgent;
  return {
    controlPlane: new CliLivewareControlPlane({
      livewarePath,
      livewareApiUrl,
      livewareRelayUrl,
      fetchImpl,
      runProcess,
      spawnAgent,
    }),
    clawChat: new HttpClawChatLiveware({ baseUrl: clawChatBaseUrl, fetchImpl }),
  };
}

export async function resolveLivewareExecutablePath(): Promise<string> {
  const moduleDirectory = dirname(fileURLToPath(import.meta.url));
  const assetName = livewareAssetName(process.platform, process.arch);
  const candidates = [
    process.env.CLAWCHAT_CONNECT_LIVEWARE_PATH,
    join(dirname(resolve(process.execPath)), process.platform === "win32" ? "liveware.exe" : "liveware"),
    join(moduleDirectory, "..", "vendor", "liveware", assetName),
    join(moduleDirectory, "..", "..", "vendor", "liveware", assetName),
  ].filter((candidate): candidate is string => Boolean(candidate));
  for (const candidate of candidates) {
    try {
      await access(candidate, constants.X_OK);
      return resolve(candidate);
    } catch {
      // Try the next bundled development or release location.
    }
  }
  throw new Error(
    `bundled Liveware executable is missing for ${process.platform}/${process.arch}; reinstall ClawChat Connect`,
  );
}

export function livewareAssetName(platform: NodeJS.Platform, architecture: string): string {
  const operatingSystem =
    platform === "darwin" ? "darwin" : platform === "linux" ? "linux" : platform === "win32" ? "windows" : null;
  const cpu = architecture === "arm64" ? "arm64" : architecture === "x64" ? "amd64" : null;
  if (!operatingSystem || !cpu) {
    throw new Error(`Liveware is not bundled for ${platform}/${architecture}`);
  }
  return `liveware-${operatingSystem}-${cpu}${platform === "win32" ? ".exe" : ""}`;
}

export async function prepareLivewareExposure(
  options: PrepareLivewareExposureOptions,
  dependencies: LivewareExposureDependencies,
): Promise<LivewareExposureRecord> {
  const control = await dependencies.controlPlane.connect(options.activation.accessToken);
  return await prepareWithControl(options, dependencies.clawChat, control, dependencies.delay ?? defaultDelay);
}

async function prepareWithControl(
  options: PrepareLivewareExposureOptions,
  clawChat: ClawChatLivewarePort,
  control: LivewareControlSession,
  delay: (milliseconds: number) => Promise<void>,
): Promise<LivewareExposureRecord> {
  const existing = await options.stateStore.getLivewareExposure(options.activation.localAgentId);
  if (existing && existing.ownerUserId !== options.activation.ownerUserId) {
    throw new Error(
      `Liveware Exposure for Agent Binding ${options.activation.localAgentId} belongs to Binding Owner ${existing.ownerUserId}; retire it before preparing owner ${options.activation.ownerUserId}`,
    );
  }

  const apps = await control.listApps();
  const appName = livewareExposureAppName(options.activation.localAgentId);
  const app =
    (existing ? apps.find((candidate) => candidate.appId === existing.appId) : undefined) ??
    apps.find((candidate) => candidate.name === appName) ??
    (await control.createApp(appName, options.accessPolicy));

  await control.setAccessPolicy(app.appId, options.accessPolicy);
  const publicUrl = normalizeHttpUrl(
    await bindTunnelAfterAppConverges(control, app.appId, options.upstream, delay),
    "Liveware public URL",
  );
  const registration: ClawChatLivewareRegistration = {
    livewareId: app.appId,
    name: app.name,
    subtitle: LIVEWARE_APP_SUBTITLE,
    url: publicUrl,
  };
  const registrations = await clawChat.list(options.activation, options.deviceId);
  const currentRegistration = registrations.find((candidate) => candidate.livewareId === app.appId);
  if (!currentRegistration || !sameRegistration(currentRegistration, registration)) {
    await clawChat.register(options.activation, options.deviceId, registration);
  }

  const record: LivewareExposureRecord = {
    ownerUserId: options.activation.ownerUserId,
    localAgentId: options.activation.localAgentId,
    appId: app.appId,
    publicUrl,
    accessPolicy: options.accessPolicy,
  };
  await options.stateStore.setLivewareExposure(record);
  return record;
}

export function livewareExposureAppName(localAgentId: string): string {
  return `${LIVEWARE_APP_NAME}${LIVEWARE_APP_BINDING_SEPARATOR}${localAgentId}`;
}

export function isConnectManagedLivewareAppName(name: string): boolean {
  return name === LIVEWARE_APP_NAME || name.startsWith(`${LIVEWARE_APP_NAME}${LIVEWARE_APP_BINDING_SEPARATOR}`);
}

export async function startLivewareExposure(
  options: StartLivewareExposureOptions,
  dependencies: LivewareExposureDependencies,
): Promise<LivewareExposureHandle> {
  const control = await dependencies.controlPlane.connect(options.activation.accessToken);
  const delay = dependencies.delay ?? defaultDelay;
  const record = await prepareWithControl(options, dependencies.clawChat, control, delay);
  let current = await control.startAgent();
  let closed = false;
  const writeError = options.writeError ?? ((message: string) => process.stderr.write(message));
  const supervise = (async () => {
    while (!closed) {
      const exitCode = await current.exited;
      if (closed) break;
      writeError(`Liveware agent exited with code ${exitCode}; restarting.\n`);
      await delay(2_000);
      if (closed) break;
      while (!closed) {
        try {
          current = await control.startAgent();
          break;
        } catch (error) {
          writeError(
            `Liveware agent restart failed: ${error instanceof Error ? error.message : String(error)}; retrying.\n`,
          );
          await delay(2_000);
        }
      }
    }
  })();
  return {
    record,
    close: async () => {
      if (closed) return;
      closed = true;
      await current.stop();
      await supervise;
    },
  };
}

async function bindTunnelAfterAppConverges(
  control: LivewareControlSession,
  appId: string,
  upstream: string,
  delay: (milliseconds: number) => Promise<void>,
): Promise<string> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await control.bindTunnel(appId, upstream);
    } catch (error) {
      if (attempt >= LIVEWARE_APP_CONVERGENCE_ATTEMPTS || !isAppNotFoundError(error)) throw error;
      await delay(LIVEWARE_APP_CONVERGENCE_RETRY_DELAY_MS);
    }
  }
}

function isAppNotFoundError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /\bapp not found\b/iu.test(message);
}

async function defaultDelay(milliseconds: number): Promise<void> {
  await Bun.sleep(milliseconds);
}

export async function retireLivewareExposure(
  options: RetireLivewareExposureOptions,
  dependencies: LivewareExposureDependencies,
): Promise<void> {
  const existing = await options.stateStore.getLivewareExposure(options.activation.localAgentId);
  if (!existing) return;
  if (existing.ownerUserId !== options.activation.ownerUserId) {
    throw new Error(
      `Cannot retire Liveware Exposure for Binding Owner ${existing.ownerUserId} with credentials for ${options.activation.ownerUserId}`,
    );
  }
  await dependencies.clawChat.unregister(options.activation, options.deviceId, existing.appId);
  const control = await dependencies.controlPlane.connect(options.activation.accessToken);
  await control.deleteApp(existing.appId);
  await options.stateStore.clearLivewareExposure(options.activation.localAgentId);
}

function sameRegistration(left: ClawChatLivewareRegistration, right: ClawChatLivewareRegistration): boolean {
  return (
    left.livewareId === right.livewareId &&
    left.name === right.name &&
    left.subtitle === right.subtitle &&
    left.url === right.url
  );
}

function normalizeHttpUrl(value: string, label: string): string {
  const text = value.trim();
  if (!/^https?:\/\//iu.test(text)) throw new Error(`${label} must start with http:// or https://`);
  return new URL(text).toString().replace(/\/$/u, "");
}

interface CliLivewareControlPlaneOptions {
  livewarePath: string;
  livewareApiUrl: string;
  livewareRelayUrl: string;
  fetchImpl: typeof fetch;
  runProcess: RunLivewareProcess;
  spawnAgent: SpawnLivewareAgent;
}

class CliLivewareControlPlane implements LivewareControlPlanePort {
  constructor(private readonly options: CliLivewareControlPlaneOptions) {}

  async connect(accessToken: string): Promise<LivewareControlSession> {
    const response = await this.options.fetchImpl(`${this.options.livewareApiUrl}/v1/login`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${requireText(accessToken, "ClawChat access token")}`,
        "Content-Type": "application/json",
      },
      body: "{}",
    });
    const data = await readEnvelope(response, "Liveware login");
    const livewareToken = requireText(data.secret ?? data.token, "Liveware control token");
    return new CliLivewareControlSession(this.options, livewareToken);
  }
}

class CliLivewareControlSession implements LivewareControlSession {
  constructor(
    private readonly options: CliLivewareControlPlaneOptions,
    private readonly token: string,
  ) {}

  async listApps(): Promise<LivewareApp[]> {
    const value = await this.command(["app", "list"]);
    const rows = Array.isArray(value) ? value : isRecord(value) && Array.isArray(value.apps) ? value.apps : [];
    return rows.filter(isRecord).map(readLivewareApp);
  }

  async createApp(name: string, accessPolicy: EnabledLivewareAccessPolicy): Promise<LivewareApp> {
    return readLivewareApp(await this.command(["app", "create", name, "--policy", accessPolicy]));
  }

  async setAccessPolicy(appId: string, accessPolicy: EnabledLivewareAccessPolicy): Promise<void> {
    await this.command(["app", "access", appId, "--policy", accessPolicy]);
  }

  async bindTunnel(appId: string, upstream: string): Promise<string> {
    await this.command(["tunnel", "bind", appId, upstream, "--relay-url", this.options.livewareRelayUrl]);
    return (await this.inspectApp(appId)).publicUrl;
  }

  async deleteApp(appId: string): Promise<void> {
    await this.command(["app", "delete", appId]);
  }

  async startAgent(): Promise<LivewareAgentProcess> {
    return await this.options.spawnAgent(
      [
        this.options.livewarePath,
        "agent",
        "--relay-url",
        this.options.livewareRelayUrl,
        "--control-url",
        this.options.livewareApiUrl,
        "--retry-delay",
        "2s",
      ],
      processEnvironment({ LIVEWARE_TOKEN: this.token }),
    );
  }

  async inspectApp(appId: string): Promise<LivewareApp> {
    return readLivewareApp(await this.command(["app", "inspect", appId]));
  }

  async unbindTunnel(appId: string): Promise<void> {
    await this.command(["tunnel", "unbind", appId]);
  }

  private async command(args: string[]): Promise<unknown> {
    const env = processEnvironment({
      LIVEWARE_TOKEN: this.token,
      LIVEWARE_API_URL: this.options.livewareApiUrl,
    });
    const command = [this.options.livewarePath, ...args, "--json"];
    const result = await this.options.runProcess(command, env);
    if (result.exitCode !== 0) {
      const detail = result.stderr.trim() || result.stdout.trim() || `exit code ${result.exitCode}`;
      throw new Error(`liveware ${args.join(" ")} failed: ${detail}`);
    }
    const output = result.stdout.trim();
    if (!output) return null;
    try {
      return JSON.parse(output) as unknown;
    } catch {
      throw new Error(`liveware ${args.join(" ")} returned invalid JSON`);
    }
  }
}

interface HttpClawChatLivewareOptions {
  baseUrl: string;
  fetchImpl: typeof fetch;
}

class HttpClawChatLiveware implements ClawChatLivewarePort {
  constructor(private readonly options: HttpClawChatLivewareOptions) {}

  async list(activation: ActivationCredentials, deviceId: string): Promise<ClawChatLivewareRegistration[]> {
    const data = await this.call(activation, deviceId, "GET", "/v1/agents/me/liveware");
    const rows = Array.isArray(data.liveware) ? data.liveware : [];
    return rows.filter(isRecord).flatMap((row) => {
      const livewareId = textValue(row.liveware_id ?? row.external_id);
      const url = textValue(row.url);
      if (!livewareId || !url) return [];
      return [
        {
          livewareId,
          name: textValue(row.name),
          subtitle: textValue(row.subtitle),
          url,
        },
      ];
    });
  }

  async register(
    activation: ActivationCredentials,
    deviceId: string,
    registration: ClawChatLivewareRegistration,
  ): Promise<void> {
    const body = new FormData();
    body.set("name", registration.name);
    body.set("subtitle", registration.subtitle);
    body.set("liveware_id", registration.livewareId);
    body.set("url", registration.url);
    await this.call(activation, deviceId, "POST", "/v1/agents/me/liveware", body);
  }

  async unregister(activation: ActivationCredentials, deviceId: string, livewareId: string): Promise<void> {
    await this.call(activation, deviceId, "DELETE", `/v1/agents/me/liveware/${encodeURIComponent(livewareId)}`);
  }

  private async call(
    activation: ActivationCredentials,
    deviceId: string,
    method: string,
    path: string,
    body?: BodyInit,
  ): Promise<Record<string, unknown>> {
    const response = await this.options.fetchImpl(`${this.options.baseUrl}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${requireText(activation.accessToken, "ClawChat access token")}`,
        "X-Device-Id": requireText(deviceId, "deviceId"),
      },
      ...(body === undefined ? {} : { body }),
    });
    return await readEnvelope(response, `ClawChat ${method} ${path}`);
  }
}

async function runLivewareProcess(command: string[], env: Record<string, string>): Promise<LivewareProcessResult> {
  const child = Bun.spawn(command, {
    env,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { exitCode, stdout, stderr };
}

async function spawnLivewareAgent(command: string[], env: Record<string, string>): Promise<LivewareAgentProcess> {
  const child = Bun.spawn(command, {
    env,
    stdin: "ignore",
    stdout: "inherit",
    stderr: "inherit",
  });
  return {
    exited: child.exited,
    stop: async () => {
      if (child.exitCode === null) child.kill();
      await child.exited;
    },
  };
}

async function readEnvelope(response: Response, label: string): Promise<Record<string, unknown>> {
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new Error(`${label} returned invalid JSON (HTTP ${response.status})`);
  }
  if (!isRecord(body)) throw new Error(`${label} returned an invalid response`);
  const code = typeof body.code === "number" ? body.code : Number(body.code);
  if (!response.ok || code !== 0) {
    throw new Error(
      `${label} failed (HTTP ${response.status}, code ${String(body.code)}, ${textValue(body.msg ?? body.message)})`,
    );
  }
  return isRecord(body.data) ? body.data : {};
}

function readLivewareApp(value: unknown): LivewareApp {
  if (!isRecord(value)) throw new Error("Liveware app response is invalid");
  const appId = requireText(value.appId ?? value.app_id ?? value.id, "Liveware appId");
  const name = requireText(value.name, "Liveware app name");
  const rawUrl = requireText(
    value.publicUrl ?? value.public_url ?? value.url ?? value.domain,
    "Liveware app public URL",
  );
  return { appId, name, publicUrl: normalizeHttpUrl(withHttpScheme(rawUrl), "Liveware app public URL") };
}

function normalizeBaseUrl(value: string, label: string): string {
  return normalizeHttpUrl(value, label);
}

function withHttpScheme(value: string): string {
  return value.includes("://") ? value : `https://${value}`;
}

function processEnvironment(extra: Record<string, string>): Record<string, string> {
  const env = Object.fromEntries(
    Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
  );
  return { ...env, ...extra };
}

function requireText(value: unknown, label: string): string {
  const text = textValue(value);
  if (!text) throw new Error(`${label} is missing`);
  return text;
}

function textValue(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
