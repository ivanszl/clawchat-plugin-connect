import { createHash, randomUUID } from "node:crypto";
import { realpath, stat } from "node:fs/promises";
import { basename, isAbsolute } from "node:path";
import { leadingSkillName } from "../agent/skill-invocation";
import { bindingOutputVisibility } from "../clawchat/output-visibility";
import {
  type AddProjectRequest,
  type BootstrapView,
  type CancelTurnRequest,
  type ChangeSessionBindingRequest,
  CLIENT_API_PREFIX,
  type ClientViewEvent,
  type ConfigurePluginRequest,
  type ContinueSessionRequest,
  type CreateSessionRequest,
  type InstalledPluginView,
  MAX_PLUGIN_BUNDLE_BYTES,
  normalizeSessionRef,
  PLUGIN_MANAGER_CONFIG_HEADER,
  type PluginAdministrationView,
  type PluginCapabilityView,
  type PluginDiagnosticStage,
  type PluginDiagnosticView,
  type ProjectDirectoryRequest,
  type SessionCatalogView,
  type SessionMutationRequest,
  type SessionView,
  type UpdateBindingPreferencesRequest,
  type UpsertBindingProviderRequest,
  type UpdateSessionPreferencesRequest,
} from "../client-contract";
import { getAgentBinding, saveConfig } from "../config";
import type { ConnectStateStore } from "../persistence/state";
import { createAgentBinding } from "../plugin/binding";
import type { OfficialPluginDiscovery } from "../plugin/catalog";
import type { ConfigurePluginOptions, ConnectPluginHost, ManagePluginOptions, PluginUpdateCheck } from "../plugin/host";
import { type InstalledPluginLockEntry, validatePluginConfiguration } from "../plugin/store";
import {
  HostDirectoryError,
  listHostDirectories,
  type MaterializedProjectDirectory,
  materializeProjectDirectory,
} from "../projects/host-directories";
import { ProjectCatalog } from "../projects/projects";
import {
  createSessionContinuity,
  type SessionContinuityModule,
  SessionLifecycleError,
} from "../projects/session-continuity";
import { classifyWorkspaceArtifact } from "../projects/workspace-artifact";
import { MAX_RUNTIME_MEDIA_BYTES } from "../runtime/media-cache";
import { requireModel, resolveEffort } from "../runtime/model-selection";
import type { RuntimeAdapterRegistry } from "../runtime/registry";
import { RuntimeInteractionCoordinator, RuntimeInteractionError } from "../runtime/runtime-interaction-coordinator";
import type { RuntimeSlashSelection } from "../runtime/types";
import type { BindingRuntimeHandle } from "../service/binding-runtime";
import type { AgentBindingConfig, ConnectConfig } from "../types";
import { BINDING_SCOPE_HEADER } from "./binding-scoped-gateway";
import { resolveClientAssetsPath, staticResponse } from "./client-assets";
import {
  ClientRequestError,
  clientErrorView,
  commandError,
  errorResponse,
  eventCursor,
  isMutation,
  isPathWithin,
  isStringRecord,
  jsonResponse,
  parseBeforeCursor,
  parseLimit,
  readJsonBody,
  requireDisplayName,
  securityHeaders,
  setOptionalString,
  snapshotResponse,
  validatePreferencePatch,
  validRequestId,
  workspaceArtifactHeaders,
} from "./client-http";
import { SessionCatalog } from "./session-catalog";
import { validatedSessionOptions } from "./session-option-validation";
import type { TranscriptProjection } from "./transcript-projection";
import { TurnSubmission, type TurnSubmissionDraft, TurnSubmissionError } from "./turn-submission";
import { FileTurnSubmissionStaging } from "./turn-submission-staging";

const MAX_PLUGIN_MULTIPART_OVERHEAD_BYTES = 1024 * 1024;
const MAX_PLUGIN_UPLOAD_BODY_BYTES = MAX_PLUGIN_BUNDLE_BYTES + MAX_PLUGIN_MULTIPART_OVERHEAD_BYTES;

class ClientBindingRequestScope {
  constructor(
    readonly bindingId: string | null,
    private readonly catalog: SessionCatalog,
  ) {}

  includesBinding(bindingId: string): boolean {
    return this.bindingId === null || bindingId === this.bindingId;
  }

  async includesSession(sessionRef: string): Promise<boolean> {
    if (this.bindingId === null) return true;
    const entry = await this.catalog.entry(sessionRef);
    return entry?.bindingId === this.bindingId;
  }
}

export interface ClientInterfaceOptions {
  config: ConnectConfig;
  configPath: string;
  stateStore: ConnectStateStore;
  runtimeAdapters: RuntimeAdapterRegistry;
  transcriptProjection: TranscriptProjection;
  runtimeInteractions?: RuntimeInteractionCoordinator;
  projects?: ProjectCatalog;
  sessionContinuityModule?: SessionContinuityModule;
  pluginManager?: ConnectPluginHost;
  runtimes: BindingRuntimeHandle[];
  assetsPath?: string;
  hostname?: string;
  port?: number;
  serverFactory?: ClientHttpServerFactory;
}

export interface ClientHttpServerRequestContext {
  requestIP(request: Request): { address: string } | null;
}

export interface ClientHttpServerOptions {
  hostname: string;
  port: number;
  idleTimeout: number;
  fetch(request: Request, server?: ClientHttpServerRequestContext): Response | Promise<Response>;
}

export interface ClientHttpServerHandle {
  port?: number;
  stop(closeActiveConnections?: boolean): void | Promise<void>;
}

export type ClientHttpServerFactory = (options: ClientHttpServerOptions) => ClientHttpServerHandle;

export interface ClientInterfaceHandle {
  origin: string;
  stop(): Promise<void>;
}

