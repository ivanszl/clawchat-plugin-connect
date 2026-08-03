import { createHash, randomUUID } from "node:crypto";
import { access, realpath, stat } from "node:fs/promises";
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { BindingRuntimeHandle } from "../binding-runtime";
import {
  type AddProjectRequest,
  type BootstrapView,
  type CancelTurnRequest,
  CLIENT_API_PREFIX,
  type ClientErrorView,
  type ClientViewEvent,
  type CreateSessionRequest,
  normalizeSessionRef,
  type SessionCatalogView,
  type SessionMutationRequest,
  type SessionView,
  type UpdateBindingPreferencesRequest,
  type UpdateSessionPreferencesRequest,
} from "../client-contract";
import { getAgentBinding, saveConfig } from "../config";
import { bindingOutputVisibility } from "../output-visibility";
import { ProjectCatalog } from "../projects";
import { MAX_RUNTIME_MEDIA_BYTES } from "../runtime/media-cache";
import { requireModel, resolveEffort } from "../runtime/model-selection";
import type { RuntimeAdapterRegistry } from "../runtime/registry";
import { releasedRuntimeAdapters } from "../runtime/released-adapters";
import { RuntimeInteractionCoordinator, RuntimeInteractionError } from "../runtime/runtime-interaction-coordinator";
import type { RuntimeSessionOption, RuntimeSlashSelection } from "../runtime/types";
import { createSessionContinuity, SessionLifecycleError } from "../session-continuity";
import { leadingSkillName } from "../skill-invocation";
import type { ConnectStateStore } from "../state";
import type { AgentBindingConfig, ConnectConfig, RuntimeWorkspace } from "../types";
import { classifyWorkspaceArtifact } from "../workspace-artifact";
import { BINDING_SCOPE_HEADER } from "./binding-scoped-gateway";
import { SessionCatalog } from "./session-catalog";
import type { TranscriptProjection } from "./transcript-projection";
import { TurnSubmission, type TurnSubmissionDraft, TurnSubmissionError } from "./turn-submission";
import { FileTurnSubmissionStaging } from "./turn-submission-staging";

const MAX_JSON_BODY_BYTES = 128 * 1_024;
const OUTPUT_VISIBILITIES = new Set(["minimal", "normal", "full"]);

class ClientRequestError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly retryable = false,
  ) {
    super(message);
  }
}

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
  runtimes: BindingRuntimeHandle[];
  assetsPath?: string;
  hostname?: string;
  port?: number;
  serverFactory?: ClientHttpServerFactory;
}