export async function startClientInterface(options: ClientInterfaceOptions): Promise<ClientInterfaceHandle> {
  const hostname = options.hostname ?? options.config.clientHost;
  const port = options.port ?? options.config.clientPort;
  const origin = `http://${hostname}:${port}`;
  const assetsPath = options.assetsPath ?? (await resolveClientAssetsPath());
  const projects = options.projects ?? new ProjectCatalog(options.stateStore);
  const sessionContinuity =
    options.sessionContinuityModule?.create() ?? createSessionContinuity({ stateStore: options.stateStore });
  const runtimes = new Map(options.runtimes.map((runtime) => [runtime.agentId, runtime]));
  const catalog = new SessionCatalog({
    ...options,
    projects,
    runtimeFamily: async (binding) =>
      runtimeFamilyForClient(binding, options.runtimeAdapters, (await options.pluginManager?.list()) ?? []),
    sessionActivity: async (bindingId, sessionRef) =>
      (await runtimes.get(bindingId)?.sessionActivity?.(sessionRef)) ?? "idle",
    activeTurnId: (bindingId, sessionRef) => runtimes.get(bindingId)?.activeClientTurnId?.(sessionRef) ?? null,
    queuedTurns: (bindingId, sessionRef) => runtimes.get(bindingId)?.queuedClientTurns?.(sessionRef) ?? [],
    claimSessionLifecycle: async (bindingId, sessionRef) => {
      const claim = runtimes.get(bindingId)?.claimSessionLifecycle;
      return claim ? await claim(sessionRef) : async () => undefined;
    },
  });
  const runtimeInteractions =
    options.runtimeInteractions ?? new RuntimeInteractionCoordinator(options.transcriptProjection);
  const submissionStaging = new FileTurnSubmissionStaging(options.config.stateDbPath);
  const activeTurnSubmissions = new Map<string, AbortController>();
  const turnSubmissions = new TurnSubmission({
    capabilityFor: async (sessionRef) => {
      const view = await catalog.sessionView(sessionRef);
      if (!view) throw new ClientRequestError(404, "session-not-found", "Session was not found");
      if (view.isArchived)
        throw new ClientRequestError(409, "session-archived", "Archived Sessions cannot accept turns");
      if (!view.allowedActions.includes("send")) {
        throw new ClientRequestError(409, "session-state-conflict", "Session cannot accept a turn right now");
      }
      return view.turnSubmissionCapability;
    },
    staging: submissionStaging,
    accept: async (sessionRef, prompt, selection, staged, signal) => {
      signal?.throwIfAborted();
      if (runtimeInteractions.hasPending(sessionRef)) {
        throw new ClientRequestError(
          409,
          "runtime-interaction-pending",
          "Complete the pending Runtime interaction before sending another message",
        );
      }
      const session = await catalog.adopt(sessionRef);
      if (!session) throw new ClientRequestError(404, "session-not-found", "Session was not found");
      const runtime = runtimes.get(session.agentId);
      if (!runtime?.enqueueClientTurn) {
        throw new ClientRequestError(503, "runtime-offline", "Runtime is unavailable", true);
      }
      signal?.throwIfAborted();
      const accepted = await runtime.enqueueClientTurn(
        sessionRef,
        prompt,
        submissionStaging.mediaFor(staged),
        selection,
        signal,
      );
      catalog.invalidate();
      return { accepted: true, ...accepted };
    },
  });
  const publishClientViews = clientViewPublisher(options.stateStore, catalog);
  let ready = false;

  const serverFactory: ClientHttpServerFactory = options.serverFactory ?? ((serverOptions) => Bun.serve(serverOptions));
  const server = serverFactory({
    hostname,
    port,
    idleTimeout: 0,
    fetch: async (request, requestServer) => {
      try {
        const requestOrigin = allowedRequestOrigin(request, hostname, port);
        if (!requestOrigin) return errorResponse(400, "invalid-host", "Invalid Host header");
        const url = new URL(request.url);
        const pluginAdministrationPath = isPluginAdministrationPath(url.pathname);
        if (
          hostname === "0.0.0.0" &&
          pluginAdministrationPath &&
          !isLoopbackAddress(requestServer?.requestIP(request)?.address)
        ) {
          return errorResponse(404, "not-found", "Client Interface endpoint was not found");
        }
        const bindingScope = request.headers.get(BINDING_SCOPE_HEADER)?.trim() || null;
        if (bindingScope && !options.config.agents[bindingScope]) {
          return errorResponse(404, "binding-not-found", "Agent Binding was not found");
        }
        if (
          pluginAdministrationPath &&
          bindingScope &&
          (await options.stateStore.getLivewareExposure(bindingScope))?.accessPolicy !== "private"
        ) {
          return errorResponse(404, "not-found", "Client Interface endpoint was not found");
        }
        const pluginManagerConfigPath = request.headers.get(PLUGIN_MANAGER_CONFIG_HEADER);
        if (pluginManagerConfigPath && pluginAdministrationPath && pluginManagerConfigPath !== options.configPath) {
          return errorResponse(
            409,
            "plugin-manager-installation-mismatch",
            "The running Plugin manager belongs to a different Connect installation",
          );
        }
        const requestScope = new ClientBindingRequestScope(bindingScope, catalog);
        if (url.pathname.startsWith(CLIENT_API_PREFIX)) {
          if (!ready) {
            return errorResponse(503, "client-warming-up", "Connect Client is still initializing", true);
          }
          if (bindingScope) {
            const bindingPath = url.pathname.match(/^\/client\/v1\/bindings\/([^/]+)(?:\/|$)/u);
            if (bindingPath && !requestScope.includesBinding(decodeURIComponent(bindingPath[1] ?? ""))) {
              return errorResponse(404, "binding-not-found", "Agent Binding was not found");
            }
            const sessionPath = url.pathname.match(/^\/client\/v1\/sessions\/([^/]+)(?:\/|$)/u);
            const sessionRef = sessionPath ? normalizeSessionRef(sessionPath[1] ?? "") : null;
            if (sessionRef && !(await requestScope.includesSession(sessionRef))) {
              return errorResponse(404, "session-not-found", "Session was not found");
            }
          }
          if (isMutation(request.method)) {
            const mutationError = await validateMutationRequest(
              request,
              requestOrigin,
              options.stateStore,
              bindingScope,
            );
            if (mutationError) return mutationError;
          }
          if (url.pathname === `${CLIENT_API_PREFIX}/plugins/administration` && request.method === "GET") {
            if (!options.pluginManager) {
              return errorResponse(503, "plugin-manager-unavailable", "Plugin management is unavailable", true);
            }
            const [installed, updates, official] = await Promise.all([
              options.pluginManager.list(),
              options.pluginManager.checkUpdates(),
              options.pluginManager.discoverOfficial(),
            ]);
            return jsonResponse(pluginAdministrationView(options.config, installed, updates, official));
          }
          if (url.pathname === `${CLIENT_API_PREFIX}/plugins/upload` && request.method === "POST") {
            if (!options.pluginManager) {
              return errorResponse(503, "plugin-manager-unavailable", "Plugin management is unavailable", true);
            }
            const declaredLength = Number(request.headers.get("content-length") ?? "0");
            if (Number.isFinite(declaredLength) && declaredLength > MAX_PLUGIN_UPLOAD_BODY_BYTES) {
              return errorResponse(
                413,
                "plugin-upload-too-large",
                `Plugin Bundle exceeds the ${MAX_PLUGIN_BUNDLE_BYTES} byte upload limit`,
              );
            }
            const form = await readPluginUploadFormData(request);
            const bundle = form.get("bundle");
            if (!(bundle instanceof File) || !bundle.name.endsWith(".connect-plugin")) {
              return errorResponse(400, "invalid-plugin-upload", "bundle must be one .connect-plugin file");
            }
            if (bundle.size > MAX_PLUGIN_BUNDLE_BYTES) {
              return errorResponse(
                413,
                "plugin-upload-too-large",
                `Plugin Bundle exceeds the ${MAX_PLUGIN_BUNDLE_BYTES} byte upload limit`,
              );
            }
            try {
              const installationConfiguration = parsePluginFormConfiguration(
                form.get("installationConfiguration"),
                "installationConfiguration",
              );
              const exposureConfigurations = parsePluginFormConfiguration(
                form.get("exposureConfigurations"),
                "exposureConfigurations",
              );
              return jsonResponse(
                await options.pluginManager.installUpload(bundle.name, new Uint8Array(await bundle.arrayBuffer()), {
                  installationConfiguration,
                  exposureConfigurations,
                }),
                201,
              );
            } catch (error) {
              return errorResponse(
                409,
                "plugin-operation-failed",
                error instanceof Error ? error.message : String(error),
              );
            }
          }
          if (url.pathname === `${CLIENT_API_PREFIX}/plugins/official` && request.method === "GET") {
            if (!options.pluginManager) {
              return errorResponse(503, "plugin-manager-unavailable", "Plugin management is unavailable", true);
            }
            return jsonResponse(await options.pluginManager.discoverOfficial());
          }
          if (url.pathname === `${CLIENT_API_PREFIX}/plugins/official/setup` && request.method === "POST") {
            if (!options.pluginManager) {
              return errorResponse(503, "plugin-manager-unavailable", "Plugin management is unavailable", true);
            }
            const body = await readJsonBody<{ pluginIds?: unknown }>(request);
            if (!Array.isArray(body.pluginIds) || !body.pluginIds.every((pluginId) => typeof pluginId === "string")) {
              return errorResponse(
                400,
                "invalid-official-plugin-selection",
                "pluginIds must be an array of Plugin IDs",
              );
            }
            try {
              return jsonResponse(await options.pluginManager.installOfficial(body.pluginIds), 201);
            } catch (error) {
              return errorResponse(
                409,
                "plugin-operation-failed",
                error instanceof Error ? error.message : String(error),
              );
            }
          }
          const pluginPath = url.pathname.match(/^\/client\/v1\/plugins(?:\/([^/]+)(?:\/([^/]+))?)?$/u);
          if (pluginPath) {
            if (!options.pluginManager) {
              return errorResponse(503, "plugin-manager-unavailable", "Plugin management is unavailable", true);
            }
            if (!pluginPath[1] && request.method === "GET") {
              return jsonResponse(await options.pluginManager.list());
            }
            if (!pluginPath[1] && request.method === "POST") {
              const body = await readJsonBody<Partial<ManagePluginOptions>>(request);
              if (typeof body.source !== "string" || !body.source.trim()) {
                return errorResponse(400, "invalid-plugin-source", "source is required");
              }
              try {
                return jsonResponse(await options.pluginManager.install({ ...body, source: body.source }), 201);
              } catch (error) {
                return errorResponse(
                  409,
                  "plugin-operation-failed",
                  error instanceof Error ? error.message : String(error),
                );
              }
            }
            const pluginId = decodeURIComponent(pluginPath[1] ?? "");
            const action = pluginPath[2] ? decodeURIComponent(pluginPath[2]) : null;
            try {
              if (request.method === "DELETE" && action === null) {
                return jsonResponse(
                  await options.pluginManager.remove(pluginId, url.searchParams.get("force") === "1"),
                );
              }
              if (request.method === "POST" && action === "update") {
                const body = await readJsonBody<Partial<ManagePluginOptions>>(request);
                if (body.source !== undefined && (typeof body.source !== "string" || !body.source.trim())) {
                  return errorResponse(400, "invalid-plugin-source", "source must be a non-empty string");
                }
                return jsonResponse(await options.pluginManager.update(pluginId, body));
              }
              if (request.method === "POST" && action === "reinstall") {
                return jsonResponse(await options.pluginManager.reinstall(pluginId));
              }
              if (request.method === "POST" && action === "configure") {
                const body = await readJsonBody<Partial<ConfigurePluginRequest>>(request);
                if (
                  !isPlainRecord(body.installationConfiguration) ||
                  !isPlainRecord(body.exposureConfigurations) ||
                  !isPlainRecord(body.runtimeConfigurations)
                ) {
                  return errorResponse(
                    400,
                    "invalid-plugin-configuration",
                    "installationConfiguration, exposureConfigurations, and runtimeConfigurations must be JSON objects",
                  );
                }
                return jsonResponse(await options.pluginManager.configure(pluginId, body as ConfigurePluginOptions));
              }
              if (request.method === "POST" && action === "enable") {
                return jsonResponse(await options.pluginManager.enable(pluginId));
              }
              if (request.method === "POST" && action === "disable") {
                return jsonResponse(await options.pluginManager.disable(pluginId));
              }
              if (request.method === "POST" && action === "select") {
                const body = await readJsonBody<{ version?: unknown; integrity?: unknown }>(request);
                if (typeof body.version !== "string" || !body.version.trim()) {
                  return errorResponse(400, "invalid-plugin-version", "version is required");
                }
                if (body.integrity !== undefined && typeof body.integrity !== "string") {
                  return errorResponse(400, "invalid-plugin-integrity", "integrity must be a string");
                }
                return jsonResponse(
                  await options.pluginManager.select(pluginId, body.version, body.integrity as string | undefined),
                );
              }
            } catch (error) {
              return errorResponse(
                409,
                "plugin-operation-failed",
                error instanceof Error ? error.message : String(error),
              );
            }
            return errorResponse(404, "not-found", "Client Interface endpoint was not found");
          }
          if (url.pathname === `${CLIENT_API_PREFIX}/bootstrap` && request.method === "GET") {
            const installed = (await options.pluginManager?.list()) ?? [];
            const view: BootstrapView = {
              apiVersion: 1,
              eventCursor: await options.stateStore.getClientEventCursor(),
              outputVisibility: bindingScope
                ? bindingOutputVisibility(options.config, bindingScope)
                : options.config.outputVisibility,
              bindings: await Promise.all(
                Object.entries(options.config.agents)
                  .filter(([bindingId]) => requestScope.includesBinding(bindingId))
                  .map(async ([bindingId, binding]) => {
                    const active = options.runtimeAdapters.hasProvider(binding);
                    return {
                      bindingId,
                      displayName: binding.displayName || bindingId,
                      clawChatUserId: await options.stateStore.getActivationUserId(bindingId),
                      runtimeKind: runtimeFamilyForClient(binding, options.runtimeAdapters, installed),
                      outputVisibility: bindingOutputVisibility(options.config, bindingId),
                      model: binding.model ?? null,
                      modelReasoningEffort: binding.modelReasoningEffort ?? null,
                      runtimePluginId: binding.runtime.pluginId,
                      runtimeCapabilityId: binding.runtime.capabilityId,
                      runtimeConfiguration: structuredClone(binding.runtimeConfig),
                      modelOptions: active
                        ? ((await options.runtimeAdapters.listModels(getAgentBinding(options.config, bindingId))) ?? [])
                        : [],
                      modeOptions: active
                        ? [...options.runtimeAdapters.modesFor(getAgentBinding(options.config, bindingId))]
                        : [],
                    };
                  }),
              ),
              capabilities: {
                localTurns: true,
                cancellation: true,
                runtimeInteractions: true,
                preferenceEditing: true,
              },
            };
            return jsonResponse(view);
          }
          if (url.pathname === `${CLIENT_API_PREFIX}/session-catalog` && request.method === "GET") {
            const watermark = await options.stateStore.getClientEventCursor();
            return snapshotResponse(
              scopeSessionCatalog(await catalog.view(url.searchParams.get("refresh") === "1"), bindingScope),
              watermark,
            );
          }
          if (url.pathname === `${CLIENT_API_PREFIX}/host-directories` && request.method === "GET") {
            const path = url.searchParams.get("path");
            const showHidden = url.searchParams.get("showHidden") === "1";
            try {
              const projectShortcuts = (await projects.list()).map((project) => ({
                kind: "project" as const,
                name: project.name,
                path: project.rootPath,
              }));
              const runtimeShortcuts = (await catalog.runtimeWorkspaceLocations()).map((workspace) => ({
                kind: "runtime-workspace" as const,
                name: workspace.name,
                path: workspace.path,
              }));
              return jsonResponse(
                await listHostDirectories({
                  path,
                  showHidden,
                  shortcuts: [...projectShortcuts, ...runtimeShortcuts],
                }),
              );
            } catch (error) {
              return hostDirectoryErrorResponse(error);
            }
          }
          if (url.pathname === `${CLIENT_API_PREFIX}/projects` && request.method === "GET") {
            return jsonResponse(
              (await projects.list()).map((project) => ({
                ...project,
                workspaceId: projects.workspaceId(project),
              })),
            );
          }
          if (url.pathname === `${CLIENT_API_PREFIX}/projects` && request.method === "POST") {
            const body = await readJsonBody<AddProjectRequest>(request);
            if (!validRequestId(body.requestId))
              return errorResponse(400, "invalid-request-id", "requestId is required");
            if ("name" in body) return errorResponse(400, "invalid-project", "Project names are derived from its root");
            if ("additionalDirectories" in body)
              return errorResponse(400, "invalid-project", "Project additional directories are not supported");
            if (!isProjectDirectoryRequest(body.directory))
              return errorResponse(400, "invalid-project", "A valid Project directory is required");
            return await idempotentCommand(
              options.stateStore,
              body.requestId,
              "project.add",
              JSON.stringify(body.directory),
              async () => {
                let materialized: MaterializedProjectDirectory | null = null;
                try {
                  materialized = await materializeProjectDirectory(body.directory);
                  const registered = await projects.ensureRegistered(materialized.rootPath);
                  catalog.invalidate();
                  return {
                    status: registered.created ? 201 : 200,
                    body: { ...registered.project, workspaceId: projects.workspaceId(registered.project) },
                  };
                } catch (error) {
                  await materialized?.rollback();
                  return hostDirectoryCommandError(error, "project-conflict");
                }
              },
            );
          }
          if (url.pathname === `${CLIENT_API_PREFIX}/sessions` && request.method === "POST") {
            const body = await readJsonBody<CreateSessionRequest>(request);
            if (!validRequestId(body.requestId))
              return errorResponse(400, "invalid-request-id", "requestId is required");
            if (typeof body.bindingId !== "string" || !body.bindingId.trim())
              return errorResponse(400, "invalid-binding", "bindingId is required");
            if (!requestScope.includesBinding(body.bindingId))
              return errorResponse(404, "binding-not-found", "Agent Binding was not found");
            if (!isSessionWorkspaceRequest(body.workspace))
              return errorResponse(400, "invalid-workspace", "A valid Session workspace is required");
            if (body.name !== null && typeof body.name !== "string")
              return errorResponse(400, "invalid-name", "name must be a string or null");
            if (body.mode !== null && typeof body.mode !== "string")
              return errorResponse(400, "invalid-mode", "mode must be a string or null");
            if (body.model !== null && typeof body.model !== "string")
              return errorResponse(400, "invalid-model", "model must be a string or null");
            if (body.reasoningEffort !== null && typeof body.reasoningEffort !== "string")
              return errorResponse(400, "invalid-reasoning-effort", "reasoningEffort must be a string or null");
            if (!isStringRecord(body.sessionOptions))
              return errorResponse(400, "invalid-session-options", "sessionOptions must contain only string values");
            return await idempotentCommand(
              options.stateStore,
              body.requestId,
              "session.create",
              body.bindingId,
              async () => {
                if (!options.config.agents[body.bindingId])
                  return commandError(404, "binding-not-found", "Agent Binding was not found");
                const binding = getAgentBinding(options.config, body.bindingId);
                let workspaceProject =
                  body.workspace.kind === "existing" ? await projects.get(body.workspace.workspaceId) : null;
                if (body.workspace.kind === "existing" && !workspaceProject)
                  return commandError(400, "invalid-workspace", "Project Workspace ID was not found");
                const name = body.name?.trim() || null;
                if (name && name.length > 200)
                  return commandError(400, "invalid-name", "Session name must be at most 200 characters");
                const modes = options.runtimeAdapters.modesFor(binding);
                if (body.mode && !modes.includes(body.mode))
                  return commandError(400, "invalid-mode", `Mode is not available: ${body.mode}`);
                let model: string | null = null;
                let reasoningEffort: string | null = null;
                try {
                  if (body.model) {
                    const selectedModel = requireModel(await options.runtimeAdapters.listModels(binding), body.model);
                    model = selectedModel.id;
                    reasoningEffort = resolveEffort(selectedModel, body.reasoningEffort, true);
                  } else if (body.reasoningEffort) {
                    return commandError(400, "invalid-reasoning-effort", "reasoningEffort requires a model");
                  }
                } catch (error) {
                  return commandError(400, "invalid-model", error instanceof Error ? error.message : String(error));
                }
                let materialized: MaterializedProjectDirectory | null = null;
                let createdProjectId: string | null = null;
                let preserveMaterializedDirectory = false;
                try {
                  if (body.workspace.kind === "new-project") {
                    materialized = await materializeProjectDirectory(body.workspace.directory);
                    const registered = await projects.ensureRegistered(materialized.rootPath);
                    workspaceProject = registered.project;
                    if (registered.created) createdProjectId = registered.project.projectId;
                    else preserveMaterializedDirectory = true;
                  }
                  const workspace = workspaceProject
                    ? await projects.resolveProjectWorkspace(workspaceProject.projectId)
                    : {
                        projectId: null,
                        workingDirectory: projects.workspaceRoot,
                        skipGitRepoCheck: true,
                      };
                  const validatedOptions = await validatedSessionOptions(
                    options.runtimeAdapters,
                    binding,
                    workspace,
                    body.sessionOptions ?? {},
                  );
                  if (!validatedOptions.ok) {
                    await rollbackInlineProject(
                      projects,
                      createdProjectId,
                      materialized,
                      preserveMaterializedDirectory,
                    );
                    return validatedOptions.error;
                  }
                  const chatId = `__connect_client_session__:${randomUUID()}`;
                  const session = await sessionContinuity.inConversation({ chatId, bindingId: body.bindingId }).create({
                    projectId: workspaceProject?.projectId ?? null,
                    name,
                    mode: body.mode,
                    model,
                    reasoningEffort,
                    sessionOptions: validatedOptions.value,
                  });
                  catalog.invalidate();
                  let view: SessionView | null;
                  try {
                    view = await catalog.sessionView(session.sessionRef);
                  } catch (error) {
                    await sessionContinuity.forSession(session.sessionRef).discardEmpty();
                    catalog.invalidate();
                    throw new ClientRequestError(
                      503,
                      "session-view-unavailable",
                      error instanceof Error ? error.message : "Session view is unavailable",
                      true,
                    );
                  }
                  if (!view) {
                    await sessionContinuity.forSession(session.sessionRef).discardEmpty();
                    catalog.invalidate();
                    throw new ClientRequestError(503, "session-create-failed", "Session could not be created", true);
                  }
                  return { status: 201, body: view };
                } catch (error) {
                  await rollbackInlineProject(projects, createdProjectId, materialized, preserveMaterializedDirectory);
                  catalog.invalidate();
                  if (error instanceof HostDirectoryError) return hostDirectoryCommandError(error, "project-conflict");
                  throw error;
                }
              },
            );
          }
          const projectMatch = url.pathname.match(/^\/client\/v1\/projects\/([^/]+)$/u);
          if (projectMatch && request.method === "DELETE") {
            const reference = decodeURIComponent(projectMatch[1] ?? "");
            const body = await readJsonBody<SessionMutationRequest>(request);
            if (!validRequestId(body.requestId))
              return errorResponse(400, "invalid-request-id", "requestId is required");
            return await idempotentCommand(
              options.stateStore,
              body.requestId,
              "project.remove",
              reference,
              async () => {
                try {
                  const result = await projects.remove(reference);
                  if (!result.removed)
                    return commandError(
                      409,
                      "project-in-use",
                      `${result.referencedSessions} Session(s) and ${result.pendingIntents} Session Intent(s) still reference this Project`,
                    );
                  catalog.invalidate();
                  return {
                    status: 200,
                    body: { workspaceId: projects.workspaceId(result.project), removed: true },
                  };
                } catch (error) {
                  return commandError(404, "project-not-found", error instanceof Error ? error.message : String(error));
                }
              },
            );
          }
          if (url.pathname === `${CLIENT_API_PREFIX}/events` && request.method === "GET") {
            const after = eventCursor(request, url);
            return eventStreamResponse(options.stateStore, request, after, publishClientViews, bindingScope, catalog);
          }
          if (url.pathname === `${CLIENT_API_PREFIX}/events/batch` && request.method === "GET") {
            const after = eventCursor(request, url);
            await publishClientViews();
            const events = await options.stateStore.listClientEvents(after);
            const visibleEvents = await scopedClientEvents(
              events.map((event) => event.event),
              bindingScope,
              catalog,
              after,
            );
            return jsonResponse({
              cursor: events.at(-1)?.cursor ?? after,
              events: visibleEvents,
            });
          }
          const slashSuggestionsMatch = url.pathname.match(/^\/client\/v1\/sessions\/([^/]+)\/slash-suggestions$/u);
          if (slashSuggestionsMatch && request.method === "GET") {
            const sessionRef = normalizeSessionRef(slashSuggestionsMatch[1] ?? "");
            if (!sessionRef) return errorResponse(400, "invalid-session-ref", "Invalid Session Ref");
            const refresh = url.searchParams.get("refresh") === "1";
            const [commands, skills] = await Promise.all([
              sessionCommands(sessionRef, catalog, options, refresh),
              sessionSkills(sessionRef, catalog, options, refresh),
            ]);
            if (commands === undefined || skills === undefined)
              return errorResponse(404, "session-not-found", "Session was not found");
            return jsonResponse({
              supported: commands !== null || skills !== null,
              entries: [
                ...(commands ?? []).map((command) => ({ ...command, kind: "command" as const })),
                ...(skills ?? []).map((skill) => ({ ...skill, kind: "skill" as const })),
              ],
            });
          }
          const sessionMatch = url.pathname.match(/^\/client\/v1\/sessions\/([^/]+)$/u);
          if (sessionMatch && request.method === "GET") {
            const sessionRef = normalizeSessionRef(sessionMatch[1] ?? "");
            if (!sessionRef) return errorResponse(400, "invalid-session-ref", "Invalid Session Ref");
            await catalog.ensureProjection(sessionRef, url.searchParams.get("refresh") === "1");
            const watermark = await options.stateStore.getClientEventCursor();
            const view = await catalog.sessionView(sessionRef);
            return view && requestScope.includesBinding(view.bindingId)
              ? snapshotResponse(view, watermark)
              : errorResponse(404, "session-not-found", "Session was not found");
          }
          const changeBindingMatch = url.pathname.match(/^\/client\/v1\/sessions\/([^/]+)\/binding$/u);
          if (changeBindingMatch && request.method === "PATCH") {
            const sessionRef = normalizeSessionRef(changeBindingMatch[1] ?? "");
            if (!sessionRef) return errorResponse(400, "invalid-session-ref", "Invalid Session Ref");
            const body = await readJsonBody<ChangeSessionBindingRequest>(request);
            if (!validRequestId(body.requestId))
              return errorResponse(400, "invalid-request-id", "requestId is required");
            if (typeof body.bindingId !== "string" || !body.bindingId.trim()) {
              return errorResponse(400, "invalid-binding", "bindingId is required");
            }
            return await idempotentCommand(
              options.stateStore,
              body.requestId,
              "session.binding.change",
              `${sessionRef}:${body.bindingId}`,
              async () => {
                await requireActiveOwnerBinding(options, body.bindingId);
                await sessionContinuity.forSession(sessionRef).changeBinding(body.bindingId);
                catalog.invalidate();
                const view = await catalog.sessionView(sessionRef);
                return view
                  ? { status: 200, body: view }
                  : commandError(404, "session-not-found", "Session was not found");
              },
            );
          }
          const continuationMatch = url.pathname.match(/^\/client\/v1\/sessions\/([^/]+)\/continuations$/u);
          if (continuationMatch && request.method === "POST") {
            const sessionRef = normalizeSessionRef(continuationMatch[1] ?? "");
            if (!sessionRef) return errorResponse(400, "invalid-session-ref", "Invalid Session Ref");
            const body = await readJsonBody<ContinueSessionRequest>(request);
            if (!validRequestId(body.requestId))
              return errorResponse(400, "invalid-request-id", "requestId is required");
            if (typeof body.bindingId !== "string" || !body.bindingId.trim()) {
              return errorResponse(400, "invalid-binding", "bindingId is required");
            }
            return await idempotentCommand(
              options.stateStore,
              body.requestId,
              "session.continue",
              `${sessionRef}:${body.bindingId}`,
              async () => {
                const source = await options.stateStore.getRuntimeSessionByRef(sessionRef);
                if (!source) return commandError(404, "session-not-found", "Session was not found");
                if (source.agentId === body.bindingId) {
                  return commandError(
                    409,
                    "continuation-binding-unchanged",
                    "Choose another active Agent Binding for the continuation",
                  );
                }
                await requireActiveOwnerBinding(options, body.bindingId);
                const continuation = await sessionContinuity.forSession(sessionRef).continueWith(body.bindingId);
                catalog.invalidate();
                const view = await catalog.sessionView(continuation.sessionRef);
                if (view) return { status: 201, body: view };
                await sessionContinuity.forSession(continuation.sessionRef).discardEmpty();
                catalog.invalidate();
                return commandError(503, "session-create-failed", "Continuation Session could not be created", true);
              },
            );
          }
          const transcriptMatch = url.pathname.match(/^\/client\/v1\/sessions\/([^/]+)\/transcript$/u);
          if (transcriptMatch && request.method === "GET") {
            const sessionRef = normalizeSessionRef(transcriptMatch[1] ?? "");
            if (!sessionRef) return errorResponse(400, "invalid-session-ref", "Invalid Session Ref");
            if (!(await catalog.ensureProjection(sessionRef))) {
              return errorResponse(404, "session-not-found", "Session was not found");
            }
            const before = parseBeforeCursor(url.searchParams.get("before"));
            const limit = parseLimit(url.searchParams.get("limit"));
            const watermark = await options.stateStore.getClientEventCursor();
            const blocks = await options.stateStore.listTranscriptBlocks(sessionRef, { beforeSequence: before, limit });
            const firstSequence = blocks[0]?.sequence ?? null;
            const hasOlder = firstSequence
              ? (await options.stateStore.listTranscriptBlocks(sessionRef, { beforeSequence: firstSequence, limit: 1 }))
                  .length > 0
              : false;
            return snapshotResponse(
              {
                sessionRef,
                blocks,
                beforeCursor: hasOlder && firstSequence ? `s:${firstSequence}` : null,
                hasOlder,
                completeness: options.transcriptProjection.completeness(sessionRef) ?? "live-only",
              },
              watermark,
            );
          }
          const workspaceFileMatch = url.pathname.match(/^\/client\/v1\/sessions\/([^/]+)\/files$/u);
          if (workspaceFileMatch && request.method === "GET") {
            const sessionRef = normalizeSessionRef(workspaceFileMatch[1] ?? "");
            if (!sessionRef) return errorResponse(400, "invalid-session-ref", "Invalid Session Ref");
            const workspace = await catalog.workspace(sessionRef);
            if (!workspace) return errorResponse(404, "session-not-found", "Session was not found");
            const requestedPath = url.searchParams.get("path")?.trim() ?? "";
            if (!requestedPath || !isAbsolute(requestedPath)) {
              return errorResponse(400, "invalid-workspace-file", "Workspace file path must be absolute");
            }
            const canonicalPath = await realpath(requestedPath).catch(() => null);
            if (!canonicalPath) return errorResponse(404, "workspace-file-not-found", "Workspace file was not found");
            const roots = [await realpath(workspace.workingDirectory).catch(() => null)];
            if (!roots.some((root) => root && isPathWithin(root, canonicalPath))) {
              return errorResponse(403, "workspace-file-forbidden", "Workspace file is outside this Session");
            }
            const artifactType = classifyWorkspaceArtifact(canonicalPath);
            if (!artifactType) {
              return errorResponse(415, "workspace-file-unsupported", "This file type cannot be opened in Liveware");
            }
            const details = await stat(canonicalPath);
            if (!details.isFile()) {
              return errorResponse(404, "workspace-file-not-found", "Workspace file was not found");
            }
            if (details.size > artifactType.maxBytes) {
              return errorResponse(413, "workspace-file-too-large", "Workspace file is too large to open");
            }
            return new Response(Bun.file(canonicalPath), {
              headers: workspaceArtifactHeaders({
                "Content-Type": artifactType.mime,
                "Content-Length": String(details.size),
                "Content-Disposition": `inline; filename*=UTF-8''${encodeURIComponent(basename(canonicalPath))}`,
                "Cache-Control": "no-store",
                "X-ClawChat-Artifact-Kind": artifactType.kind,
                ...(artifactType.language ? { "X-ClawChat-Artifact-Language": artifactType.language } : {}),
              }),
            });
          }
          const archiveMatch = url.pathname.match(/^\/client\/v1\/sessions\/([^/]+)\/archive$/u);
          if (archiveMatch && request.method === "POST") {
            const sessionRef = normalizeSessionRef(archiveMatch[1] ?? "");
            if (!sessionRef) return errorResponse(400, "invalid-session-ref", "Invalid Session Ref");
            const body = await readJsonBody<SessionMutationRequest>(request);
            if (!validRequestId(body.requestId))
              return errorResponse(400, "invalid-request-id", "requestId is required");
            return await idempotentCommand(
              options.stateStore,
              body.requestId,
              "session.archive",
              sessionRef,
              async () => {
                if (!(await catalog.entry(sessionRef))) {
                  return commandError(404, "session-not-found", "Session was not found");
                }
                if (!(await catalog.archive(sessionRef))) {
                  return commandError(409, "session-state-conflict", "Session is already archived");
                }
                return { status: 200, body: { sessionRef, archived: true } };
              },
            );
          }
          const unarchiveMatch = url.pathname.match(/^\/client\/v1\/sessions\/([^/]+)\/unarchive$/u);
          if (unarchiveMatch && request.method === "POST") {
            const sessionRef = normalizeSessionRef(unarchiveMatch[1] ?? "");
            if (!sessionRef) return errorResponse(400, "invalid-session-ref", "Invalid Session Ref");
            const body = await readJsonBody<SessionMutationRequest>(request);
            if (!validRequestId(body.requestId))
              return errorResponse(400, "invalid-request-id", "requestId is required");
            return await idempotentCommand(
              options.stateStore,
              body.requestId,
              "session.unarchive",
              sessionRef,
              async () => {
                if (!(await catalog.entry(sessionRef))) {
                  return commandError(404, "session-not-found", "Session was not found");
                }
                if (!(await catalog.unarchive(sessionRef))) {
                  return commandError(409, "session-state-conflict", "Session is not archived");
                }
                return { status: 200, body: { sessionRef, archived: false } };
              },
            );
          }
          const deleteSessionMatch = url.pathname.match(/^\/client\/v1\/sessions\/([^/]+)$/u);
          if (deleteSessionMatch && request.method === "DELETE") {
            const sessionRef = normalizeSessionRef(deleteSessionMatch[1] ?? "");
            if (!sessionRef) return errorResponse(400, "invalid-session-ref", "Invalid Session Ref");
            const body = await readJsonBody<SessionMutationRequest>(request);
            if (!validRequestId(body.requestId))
              return errorResponse(400, "invalid-request-id", "requestId is required");
            return await idempotentCommand(
              options.stateStore,
              body.requestId,
              "session.delete",
              sessionRef,
              async () => {
                if (!(await catalog.delete(sessionRef))) {
                  return commandError(404, "session-not-found", "Session was not found");
                }
                return { status: 200, body: { sessionRef, deleted: true } };
              },
            );
          }
          const attachmentMatch = url.pathname.match(/^\/client\/v1\/turn-submissions\/([^/]+)\/attachments\/(\d+)$/u);
          if (attachmentMatch && request.method === "GET") {
            const submissionId = decodeURIComponent(attachmentMatch[1] ?? "");
            const index = Number(attachmentMatch[2]);
            if (!validRequestId(submissionId))
              return errorResponse(400, "invalid-submission-id", "Invalid submission identity");
            const attachment = await submissionStaging.attachment(submissionId, index);
            if (!attachment) return errorResponse(404, "attachment-not-found", "Attachment was not found");
            if (
              bindingScope &&
              (!attachment.sessionRef || !(await requestScope.includesSession(attachment.sessionRef)))
            ) {
              return errorResponse(404, "attachment-not-found", "Attachment was not found");
            }
            return new Response(Bun.file(attachment.path), {
              headers: securityHeaders({
                "Content-Type": attachment.mime || "application/octet-stream",
                "Content-Length": String(attachment.size),
                "Content-Disposition": `inline; filename*=UTF-8''${encodeURIComponent(attachment.name)}`,
                "Cache-Control": "private, max-age=3600",
              }),
            });
          }
          const submissionMatch = url.pathname.match(/^\/client\/v1\/sessions\/([^/]+)\/turn-submissions\/([^/]+)$/u);
          if (submissionMatch && (request.method === "GET" || request.method === "DELETE")) {
            const sessionRef = normalizeSessionRef(submissionMatch[1] ?? "");
            const submissionId = decodeURIComponent(submissionMatch[2] ?? "");
            if (!sessionRef) return errorResponse(400, "invalid-session-ref", "Invalid Session Ref");
            if (!validRequestId(submissionId))
              return errorResponse(400, "invalid-submission-id", "Invalid submission identity");
            const submissionTarget = `${sessionRef}:${submissionId}`;
            const outcome = await options.stateStore.getClientCommandOutcome(submissionId);
            const belongsToSession =
              outcome.state !== "missing" &&
              outcome.commandKind === "turn.submit" &&
              outcome.entityRef.startsWith(`${sessionRef}:`);
            if (outcome.state === "complete" && belongsToSession) {
              return jsonResponse(outcome.responseBody, outcome.responseStatus);
            }
            if (outcome.state !== "missing" && !belongsToSession) {
              return errorResponse(404, "submission-not-found", "Turn Submission was not found");
            }
            if (request.method === "DELETE") {
              if (!(await options.stateStore.cancelTurnSubmission(submissionId, sessionRef))) {
                return errorResponse(409, "submission-id-conflict", "Submission identity belongs to another Session");
              }
              activeTurnSubmissions.get(submissionTarget)?.abort();
            }
            if (outcome.state === "pending" && belongsToSession) {
              return jsonResponse({ pending: true, submissionId, sessionRef }, 202);
            }
            if (request.method === "DELETE") {
              return jsonResponse({ cancelled: true, submissionId, sessionRef }, 200);
            }
            return errorResponse(404, "submission-not-found", "Turn Submission was not found");
          }
          if (submissionMatch && request.method === "POST") {
            const sessionRef = normalizeSessionRef(submissionMatch[1] ?? "");
            const submissionId = decodeURIComponent(submissionMatch[2] ?? "");
            if (!sessionRef) return errorResponse(400, "invalid-session-ref", "Invalid Session Ref");
            if (!validRequestId(submissionId))
              return errorResponse(400, "invalid-submission-id", "Invalid submission identity");
            const submissionTarget = `${sessionRef}:${submissionId}`;
            const declaredLength = Number(request.headers.get("content-length") ?? "0");
            if (Number.isFinite(declaredLength) && declaredLength > MAX_RUNTIME_MEDIA_BYTES + 1_048_576) {
              return errorResponse(413, "submission-too-large", "Turn Submission may not exceed 101 MiB");
            }
            const form = await request.formData();
            const prompt = form.get("prompt");
            if (typeof prompt !== "string") return errorResponse(400, "invalid-prompt", "prompt must be text");
            const selectionKind = form.get("selectionKind");
            const selectionId = form.get("selectionId");
            const selectionName = form.get("selectionName");
            const selectionFields = [selectionKind, selectionId, selectionName];
            if (selectionFields.some((value) => value !== null && typeof value !== "string"))
              return errorResponse(400, "invalid-selection", "Slash selection must be text");
            if (selectionFields.some((value) => value === null) && selectionFields.some((value) => value !== null))
              return errorResponse(400, "invalid-selection", "Selection kind, id, and name must be provided together");
            let selection: RuntimeSlashSelection | null = null;
            if (
              typeof selectionKind === "string" &&
              typeof selectionId === "string" &&
              typeof selectionName === "string"
            ) {
              if (!selectionId.trim() || !selectionName.trim() || !["command", "skill"].includes(selectionKind))
                return errorResponse(400, "invalid-selection", "Slash selection is invalid");
              if (leadingSkillName(prompt) !== selectionName)
                return errorResponse(
                  400,
                  "selection-prompt-mismatch",
                  "Selected slash entry must match the leading prompt prefix",
                );
              selection = { kind: selectionKind as "command" | "skill", id: selectionId, name: selectionName };
            } else {
              const manualName = leadingSkillName(prompt);
              if (manualName) {
                const commands = await sessionCommands(sessionRef, catalog, options, false, true).catch(() => null);
                const command = commands?.find((candidate) => candidate.name === manualName);
                if (command) selection = { ...command, kind: "command" };
                else {
                  const skills = await sessionSkills(sessionRef, catalog, options, false, true).catch(() => null);
                  const skill = skills?.find((candidate) => candidate.name === manualName);
                  if (skill) selection = { ...skill, kind: "skill" };
                }
              }
            }
            const files = form.getAll("attachments");
            if (!files.every((file): file is File => file instanceof File && file.size > 0)) {
              return errorResponse(400, "invalid-attachment", "Attachments must be non-empty files");
            }
            const draft: TurnSubmissionDraft = {
              submissionId,
              sessionRef,
              prompt,
              selection,
              attachments: files.map((file) => ({
                name: file.name || "attachment",
                mime: file.type,
                size: file.size,
                readBytes: async () => new Uint8Array(await file.arrayBuffer()),
              })),
            };
            const digest = await turnSubmissionDigest(draft);
            const controller = new AbortController();
            activeTurnSubmissions.set(submissionTarget, controller);
            try {
              if (await options.stateStore.isTurnSubmissionCancelled(submissionId, sessionRef)) {
                const cancelled = clientErrorView(
                  "submission-cancelled",
                  "Turn Submission was cancelled before acceptance",
                  false,
                );
                const claim = await options.stateStore.claimClientCommand(
                  submissionId,
                  "turn.submit",
                  `${sessionRef}:${digest}`,
                );
                if (claim.state === "conflict") {
                  return errorResponse(409, "request-id-conflict", "requestId was used by another command");
                }
                if (claim.state === "complete") return jsonResponse(claim.responseBody, claim.responseStatus);
                await options.stateStore.completeClientCommand(submissionId, 409, cancelled);
                return jsonResponse(cancelled, 409);
              }
              return await idempotentCommand(
                options.stateStore,
                submissionId,
                "turn.submit",
                `${sessionRef}:${digest}`,
                async () => {
                  try {
                    return {
                      status: 202,
                      body: await turnSubmissions.submit(draft, controller.signal),
                    };
                  } catch (error) {
                    if (error instanceof TurnSubmissionError) {
                      return commandError(400, error.code, error.message);
                    }
                    if (error instanceof ClientRequestError) {
                      return commandError(error.status, error.code, error.message, error.retryable);
                    }
                    if (error instanceof SessionLifecycleError) {
                      return commandError(error.code === "session-not-found" ? 404 : 409, error.code, error.message);
                    }
                    if (error instanceof DOMException && error.name === "AbortError") {
                      return commandError(409, "submission-cancelled", "Turn Submission was cancelled");
                    }
                    return commandError(
                      500,
                      "submission-failed",
                      error instanceof Error ? error.message : "Turn Submission failed",
                      true,
                    );
                  }
                },
                { preserveClaimOnError: true },
              );
            } finally {
              if (activeTurnSubmissions.get(submissionTarget) === controller) {
                activeTurnSubmissions.delete(submissionTarget);
              }
            }
          }
          const interactionMatch = url.pathname.match(/^\/client\/v1\/runtime-interactions\/([^/]+)\/respond$/u);
          if (interactionMatch && request.method === "POST") {
            const interactionId = decodeURIComponent(interactionMatch[1] ?? "");
            const interactionSessionRef = runtimeInteractions.pendingSessionRef(interactionId);
            if (
              bindingScope &&
              (!interactionSessionRef || !(await requestScope.includesSession(interactionSessionRef)))
            ) {
              return errorResponse(404, "interaction-not-found", "Runtime Interaction was not found");
            }
            const body = await readJsonBody<import("../client-contract").RespondToRuntimeInteractionRequest>(request);
            if (!validRequestId(body.requestId))
              return errorResponse(400, "invalid-request-id", "requestId is required");
            try {
              const block = await runtimeInteractions.respond(interactionId, body);
              catalog.invalidate();
              return jsonResponse(block);
            } catch (error) {
              if (error instanceof RuntimeInteractionError) {
                return errorResponse(error.code === "interaction-not-pending" ? 409 : 400, error.code, error.message);
              }
              throw error;
            }
          }
          const sessionPreferenceMatch = url.pathname.match(/^\/client\/v1\/sessions\/([^/]+)\/preferences$/u);
          if (sessionPreferenceMatch && request.method === "PATCH") {
            const sessionRef = normalizeSessionRef(sessionPreferenceMatch[1] ?? "");
            if (!sessionRef) return errorResponse(400, "invalid-session-ref", "Invalid Session Ref");
            const body = await readJsonBody<UpdateSessionPreferencesRequest>(request);
            if (!validRequestId(body.requestId))
              return errorResponse(400, "invalid-request-id", "requestId is required");
            if (body.model !== null && typeof body.model !== "string")
              return errorResponse(400, "invalid-model", "model must be a string or null");
            if (body.reasoningEffort !== null && typeof body.reasoningEffort !== "string")
              return errorResponse(400, "invalid-reasoning-effort", "reasoningEffort must be a string or null");
            if (!isStringRecord(body.sessionOptions))
              return errorResponse(400, "invalid-session-options", "sessionOptions must contain only string values");
            return await idempotentCommand(
              options.stateStore,
              body.requestId,
              "session.preferences.update",
              sessionRef,
              async () => {
                const session = await options.stateStore.getRuntimeSessionByRef(sessionRef);
                if (!session) return commandError(404, "session-not-found", "Session was not found");
                if (!options.config.agents[session.agentId])
                  return commandError(404, "binding-not-found", "Agent Binding was not found");
                const binding = getAgentBinding(options.config, session.agentId);
                let model: string | null = null;
                let reasoningEffort: string | null = null;
                try {
                  if (body.model) {
                    const workspace = await projects.resolveWorkspace(session);
                    const models = await options.runtimeAdapters.listModels(binding, {
                      runtimeThreadId: session.runtimeSessionId ?? undefined,
                      workspace,
                    });
                    const selectedModel = requireModel(models, body.model);
                    model = selectedModel.id;
                    reasoningEffort = resolveEffort(selectedModel, body.reasoningEffort, true);
                  } else if (body.reasoningEffort) {
                    return commandError(400, "invalid-reasoning-effort", "reasoningEffort requires a model");
                  }
                } catch (error) {
                  return commandError(400, "invalid-model", error instanceof Error ? error.message : String(error));
                }
                let sessionOptions: Record<string, string> | undefined;
                if (body.sessionOptions !== undefined) {
                  const validatedOptions = await validatedSessionOptions(
                    options.runtimeAdapters,
                    binding,
                    await projects.resolveWorkspace(session),
                    body.sessionOptions,
                    true,
                    { runtimeThreadId: session.runtimeSessionId ?? undefined },
                  );
                  if (!validatedOptions.ok) return validatedOptions.error;
                  sessionOptions = validatedOptions.value;
                }
                const lifecycle = sessionContinuity.forSession(session.sessionRef);
                await lifecycle.changeModel(model, reasoningEffort);
                if (sessionOptions) await lifecycle.changeSessionOptions(sessionOptions);
                catalog.invalidate();
                const view = await catalog.sessionView(sessionRef);
                return view
                  ? { status: 200, body: view }
                  : commandError(404, "session-not-found", "Session was not found");
              },
            );
          }
          const queuedTurnMatch = url.pathname.match(
            /^\/client\/v1\/sessions\/([^/]+)\/queued-turns\/([^/]+)\/withdraw$/u,
          );
          if (queuedTurnMatch && request.method === "POST") {
            const sessionRef = normalizeSessionRef(queuedTurnMatch[1] ?? "");
            const turnId = decodeURIComponent(queuedTurnMatch[2] ?? "");
            if (!sessionRef) return errorResponse(400, "invalid-session-ref", "Invalid Session Ref");
            if (!turnId) return errorResponse(400, "invalid-turn-id", "turnId is required");
            const body = await readJsonBody<{ requestId?: string }>(request);
            if (!validRequestId(body.requestId))
              return errorResponse(400, "invalid-request-id", "requestId is required");
            return await idempotentCommand(
              options.stateStore,
              body.requestId,
              "queued-turn.withdraw",
              `${sessionRef}:${turnId}`,
              async () => {
                const session = await options.stateStore.getRuntimeSessionByRef(sessionRef);
                const runtime = session ? runtimes.get(session.agentId) : null;
                const cancelled = runtime?.cancelQueuedClientTurn?.(sessionRef, turnId) ?? false;
                if (!cancelled) return commandError(409, "queued-turn-not-found", "Queued turn is no longer pending");
                catalog.invalidate();
                await publishClientViews();
                return { status: 200, body: { cancelled: true, sessionRef, turnId } };
              },
            );
          }
          const cancelMatch = url.pathname.match(/^\/client\/v1\/sessions\/([^/]+)\/turns\/[^/]+\/cancel$/u);
          if (cancelMatch && request.method === "POST") {
            const sessionRef = normalizeSessionRef(cancelMatch[1] ?? "");
            if (!sessionRef) return errorResponse(400, "invalid-session-ref", "Invalid Session Ref");
            const body = await readJsonBody<CancelTurnRequest>(request);
            if (!validRequestId(body.requestId))
              return errorResponse(400, "invalid-request-id", "requestId is required");
            return await idempotentCommand(options.stateStore, body.requestId, "turn.cancel", sessionRef, async () => {
              const session = await options.stateStore.getRuntimeSessionByRef(sessionRef);
              const runtime = session ? runtimes.get(session.agentId) : null;
              const cancelled = (await runtime?.cancelClientTurn?.(sessionRef)) ?? false;
              return { status: 200, body: { cancelled, sessionRef } };
            });
          }
          const providerMatch = url.pathname.match(/^\/client\/v1\/bindings\/([^/]+)\/provider$/u);
          if (providerMatch && request.method === "PUT") {
            const bindingId = decodeURIComponent(providerMatch[1] ?? "").trim();
            if (!bindingId) return errorResponse(400, "invalid-binding-id", "Agent Binding ID is required");
            const body = await readJsonBody<UpsertBindingProviderRequest>(request);
            if (!validRequestId(body.requestId))
              return errorResponse(400, "invalid-request-id", "requestId is required");
            if (typeof body.pluginId !== "string" || !body.pluginId.trim()) {
              return errorResponse(400, "invalid-plugin-id", "Plugin ID is required");
            }
            if (typeof body.capabilityId !== "string" || !body.capabilityId.trim()) {
              return errorResponse(400, "invalid-capability-id", "Runtime capability ID is required");
            }
            if (!isPlainRecord(body.runtimeConfig)) {
              return errorResponse(400, "invalid-runtime-configuration", "Runtime configuration must be a JSON object");
            }
            if (!options.pluginManager) {
              return errorResponse(503, "plugin-manager-unavailable", "Plugin management is unavailable");
            }
            const pluginId = body.pluginId.trim();
            const capabilityId = body.capabilityId.trim();
            const installed = await options.pluginManager.list();
            const plugin = installed.find((candidate) => candidate.pluginId === pluginId);
            if (!plugin) return errorResponse(400, "plugin-not-installed", `Plugin ${pluginId} is not installed`);
            if (plugin.status !== "active") {
              return errorResponse(
                409,
                "plugin-not-active",
                `Plugin ${pluginId} is not active (status: ${plugin.status})${plugin.error ? `: ${plugin.error}` : ""}`,
              );
            }
            const capability = plugin.manifest.capabilities.find(
              (candidate) => candidate.id === capabilityId && candidate.type === "runtime",
            );
            if (!capability || capability.type !== "runtime") {
              return errorResponse(
                400,
                "runtime-capability-not-found",
                `Plugin ${pluginId} has no Runtime capability ${capabilityId}`,
              );
            }
            let runtimeConfig: Record<string, unknown>;
            try {
              runtimeConfig = validatePluginConfiguration(
                capability.configurationSchema,
                body.runtimeConfig,
                `Agent Binding ${bindingId} Runtime configuration`,
              );
            } catch (error) {
              return errorResponse(
                400,
                "invalid-runtime-configuration",
                error instanceof Error ? error.message : String(error),
              );
            }
            const existing = options.config.agents[bindingId];
            if (body.createOnly && existing) {
              return errorResponse(409, "binding-already-exists", `Agent Binding ${bindingId} already exists`);
            }
            if (
              existing &&
              (runtimes.has(bindingId) || (await options.stateStore.getActivationUserId(bindingId)) !== null)
            ) {
              return errorResponse(
                409,
                "binding-provider-active",
                "An activated Agent Binding cannot change Runtime provider or configuration while it remains activated",
              );
            }
            const candidate = createAgentBinding({
              pluginId,
              capabilityId,
              configuration: runtimeConfig,
            });
            if (!options.runtimeAdapters.hasProvider(candidate)) {
              return errorResponse(
                409,
                "runtime-capability-inactive",
                `Runtime Plugin capability ${pluginId}/${capabilityId} is not active`,
              );
            }
            return await idempotentCommand(
              options.stateStore,
              body.requestId,
              "binding.provider.upsert",
              bindingId,
              async () => {
                candidate.displayName =
                  body.displayName === undefined
                    ? existing?.displayName
                    : requireDisplayName(body.displayName);
                if (existing?.outputVisibility) candidate.outputVisibility = existing.outputVisibility;
                options.config.agents[bindingId] = candidate;
                if (!options.config.defaultAgent) options.config.defaultAgent = bindingId;
                await saveConfig(options.config, options.configPath);
                catalog.invalidate();
                return {
                  status: 200,
                  body: {
                    bindingId,
                    displayName: candidate.displayName || bindingId,
                    clawChatUserId: null,
                    runtimeKind: capability.family,
                    outputVisibility: bindingOutputVisibility(options.config, bindingId),
                    model: null,
                    modelReasoningEffort: null,
                    modelOptions: [],
                    runtimePluginId: pluginId,
                    runtimeCapabilityId: capabilityId,
                    runtimeConfiguration: structuredClone(runtimeConfig),
                    modeOptions: [...options.runtimeAdapters.modesFor(candidate)],
                  },
                };
              },
            );
          }
          const preferenceMatch = url.pathname.match(/^\/client\/v1\/bindings\/([^/]+)\/preferences$/u);
          if (preferenceMatch && request.method === "PATCH") {
            const bindingId = decodeURIComponent(preferenceMatch[1] ?? "");
            const binding = options.config.agents[bindingId];
            if (!binding) return errorResponse(404, "binding-not-found", "Agent Binding was not found");
            const runtimeBinding = getAgentBinding(options.config, bindingId);
            const body = await readJsonBody<UpdateBindingPreferencesRequest>(request);
            if (!validRequestId(body.requestId))
              return errorResponse(400, "invalid-request-id", "requestId is required");
            validatePreferencePatch(body);
            return await idempotentCommand(
              options.stateStore,
              body.requestId,
              "binding.preferences.update",
              bindingId,
              async () => {
                let modelUpdate = body.model;
                let effortUpdate = body.modelReasoningEffort;
                if (body.model !== undefined || body.modelReasoningEffort !== undefined) {
                  const requestedModel =
                    body.model === undefined ? (binding.model ?? null) : body.model?.trim() || null;
                  const requestedEffort =
                    body.modelReasoningEffort === undefined
                      ? body.model === undefined
                        ? (binding.modelReasoningEffort ?? null)
                        : null
                      : body.modelReasoningEffort;
                  if (requestedModel) {
                    try {
                      const selectedModel = requireModel(
                        await options.runtimeAdapters.listModels(runtimeBinding),
                        requestedModel,
                      );
                      resolveEffort(selectedModel, requestedEffort, true);
                      if (body.model !== undefined) modelUpdate = selectedModel.id;
                    } catch (error) {
                      return commandError(400, "invalid-model", error instanceof Error ? error.message : String(error));
                    }
                  } else if (requestedEffort) {
                    try {
                      const models = await options.runtimeAdapters.listModels(runtimeBinding);
                      const defaultModel = models?.find((candidate) => candidate.isDefault) ?? models?.[0];
                      if (!defaultModel)
                        return commandError(
                          400,
                          "invalid-reasoning-effort",
                          "The Runtime Adapter does not advertise a default model",
                        );
                      resolveEffort(defaultModel, requestedEffort, true);
                    } catch (error) {
                      return commandError(
                        400,
                        "invalid-reasoning-effort",
                        error instanceof Error ? error.message : String(error),
                      );
                    }
                  } else {
                    effortUpdate = null;
                  }
                  if (body.model !== undefined && body.modelReasoningEffort === undefined) effortUpdate = null;
                }
                if (body.displayName !== undefined) binding.displayName = requireDisplayName(body.displayName);
                if (modelUpdate !== undefined) setOptionalString(binding, "model", modelUpdate);
                if (effortUpdate !== undefined) {
                  if (effortUpdate === null) delete binding.modelReasoningEffort;
                  else
                    setOptionalString(
                      binding,
                      "modelReasoningEffort",
                      effortUpdate as AgentBindingConfig["modelReasoningEffort"],
                    );
                }
                if (body.outputVisibility !== undefined) binding.outputVisibility = body.outputVisibility;
                await saveConfig(options.config, options.configPath);
                catalog.invalidate();
                return {
                  status: 200,
                  body: {
                    bindingId,
                    displayName: binding.displayName || bindingId,
                    clawChatUserId: await options.stateStore.getActivationUserId(bindingId),
                    model: binding.model ?? null,
                    modelReasoningEffort: binding.modelReasoningEffort ?? null,
                    outputVisibility: bindingOutputVisibility(options.config, bindingId),
                  },
                };
              },
            );
          }
          return errorResponse(404, "not-found", "Client Interface endpoint was not found");
        }

        if (request.method !== "GET" && request.method !== "HEAD") {
          return new Response("Method Not Allowed", { status: 405, headers: securityHeaders() });
        }
        return await staticResponse(assetsPath, url.pathname, request.method === "HEAD");
      } catch (error) {
        if (error instanceof ClientRequestError) {
          return errorResponse(error.status, error.code, error.message, error.retryable);
        }
        if (error instanceof SessionLifecycleError) {
          const status = error.code === "session-not-found" ? 404 : 409;
          return errorResponse(status, error.code, error.message);
        }
        const diagnosticRef = randomUUID();
        console.error(`[client-interface:${diagnosticRef}]`, error);
        return errorResponse(500, "internal-error", "Connect Client request failed", true, diagnosticRef);
      }
    },
  });
  try {
    const warming = await Promise.allSettled([
      catalog.reconcileLifecycle(),
      submissionStaging.cleanupExpired(),
      options.stateStore.deleteExpiredClientCommands(),
    ]);
    const failure = warming.find((result): result is PromiseRejectedResult => result.status === "rejected");
    if (failure) throw failure.reason;
    await publishClientViews();
    ready = true;
  } catch (error) {
    await server.stop(true);
    throw error;
  }
  return {
    origin,
    async stop() {
      await server.stop(true);
    },
  };
}
function runtimeFamilyForClient(
  binding: AgentBindingConfig,
  runtimeAdapters: RuntimeAdapterRegistry,
  installed: readonly InstalledPluginLockEntry[],
): string {
  if (runtimeAdapters.hasProvider(binding)) return runtimeAdapters.familyFor(binding);
  const plugin = installed.find((candidate) => candidate.pluginId === binding.runtime.pluginId);
  const capability = plugin?.manifest.capabilities.find(
    (candidate) => candidate.id === binding.runtime.capabilityId && candidate.type === "runtime",
  );
  return capability?.type === "runtime" ? capability.family : "unavailable";
}


function pluginAdministrationView(
  config: ConnectConfig,
  installedEntries: InstalledPluginLockEntry[],
  updates: Record<string, PluginUpdateCheck>,
  official: OfficialPluginDiscovery,
): PluginAdministrationView {
  const installed = installedEntries.map((entry): InstalledPluginView => {
    const dependentBindings = Object.entries(config.agents)
      .filter(([, binding]) => binding.runtime.pluginId === entry.pluginId)
      .map(([bindingId, binding]) => ({
        bindingId,
        displayName: binding.displayName || bindingId,
        capabilityId: binding.runtime.capabilityId,
      }))
      .sort((left, right) => left.bindingId.localeCompare(right.bindingId));
    const update = updates[entry.pluginId] ?? {
      status: "check-failed" as const,
      version: null,
      integrity: null,
      diagnostic: "Update availability was not checked",
    };
    const diagnostics: PluginDiagnosticView[] = [];
    if (entry.error) diagnostics.push(pluginDiagnostic(entry.error, "activation"));
    if (update.status === "check-failed") diagnostics.push({ stage: "update", message: update.diagnostic });
    return {
      kind: "installed",
      pluginId: entry.pluginId,
      name: entry.pluginId,
      source: structuredClone(entry.source),
      version: entry.version,
      target: entry.target,
      integrity: entry.integrity,
      status: entry.status,
      dependentBindings,
      updateAvailability: update,
      retainedVersions: entry.retainedVersions.map((retained) => ({
        source: structuredClone(retained.source),
        version: retained.version,
        target: retained.target,
        integrity: retained.integrity,
      })),
      installationConfigurationSchema: structuredClone(entry.manifest.installationConfigurationSchema),
      installationConfiguration: structuredClone(entry.installationConfiguration),
      capabilities: entry.manifest.capabilities.map(
        (capability): PluginCapabilityView => ({
          id: capability.id,
          type: capability.type,
          family: capability.type === "runtime" ? capability.family : null,
          configurationSchema: structuredClone(capability.configurationSchema),
          instances:
            capability.type === "runtime"
              ? Object.entries(config.agents)
                  .filter(
                    ([, binding]) =>
                      binding.runtime.pluginId === entry.pluginId &&
                      binding.runtime.capabilityId === capability.id,
                  )
                  .map(([bindingId, binding]) => ({
                    instanceId: bindingId,
                    bindingId,
                    displayName: binding.displayName || bindingId,
                    configuration: structuredClone(binding.runtimeConfig),
                  }))
              : [
                  {
                    instanceId: capability.id,
                    bindingId: null,
                    displayName: capability.id,
                    configuration: structuredClone(entry.exposureConfigurations[capability.id] ?? {}),
                  },
                ],
        }),
      ),
      diagnostics,
    };
  });
  return {
    installed,
    available: official.candidates.map((candidate) => ({
      kind: "available",
      pluginId: candidate.pluginId,
      name: candidate.name,
      sourceReference: candidate.source,
      source: candidate.resolvedSource ? structuredClone(candidate.resolvedSource) : null,
      version: candidate.version,
      target: candidate.target,
      integrity: candidate.integrity,
      status: candidate.version && candidate.integrity ? "available" : "unavailable",
      dependentBindings: [],
      updateAvailability: {
        status: "not-installed",
        version: candidate.version,
        integrity: candidate.integrity,
        diagnostic: null,
      },
      installationConfigurationSchema: candidate.manifest
        ? structuredClone(candidate.manifest.installationConfigurationSchema)
        : null,
      installationConfiguration: structuredClone(candidate.installationConfiguration),
      capabilities:
        candidate.manifest?.capabilities.map(
          (capability): PluginCapabilityView => ({
            id: capability.id,
            type: capability.type,
            family: capability.type === "runtime" ? capability.family : null,
            configurationSchema: structuredClone(capability.configurationSchema),
            instances:
              capability.type === "exposure"
                ? [
                    {
                      instanceId: capability.id,
                      bindingId: null,
                      displayName: capability.id,
                      configuration: isPlainRecord(candidate.exposureConfigurations[capability.id])
                        ? structuredClone(candidate.exposureConfigurations[capability.id] as Record<string, unknown>)
                        : {},
                    },
                  ]
                : [],
          }),
        ) ?? [],
      detected: candidate.detected,
      compatible: candidate.compatible,
      selected: candidate.selected,
      diagnostics: candidate.diagnostic ? [pluginDiagnostic(candidate.diagnostic, "probe")] : [],
    })),
    catalogOrigin: official.catalogOrigin,
    diagnostics: official.diagnostics.map((message) => pluginDiagnostic(message, "probe")),
  };
}