export interface ClientHttpServerOptions {
  hostname: string;
  port: number;
  idleTimeout: number;
  fetch(request: Request): Response | Promise<Response>;
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
  const sessionContinuity = createSessionContinuity({ stateStore: options.stateStore });
  const runtimes = new Map(options.runtimes.map((runtime) => [runtime.agentId, runtime]));
  const catalog = new SessionCatalog({
    ...options,
    projects,
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
    fetch: async (request) => {
      try {
        const requestOrigin = allowedRequestOrigin(request, hostname, port);
        if (!requestOrigin) return errorResponse(400, "invalid-host", "Invalid Host header");
        const url = new URL(request.url);
        const bindingScope = request.headers.get(BINDING_SCOPE_HEADER)?.trim() || null;
        if (bindingScope && !options.config.agents[bindingScope]) {
          return errorResponse(404, "binding-not-found", "Agent Binding was not found");
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
          if (url.pathname === `${CLIENT_API_PREFIX}/bootstrap` && request.method === "GET") {
            const view: BootstrapView = {
              apiVersion: 1,
              eventCursor: await options.stateStore.getClientEventCursor(),
              outputVisibility: bindingScope
                ? bindingOutputVisibility(options.config, bindingScope)
                : options.config.outputVisibility,
              runtimeAdapters: releasedRuntimeAdapters().map((adapter) => ({
                ...adapter,
                profiles: adapter.profiles.map((profile) => ({ ...profile })),
              })),
              bindings: await Promise.all(
                Object.entries(options.config.agents)
                  .filter(([bindingId]) => requestScope.includesBinding(bindingId))
                  .map(async ([bindingId, binding]) => ({
                    bindingId,
                    displayName: binding.displayName || bindingId,
                    clawChatUserId: await options.stateStore.getActivationUserId(bindingId),
                    runtimeKind: binding.kind,
                    runtimeProfile: binding.kind === "workbuddy" ? binding.profile : null,
                    outputVisibility: bindingOutputVisibility(options.config, bindingId),
                    model: binding.model ?? null,
                    modelReasoningEffort: binding.modelReasoningEffort ?? null,
                    modelOptions:
                      (await options.runtimeAdapters.listModels(getAgentBinding(options.config, bindingId))) ?? [],
                    modeOptions: [...options.runtimeAdapters.modesFor(getAgentBinding(options.config, bindingId))],
                  })),
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
            if ("name" in body) return errorResponse(400, "invalid-project", "Project names are derived from rootPath");
            if (typeof body.rootPath !== "string")
              return errorResponse(400, "invalid-project", "Project rootPath is required");
            if (
              !Array.isArray(body.additionalDirectories) ||
              !body.additionalDirectories.every((path) => typeof path === "string")
            )
              return errorResponse(400, "invalid-project", "additionalDirectories must be an array of paths");
            return await idempotentCommand(
              options.stateStore,
              body.requestId,
              "project.add",
              body.rootPath,
              async () => {
                try {
                  const project = await projects.add(body.rootPath, body.additionalDirectories);
                  catalog.invalidate();
                  return {
                    status: 201,
                    body: { ...project, workspaceId: projects.workspaceId(project) },
                  };
                } catch (error) {
                  return commandError(409, "project-conflict", error instanceof Error ? error.message : String(error));
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
            if (body.workspaceId !== null && typeof body.workspaceId !== "string")
              return errorResponse(400, "invalid-workspace", "workspaceId must be a string or null");
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
                const workspaceProject = body.workspaceId ? await projects.get(body.workspaceId) : null;
                if (body.workspaceId && !workspaceProject)
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
                const workspace = workspaceProject
                  ? await projects.resolveProjectWorkspace(workspaceProject.projectId)
                  : {
                      projectId: null,
                      workingDirectory: projects.workspaceRoot,
                      additionalDirectories: [],
                      skipGitRepoCheck: true,
                    };
                const validatedOptions = await validatedSessionOptions(
                  options.runtimeAdapters,
                  binding,
                  workspace,
                  body.sessionOptions ?? {},
                );
                if (!validatedOptions.ok) return validatedOptions.error;
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
            const roots = await Promise.all(
              [workspace.workingDirectory, ...workspace.additionalDirectories].map(
                async (root) => await realpath(root).catch(() => null),
              ),
            );
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

async function staticResponse(assetsRoot: string, pathname: string, head: boolean): Promise<Response> {
  const decoded = decodeURIComponent(pathname);
  const requested = decoded === "/" ? "index.html" : decoded.replace(/^\//u, "");
  const assetRequest = requested.startsWith("assets/") || isKnownStaticFile(requested);
  const path = assetRequest ? resolve(assetsRoot, requested) : resolve(assetsRoot, "index.html");
  if (!path.startsWith(`${resolve(assetsRoot)}${sep}`)) return new Response("Not Found", { status: 404 });
  const file = Bun.file(path);
  if (!(await file.exists())) {
    if (assetRequest) return new Response("Not Found", { status: 404, headers: securityHeaders() });
    return new Response("Connect Client has not been built. Run `bun run build:web`.", {
      status: 503,
      headers: securityHeaders({ "Content-Type": "text/plain; charset=utf-8" }),
    });
  }
  const headers = securityHeaders({
    "Content-Type": contentType(path),
    "Cache-Control": requested === "index.html" || !assetRequest ? "no-cache" : "public, max-age=31536000, immutable",
  });
  return new Response(head ? null : file, { headers });
}

async function resolveClientAssetsPath(): Promise<string> {
  const entry = process.argv[1] ? resolve(process.argv[1]) : "";
  const candidates = [
    entry ? resolve(dirname(entry), "../client") : "",
    entry ? resolve(dirname(entry), "clawchat-connect-client") : "",
    resolve(dirname(process.execPath), "clawchat-connect-client"),
    resolve(dirname(process.execPath), "client"),
    resolve(process.cwd(), "dist/client"),
  ].filter(Boolean);
  for (const candidate of candidates) {
    try {
      await access(join(candidate, "index.html"));
      return candidate;
    } catch {
      // Try the next production layout.
    }
  }
  return candidates[0] ?? resolve(process.cwd(), "dist/client");
}

async function readJsonBody<T>(request: Request): Promise<T> {
  const length = Number(request.headers.get("content-length") ?? 0);
  if (length > MAX_JSON_BODY_BYTES) throw new ClientRequestError(413, "body-too-large", "Request body is too large");
  const text = await request.text();
  if (text.length > MAX_JSON_BODY_BYTES)
    throw new ClientRequestError(413, "body-too-large", "Request body is too large");
  try {
    return JSON.parse(text || "{}") as T;
  } catch {
    throw new ClientRequestError(400, "invalid-json", "Request body must be valid JSON");
  }
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

function commandError(status: number, code: string, message: string, retryable = false) {
  return { status, body: clientErrorView(code, message, retryable) };
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

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: securityHeaders({ "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" }),
  });
}

function isPathWithin(root: string, candidate: string): boolean {
  const nestedPath = relative(root, candidate);
  return nestedPath === "" || (!nestedPath.startsWith(`..${sep}`) && nestedPath !== ".." && !isAbsolute(nestedPath));
}

function snapshotResponse(value: unknown, watermark: number): Response {
  const response = jsonResponse(value);
  response.headers.set("X-Client-View-Watermark", String(watermark));
  return response;
}

function errorResponse(
  status: number,
  code: string,
  message: string,
  retryable = false,
  diagnosticRef?: string,
): Response {
  const body = clientErrorView(code, message, retryable, diagnosticRef);
  return jsonResponse(body, status);
}

function clientErrorView(code: string, message: string, retryable = false, diagnosticRef?: string): ClientErrorView {
  return { error: { code, message, retryable, ...(diagnosticRef ? { diagnosticRef } : {}) } };
}

function securityHeaders(initial: Record<string, string> = {}): Headers {
  return new Headers({
    "Content-Security-Policy":
      "default-src 'self'; script-src 'self'; script-src-attr 'none'; style-src 'self'; style-src-elem 'self'; style-src-attr 'unsafe-inline'; font-src 'self'; img-src 'self' data: blob: https:; connect-src 'self'; worker-src 'none'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff",
    "Cross-Origin-Opener-Policy": "same-origin",
    "Cross-Origin-Resource-Policy": "same-origin",
    ...initial,
  });
}

function workspaceArtifactHeaders(initial: Record<string, string>): Headers {
  return securityHeaders({
    "Content-Security-Policy":
      "default-src 'none'; script-src 'none'; script-src-attr 'none'; style-src 'none'; img-src 'self' data:; connect-src 'none'; worker-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'self'",
    ...initial,
  });
}

function eventCursor(request: Request, url: URL): number {
  const value = request.headers.get("last-event-id") || url.searchParams.get("after") || "0";
  const cursor = Number(value);
  return Number.isSafeInteger(cursor) && cursor >= 0 ? cursor : 0;
}

function parseBeforeCursor(value: string | null): number | null {
  if (!value) return null;
  if (!/^s:\d+$/u.test(value)) throw new Error("invalid transcript cursor");
  const sequence = Number(value.slice(2));
  if (!Number.isSafeInteger(sequence) || sequence < 1) throw new Error("invalid transcript cursor");
  return sequence;
}

function parseLimit(value: string | null): number {
  const parsed = Number(value ?? 100);
  return Number.isFinite(parsed) ? Math.max(1, Math.min(200, Math.trunc(parsed))) : 100;
}

function validRequestId(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9_-]{8,100}$/u.test(value);
}

function isStringRecord(value: unknown): value is Record<string, string> | undefined {
  return (
    value === undefined ||
    (Boolean(value) &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      Object.values(value as Record<string, unknown>).every((item) => typeof item === "string"))
  );
}

function validateSessionOptions(
  selected: Record<string, string>,
  definitions: RuntimeSessionOption[],
  requireInPlace = false,
): Record<string, string> {
  const byId = new Map(definitions.map((definition) => [definition.id, definition]));
  for (const [id, value] of Object.entries(selected)) {
    const definition = byId.get(id);
    if (!definition) throw new Error(`Session option is not available: ${id}`);
    if (requireInPlace && definition.changePolicy !== "in-place")
      throw new Error(`Session option requires a new Runtime Session: ${id}`);
    if (!definition.values.some((candidate) => candidate.id === value))
      throw new Error(`Session option value is not available: ${id}=${value}`);
  }
  return { ...selected };
}

async function validatedSessionOptions(
  runtimeAdapters: RuntimeAdapterRegistry,
  binding: AgentBindingConfig,
  workspace: RuntimeWorkspace,
  selected: Record<string, string>,
  requireInPlace = false,
  scope?: import("../runtime/types").RuntimeCatalogScope,
): Promise<{ ok: true; value: Record<string, string> } | { ok: false; error: ReturnType<typeof commandError> }> {
  try {
    return {
      ok: true,
      value: validateSessionOptions(
        selected,
        await runtimeAdapters.listSessionOptions(binding, workspace, { ...scope, workspace }),
        requireInPlace,
      ),
    };
  } catch (error) {
    return {
      ok: false,
      error: commandError(400, "invalid-session-options", error instanceof Error ? error.message : String(error)),
    };
  }
}

function requireDisplayName(value: unknown): string {
  if (typeof value !== "string" || !value.trim() || value.trim().length > 80) {
    throw new ClientRequestError(400, "invalid-display-name", "displayName must contain 1 to 80 characters");
  }
  return value.trim();
}

function validatePreferencePatch(body: UpdateBindingPreferencesRequest): void {
  if (body.displayName !== undefined) requireDisplayName(body.displayName);
  if (body.model !== undefined && body.model !== null) {
    if (typeof body.model !== "string" || body.model.trim().length > 200) {
      throw new ClientRequestError(400, "invalid-model", "model must be null or contain at most 200 characters");
    }
  }
  if (body.modelReasoningEffort !== undefined && body.modelReasoningEffort !== null) {
    if (typeof body.modelReasoningEffort !== "string" || body.modelReasoningEffort.trim().length > 100) {
      throw new ClientRequestError(
        400,
        "invalid-reasoning-effort",
        "modelReasoningEffort must be null or contain at most 100 characters",
      );
    }
  }
  if (body.outputVisibility !== undefined && !OUTPUT_VISIBILITIES.has(body.outputVisibility)) {
    throw new ClientRequestError(400, "invalid-output-visibility", "outputVisibility is invalid");
  }
}

function setOptionalString<T extends object, K extends keyof T>(target: T, key: K, value: T[K] | null): void {
  if (value === null || (typeof value === "string" && !value.trim())) delete target[key];
  else target[key] = (typeof value === "string" ? value.trim() : value) as T[K];
}

function isMutation(method: string): boolean {
  return method !== "GET" && method !== "HEAD" && method !== "OPTIONS";
}

function isKnownStaticFile(path: string): boolean {
  return /^(?:favicon\.ico|manifest\.webmanifest|robots\.txt)$/u.test(path);
}

function contentType(path: string): string {
  const types: Record<string, string> = {
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".woff2": "font/woff2",
    ".webmanifest": "application/manifest+json",
  };
  return types[extname(path).toLowerCase()] ?? "application/octet-stream";
}