function pluginDiagnostic(message: string, fallback: PluginDiagnosticStage): PluginDiagnosticView {
  const normalized = message.toLowerCase();
  const stage: PluginDiagnosticStage = normalized.includes("probe")
    ? "probe"
    : normalized.includes("provider") || normalized.includes("register")
      ? "provider"
      : normalized.includes("import") || normalized.includes("export") || normalized.includes("entry artifact")
        ? "import"
        : normalized.includes("schema") ||
            normalized.includes("validation") ||
            normalized.includes("malformed") ||
            normalized.includes("integrity")
          ? "validation"
          : fallback;
  return { stage, message };
}

async function readPluginUploadFormData(request: Request): Promise<FormData> {
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  const reader = request.body?.getReader();
  if (reader) {
    try {
      while (true) {
        request.signal.throwIfAborted();
        const chunk = await reader.read();
        if (chunk.done) break;
        totalBytes += chunk.value.byteLength;
        if (totalBytes > MAX_PLUGIN_UPLOAD_BODY_BYTES) {
          try {
            await reader.cancel();
          } catch {
            // The size limit determines this response even when the incoming stream cannot be cancelled cleanly.
          }
          throw new ClientRequestError(
            413,
            "plugin-upload-too-large",
            `Plugin Bundle exceeds the ${MAX_PLUGIN_BUNDLE_BYTES} byte upload limit`,
          );
        }
        chunks.push(chunk.value);
      }
    } finally {
      reader.releaseLock();
    }
  }
  request.signal.throwIfAborted();

  const boundedBody = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    boundedBody.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return await new Request(request.url, {
    method: request.method,
    headers: request.headers,
    body: boundedBody,
    signal: request.signal,
  }).formData();
}

function parsePluginFormConfiguration(value: FormDataEntryValue | null, label: string): Record<string, unknown> {
  if (value === null || value === "") return {};
  if (typeof value !== "string") throw new Error(`${label} must be a JSON object`);
  let parsed: unknown;
  try {
    parsed = JSON.parse(value) as unknown;
  } catch (error) {
    throw new Error(`${label} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!isPlainRecord(parsed)) throw new Error(`${label} must be a JSON object`);
  return parsed;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

async function requireActiveOwnerBinding(options: ClientInterfaceOptions, bindingId: string): Promise<void> {
  if (!options.config.agents[bindingId]) {
    throw new ClientRequestError(404, "binding-not-found", "Agent Binding was not found");
  }
  const [ownerUserId, activation] = await Promise.all([
    options.stateStore.getInstallationOwner(),
    options.stateStore.getActivation(bindingId),
  ]);
  if (!activation) {
    throw new ClientRequestError(
      409,
      "binding-not-active",
      `Agent Binding ${bindingId} is not activated for this installation`,
    );
  }
  if (!ownerUserId || activation.ownerUserId !== ownerUserId) {
    throw new ClientRequestError(
      409,
      "binding-owner-mismatch",
      `Agent Binding ${bindingId} does not belong to the current Installation Owner`,
    );
  }
}

function isPluginAdministrationPath(pathname: string): boolean {
  return (
    pathname === `${CLIENT_API_PREFIX}/plugins` ||
    pathname.startsWith(`${CLIENT_API_PREFIX}/plugins/`) ||
    /^\/client\/v1\/bindings\/[^/]+\/provider$/u.test(pathname)
  );
}

function isLoopbackAddress(address: string | undefined): boolean {
  if (!address) return false;
  const normalized = address.toLowerCase();
  if (normalized === "::1" || normalized === "0:0:0:0:0:0:0:1") return true;
  const ipv4 = normalized.startsWith("::ffff:") ? normalized.slice(7) : normalized;
  const octets = ipv4.split(".");
  return (
    octets.length === 4 &&
    octets[0] === "127" &&
    octets.every((octet) => /^\d{1,3}$/u.test(octet) && Number(octet) <= 255)
  );
}

function allowedRequestOrigin(request: Request, listeningHost: string, port: number): string | null {
  const authority = request.headers.get("host");
  if (!authority) return null;
  if (listeningHost !== "0.0.0.0") {
    return authority === `${listeningHost}:${port}` ? `http://${authority}` : null;
  }
  const match = authority.match(/^(\d{1,3}(?:\.\d{1,3}){3}):(\d{1,5})$/u);
  if (!match || Number(match[2]) !== port) return null;
  const address = match[1] ?? "";
  if (!address.split(".").every((part) => Number(part) >= 0 && Number(part) <= 255)) return null;
  return `http://${authority}`;
}

async function validateMutationRequest(
  request: Request,
  origin: string,
  stateStore: ConnectStateStore,
  bindingScope: string | null,
): Promise<Response | null> {
  const requestOrigin = request.headers.get("origin");
  if (requestOrigin !== origin && !(await isRegisteredLivewareOrigin(requestOrigin, stateStore, bindingScope))) {
    return errorResponse(403, "invalid-origin", "Invalid request Origin");
  }
  const fetchSite = request.headers.get("sec-fetch-site");
  if (fetchSite && fetchSite !== "same-origin" && fetchSite !== "none") {
    return errorResponse(403, "cross-site-request", "Cross-site request was rejected");
  }
  return null;
}

async function isRegisteredLivewareOrigin(
  requestOrigin: string | null,
  stateStore: ConnectStateStore,
  bindingScope: string | null,
): Promise<boolean> {
  if (!requestOrigin) return false;
  try {
    const origin = new URL(requestOrigin).origin;
    const exposures = bindingScope
      ? [await stateStore.getLivewareExposure(bindingScope)].filter((exposure) => exposure !== null)
      : await stateStore.listLivewareExposures();
    return exposures.some((exposure) => origin === new URL(exposure.publicUrl).origin);
  } catch {
    return false;
  }
}

function clientViewPublisher(store: ConnectStateStore, catalog: SessionCatalog): () => Promise<void> {
  let catalogFingerprint: string | null = null;
  const sessionFingerprints = new Map<string, string>();
  let publishing: Promise<void> | null = null;
  let lastRevision = Date.now();
  const nextRevision = (floor: number) => {
    lastRevision = Math.max(Date.now(), lastRevision + 1, floor + 1);
    return lastRevision;
  };
  return async () => {
    if (publishing) return await publishing;
    publishing = (async () => {
      const catalogView = await catalog.view();
      const nextCatalogFingerprint = viewFingerprint(catalogView);
      if (catalogFingerprint !== null && nextCatalogFingerprint !== catalogFingerprint) {
        const revision = nextRevision(catalogView.revision);
        await store.appendClientViewEvent({
          type: "catalog.changed",
          cursor: 0,
          revision,
          catalog: { ...catalogView, revision },
        });
      }
      catalogFingerprint = nextCatalogFingerprint;
      const sessionRefs = new Set(
        catalogView.bindings.flatMap((binding) => binding.entries.map((entry) => entry.sessionRef)),
      );
      for (const sessionRef of sessionRefs) {
        const view = await catalog.sessionView(sessionRef);
        if (!view) continue;
        const fingerprint = viewFingerprint(view);
        const previous = sessionFingerprints.get(sessionRef);
        if (previous !== undefined && previous !== fingerprint) {
          const revision = nextRevision(view.revision);
          await store.appendClientViewEvent({
            type: "session.changed",
            cursor: 0,
            sessionRef,
            revision,
            session: { ...view, revision },
          });
        }
        sessionFingerprints.set(sessionRef, fingerprint);
      }
      for (const sessionRef of sessionFingerprints.keys()) {
        if (!sessionRefs.has(sessionRef)) sessionFingerprints.delete(sessionRef);
      }
    })().finally(() => {
      publishing = null;
    });
    await publishing;
  };
}

function viewFingerprint(view: { revision: number }): string {
  return JSON.stringify({ ...view, revision: 0 });
}

function scopeSessionCatalog(view: SessionCatalogView, bindingScope: string | null): SessionCatalogView {
  return bindingScope
    ? { ...view, bindings: view.bindings.filter((binding) => binding.bindingId === bindingScope) }
    : view;
}

function eventStreamResponse(
  store: ConnectStateStore,
  request: Request,
  afterCursor: number,
  publishClientViews: () => Promise<void>,
  bindingScope: string | null,
  catalog: SessionCatalog,
): Response {
  const encoder = new TextEncoder();
  let cursor = afterCursor;
  let visibleCursor = afterCursor;
  let pumping = false;
  let closed = false;
  let poll: ReturnType<typeof setInterval> | null = null;
  let heartbeat: ReturnType<typeof setInterval> | null = null;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const stop = () => {
        if (closed) return;
        closed = true;
        if (poll) clearInterval(poll);
        if (heartbeat) clearInterval(heartbeat);
        try {
          controller.close();
        } catch {
          // The browser already closed the stream.
        }
      };
      const pump = async () => {
        if (closed || pumping) return;
        pumping = true;
        try {
          await publishClientViews();
          const events = await store.listClientEvents(cursor);
          for (const stored of events) {
            if (closed) return;
            cursor = stored.cursor;
            const event = await scopeClientEvent(stored.event, bindingScope, catalog);
            if (!event) continue;
            const scopedEvent = { ...event, previousCursor: visibleCursor } as ClientViewEvent;
            visibleCursor = scopedEvent.cursor;
            controller.enqueue(
              encoder.encode(
                `id: ${stored.cursor}\nevent: ${scopedEvent.type}\ndata: ${JSON.stringify(scopedEvent)}\n\n`,
              ),
            );
            if ((controller.desiredSize ?? 1) < -64) {
              stop();
              return;
            }
          }
        } catch {
          stop();
        } finally {
          pumping = false;
        }
      };
      request.signal.addEventListener("abort", stop, { once: true });
      controller.enqueue(encoder.encode(": connected\n\n"));
      void pump();
      poll = setInterval(() => void pump(), 300);
      heartbeat = setInterval(() => {
        if (!closed) controller.enqueue(encoder.encode(": heartbeat\n\n"));
      }, 15_000);
    },
    cancel() {
      closed = true;
      if (poll) clearInterval(poll);
      if (heartbeat) clearInterval(heartbeat);
    },
  });
  const headers = securityHeaders();
  headers.set("Content-Type", "text/event-stream; charset=utf-8");
  headers.set("Cache-Control", "no-cache, no-transform");
  headers.set("Connection", "keep-alive");
  return new Response(stream, { headers });
}

async function scopedClientEvents(
  events: ClientViewEvent[],
  bindingScope: string | null,
  catalog: SessionCatalog,
  afterCursor: number,
): Promise<ClientViewEvent[]> {
  const visible: ClientViewEvent[] = [];
  let previousCursor = afterCursor;
  for (const event of events) {
    const scoped = await scopeClientEvent(event, bindingScope, catalog);
    if (!scoped) continue;
    const continuous = { ...scoped, previousCursor } as ClientViewEvent;
    visible.push(continuous);
    previousCursor = continuous.cursor;
  }
  return visible;
}

async function scopeClientEvent(
  event: ClientViewEvent,
  bindingScope: string | null,
  catalog: SessionCatalog,
): Promise<ClientViewEvent | null> {
  if (!bindingScope || event.type === "snapshot-required") return event;
  if (event.type === "catalog.changed") {
    return { ...event, catalog: scopeSessionCatalog(event.catalog, bindingScope) };
  }
  if (event.type === "session.changed") {
    return event.session.bindingId === bindingScope ? event : null;
  }
  const entry = await catalog.entry(event.sessionRef);
  return entry?.bindingId === bindingScope ? event : null;
}

async function idempotentCommand(
  store: ConnectStateStore,
  requestId: string,
  commandKind: string,
  entityRef: string,
  execute: () => Promise<{ status: number; body: unknown }>,
  options: { preserveClaimOnError?: boolean } = {},
): Promise<Response> {
  const claim = await store.claimClientCommand(requestId, commandKind, entityRef);
  if (claim.state === "conflict")
    return errorResponse(409, "request-id-conflict", "requestId was used by another command");
  if (claim.state === "pending")
    return errorResponse(409, "command-in-progress", "This command is already in progress", true);
  if (claim.state === "complete") return jsonResponse(claim.responseBody, claim.responseStatus);
  try {
    const result = await execute();
    await store.completeClientCommand(requestId, result.status, result.body);
    return jsonResponse(result.body, result.status);
  } catch (error) {
    if (!options.preserveClaimOnError) await store.abandonClientCommand(requestId).catch(() => undefined);
    throw error;
  }
}

function isProjectDirectoryRequest(value: unknown): value is ProjectDirectoryRequest {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return (
    (record.kind === "existing-directory" && typeof record.rootPath === "string") ||
    (record.kind === "new-directory" && typeof record.parentPath === "string" && typeof record.name === "string")
  );
}

function isSessionWorkspaceRequest(value: unknown): value is CreateSessionRequest["workspace"] {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return (
    record.kind === "none" ||
    (record.kind === "existing" && typeof record.workspaceId === "string" && Boolean(record.workspaceId.trim())) ||
    (record.kind === "new-project" && isProjectDirectoryRequest(record.directory))
  );
}

function hostDirectoryErrorResponse(error: unknown): Response {
  const result = hostDirectoryCommandError(error, "host-directory-unavailable");
  return errorResponse(result.status, result.body.error.code, result.body.error.message, result.body.error.retryable);
}

function hostDirectoryCommandError(error: unknown, fallbackCode: string) {
  if (!(error instanceof HostDirectoryError))
    return commandError(409, fallbackCode, error instanceof Error ? error.message : String(error));
  const status =
    error.code === "directory-not-found"
      ? 404
      : error.code === "directory-already-exists"
        ? 409
        : error.code === "directory-unavailable"
          ? 403
          : 400;
  return commandError(status, error.code, error.message);
}

async function rollbackInlineProject(
  projects: ProjectCatalog,
  createdProjectId: string | null,
  materialized: MaterializedProjectDirectory | null,
  preserveMaterializedDirectory: boolean,
): Promise<void> {
  if (!materialized || preserveMaterializedDirectory) return;
  if (!createdProjectId) {
    await materialized.rollback();
    return;
  }
  const removed = await projects.remove(createdProjectId).catch(() => null);
  if (removed?.removed) await materialized.rollback();
}

async function turnSubmissionDigest(draft: TurnSubmissionDraft): Promise<string> {
  const hash = createHash("sha256");
  hash.update(draft.sessionRef);
  hash.update("\0");
  hash.update(draft.prompt);
  if (draft.selection) {
    hash.update(`\0${draft.selection.kind}\0`);
    hash.update(draft.selection.id);
    hash.update("\0");
    hash.update(draft.selection.name);
  }
  for (const attachment of draft.attachments) {
    hash.update("\0");
    hash.update(attachment.name);
    hash.update("\0");
    hash.update(attachment.mime);
    hash.update("\0");
    hash.update(String(attachment.size));
    hash.update(await attachment.readBytes());
  }
  return hash.digest("hex");
}

async function sessionSkills(
  sessionRef: string,
  catalog: SessionCatalog,
  options: ClientInterfaceOptions,
  forceRefresh = false,
  existingOnly = false,
) {
  const entry = await catalog.entry(sessionRef);
  if (!entry) return undefined;
  const workspace = await catalog.workspace(sessionRef);
  if (!workspace) return undefined;
  return await options.runtimeAdapters.listSkills(getAgentBinding(options.config, entry.bindingId), workspace, {
    forceRefresh,
    existingOnly,
    runtimeThreadId: (await catalog.runtimeThreadId(sessionRef)) ?? undefined,
  });
}

async function sessionCommands(
  sessionRef: string,
  catalog: SessionCatalog,
  options: ClientInterfaceOptions,
  forceRefresh = false,
  existingOnly = false,
) {
  const entry = await catalog.entry(sessionRef);
  if (!entry) return undefined;
  const workspace = await catalog.workspace(sessionRef);
  if (!workspace) return undefined;
  return await options.runtimeAdapters.listCommands(getAgentBinding(options.config, entry.bindingId), workspace, {
    forceRefresh,
    existingOnly,
    runtimeThreadId: (await catalog.runtimeThreadId(sessionRef)) ?? undefined,
  });
}
