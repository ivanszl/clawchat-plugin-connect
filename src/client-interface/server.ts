import { randomUUID } from "node:crypto";
import { access } from "node:fs/promises";
import { dirname, extname, join, resolve, sep } from "node:path";
import type { BindingRuntimeHandle } from "../binding-runtime";
import {
  type AddProjectRequest,
  type BootstrapView,
  type CancelTurnRequest,
  CLIENT_API_PREFIX,
  type ClientErrorView,
  type CreateSessionRequest,
  normalizeSessionRef,
  type SessionMutationRequest,
  type SessionView,
  type StartTurnRequest,
  type UpdateBindingPreferencesRequest,
  type UpdateSessionPreferencesRequest,
} from "../client-contract";
import { saveConfig } from "../config";
import { ProjectCatalog } from "../projects";
import { requireModel, resolveEffort } from "../runtime/model-selection";
import type { RuntimeAdapterRegistry } from "../runtime/registry";
import type { ConnectStateStore } from "../state";
import type { AgentBindingConfig, ConnectConfig } from "../types";
import { SessionCatalog } from "./session-catalog";
import type { TranscriptProjection } from "./transcript-projection";

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

export interface ClientInterfaceOptions {
  config: ConnectConfig;
  configPath: string;
  stateStore: ConnectStateStore;
  runtimeAdapters: RuntimeAdapterRegistry;
  transcriptProjection: TranscriptProjection;
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
  const catalog = new SessionCatalog({ ...options, projects });
  const runtimes = new Map(options.runtimes.map((runtime) => [runtime.agentId, runtime]));

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
        if (url.pathname.startsWith(CLIENT_API_PREFIX)) {
          if (isMutation(request.method)) {
            const mutationError = validateMutationRequest(request, requestOrigin);
            if (mutationError) return mutationError;
          }
          if (url.pathname === `${CLIENT_API_PREFIX}/bootstrap` && request.method === "GET") {
            const view: BootstrapView = {
              apiVersion: 1,
              eventCursor: await options.stateStore.getClientEventCursor(),
              outputVisibility: options.config.outputVisibility,
              bindings: await Promise.all(
                Object.entries(options.config.agents).map(async ([bindingId, binding]) => ({
                  bindingId,
                  displayName: binding.displayName || bindingId,
                  model: binding.model ?? null,
                  modelReasoningEffort: binding.modelReasoningEffort ?? null,
                  modelOptions: (await options.runtimeAdapters.listModels(binding)) ?? [],
                  modeOptions: [...options.runtimeAdapters.modesFor(binding)],
                })),
              ),
              capabilities: {
                localTurns: true,
                cancellation: true,
                runtimeInteractions: false,
                preferenceEditing: true,
              },
            };
            return jsonResponse(view);
          }
          if (url.pathname === `${CLIENT_API_PREFIX}/session-catalog` && request.method === "GET") {
            return jsonResponse(await catalog.view(url.searchParams.get("refresh") === "1"));
          }
          if (url.pathname === `${CLIENT_API_PREFIX}/projects` && request.method === "GET") {
            return jsonResponse(await projects.list());
          }
          if (url.pathname === `${CLIENT_API_PREFIX}/projects` && request.method === "POST") {
            const body = await readJsonBody<AddProjectRequest>(request);
            if (!validRequestId(body.requestId))
              return errorResponse(400, "invalid-request-id", "requestId is required");
            if (typeof body.name !== "string" || typeof body.rootPath !== "string")
              return errorResponse(400, "invalid-project", "Project name and rootPath are required");
            if (
              !Array.isArray(body.additionalDirectories) ||
              !body.additionalDirectories.every((path) => typeof path === "string")
            )
              return errorResponse(400, "invalid-project", "additionalDirectories must be an array of paths");
            return await idempotentCommand(options.stateStore, body.requestId, "project.add", body.name, async () => {
              try {
                const project = await projects.add(body.name, body.rootPath, body.additionalDirectories);
                catalog.invalidate();
                return { status: 201, body: project };
              } catch (error) {
                return commandError(409, "project-conflict", error instanceof Error ? error.message : String(error));
              }
            });
          }
          if (url.pathname === `${CLIENT_API_PREFIX}/sessions` && request.method === "POST") {
            const body = await readJsonBody<CreateSessionRequest>(request);
            if (!validRequestId(body.requestId))
              return errorResponse(400, "invalid-request-id", "requestId is required");
            if (typeof body.bindingId !== "string" || !body.bindingId.trim())
              return errorResponse(400, "invalid-binding", "bindingId is required");
            if (body.projectId !== null && typeof body.projectId !== "string")
              return errorResponse(400, "invalid-project", "projectId must be a string or null");
            if (body.name !== null && typeof body.name !== "string")
              return errorResponse(400, "invalid-name", "name must be a string or null");
            if (body.mode !== null && typeof body.mode !== "string")
              return errorResponse(400, "invalid-mode", "mode must be a string or null");
            if (body.model !== null && typeof body.model !== "string")
              return errorResponse(400, "invalid-model", "model must be a string or null");
            if (body.reasoningEffort !== null && typeof body.reasoningEffort !== "string")
              return errorResponse(400, "invalid-reasoning-effort", "reasoningEffort must be a string or null");
            return await idempotentCommand(
              options.stateStore,
              body.requestId,
              "session.create",
              body.bindingId,
              async () => {
                const binding = options.config.agents[body.bindingId];
                if (!binding) return commandError(404, "binding-not-found", "Agent Binding was not found");
                if (body.projectId && !(await projects.get(body.projectId)))
                  return commandError(400, "invalid-project", "Project was not found");
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
                const chatId = `__connect_client_session__:${randomUUID()}`;
                await options.stateStore.setSessionIntent({
                  chatId,
                  agentId: body.bindingId,
                  projectId: body.projectId,
                  name,
                  mode: body.mode,
                  model,
                  reasoningEffort,
                });
                const session = await options.stateStore.resolveOrMaterializeRuntimeSession({
                  chatId,
                  agentId: body.bindingId,
                  sessionId: randomUUID(),
                });
                catalog.invalidate();
                let view: SessionView | null;
                try {
                  view = await catalog.sessionView(session.sessionRef);
                } catch (error) {
                  await options.stateStore.deleteSessionByRef(session.sessionRef);
                  catalog.invalidate();
                  throw new ClientRequestError(
                    503,
                    "session-view-unavailable",
                    error instanceof Error ? error.message : "Session view is unavailable",
                    true,
                  );
                }
                if (!view) {
                  await options.stateStore.deleteSessionByRef(session.sessionRef);
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
                  return { status: 200, body: { projectId: result.project.projectId, removed: true } };
                } catch (error) {
                  return commandError(404, "project-not-found", error instanceof Error ? error.message : String(error));
                }
              },
            );
          }
          if (url.pathname === `${CLIENT_API_PREFIX}/events` && request.method === "GET") {
            const after = eventCursor(request, url);
            return eventStreamResponse(options.stateStore, request, after);
          }
          const sessionMatch = url.pathname.match(/^\/client\/v1\/sessions\/([^/]+)$/u);
          if (sessionMatch && request.method === "GET") {
            const sessionRef = normalizeSessionRef(sessionMatch[1] ?? "");
            if (!sessionRef) return errorResponse(400, "invalid-session-ref", "Invalid Session Ref");
            await catalog.ensureProjection(sessionRef);
            const view = await catalog.sessionView(sessionRef);
            return view ? jsonResponse(view) : errorResponse(404, "session-not-found", "Session was not found");
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
            const blocks = await options.stateStore.listTranscriptBlocks(sessionRef, { beforeSequence: before, limit });
            const firstSequence = blocks[0]?.sequence ?? null;
            const hasOlder = firstSequence
              ? (await options.stateStore.listTranscriptBlocks(sessionRef, { beforeSequence: firstSequence, limit: 1 }))
                  .length > 0
              : false;
            return jsonResponse({
              sessionRef,
              blocks,
              beforeCursor: hasOlder && firstSequence ? `s:${firstSequence}` : null,
              hasOlder,
              completeness: "complete",
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
          const turnsMatch = url.pathname.match(/^\/client\/v1\/sessions\/([^/]+)\/turns$/u);
          if (turnsMatch && request.method === "POST") {
            const sessionRef = normalizeSessionRef(turnsMatch[1] ?? "");
            if (!sessionRef) return errorResponse(400, "invalid-session-ref", "Invalid Session Ref");
            const body = await readJsonBody<StartTurnRequest>(request);
            if (!validRequestId(body.requestId))
              return errorResponse(400, "invalid-request-id", "requestId is required");
            if (typeof body.prompt !== "string" || !body.prompt.trim() || body.prompt.length > 64_000) {
              return errorResponse(400, "invalid-prompt", "Prompt must contain 1 to 64,000 characters");
            }
            return await idempotentCommand(options.stateStore, body.requestId, "turn.start", sessionRef, async () => {
              const session = await catalog.adopt(sessionRef);
              if (!session) return commandError(404, "session-not-found", "Session was not found");
              const runtime = runtimes.get(session.agentId);
              if (!runtime?.enqueueClientTurn)
                return commandError(503, "runtime-offline", "Runtime is unavailable", true);
              const accepted = await runtime.enqueueClientTurn(sessionRef, body.prompt);
              catalog.invalidate();
              return { status: 202, body: { accepted: true, ...accepted } };
            });
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
            return await idempotentCommand(
              options.stateStore,
              body.requestId,
              "session.preferences.update",
              sessionRef,
              async () => {
                const session = await options.stateStore.getRuntimeSessionByRef(sessionRef);
                if (!session) return commandError(404, "session-not-found", "Session was not found");
                const binding = options.config.agents[session.agentId];
                if (!binding) return commandError(404, "binding-not-found", "Agent Binding was not found");
                let model: string | null = null;
                let reasoningEffort: string | null = null;
                try {
                  if (body.model) {
                    const models = await options.runtimeAdapters.listModels(binding);
                    const selectedModel = requireModel(models, body.model);
                    model = selectedModel.id;
                    reasoningEffort = resolveEffort(selectedModel, body.reasoningEffort, true);
                  } else if (body.reasoningEffort) {
                    return commandError(400, "invalid-reasoning-effort", "reasoningEffort requires a model");
                  }
                } catch (error) {
                  return commandError(400, "invalid-model", error instanceof Error ? error.message : String(error));
                }
                const updated = await options.stateStore.setRuntimeSessionModelSelection(
                  session.chatId,
                  session.agentId,
                  session.sessionId,
                  model,
                  reasoningEffort,
                );
                if (!updated) return commandError(404, "session-not-found", "Session was not found");
                catalog.invalidate();
                const view = await catalog.sessionView(sessionRef);
                return view
                  ? { status: 200, body: view }
                  : commandError(404, "session-not-found", "Session was not found");
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
                        await options.runtimeAdapters.listModels(binding),
                        requestedModel,
                      );
                      resolveEffort(selectedModel, requestedEffort, true);
                      if (body.model !== undefined) modelUpdate = selectedModel.id;
                    } catch (error) {
                      return commandError(400, "invalid-model", error instanceof Error ? error.message : String(error));
                    }
                  } else if (requestedEffort) {
                    try {
                      const models = await options.runtimeAdapters.listModels(binding);
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
                if (body.outputVisibility !== undefined) options.config.outputVisibility = body.outputVisibility;
                await saveConfig(options.config, options.configPath);
                catalog.invalidate();
                return {
                  status: 200,
                  body: {
                    bindingId,
                    displayName: binding.displayName || bindingId,
                    model: binding.model ?? null,
                    modelReasoningEffort: binding.modelReasoningEffort ?? null,
                    outputVisibility: options.config.outputVisibility,
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
        const diagnosticRef = randomUUID();
        console.error(`[client-interface:${diagnosticRef}]`, error);
        return errorResponse(500, "internal-error", "Connect Client request failed", true, diagnosticRef);
      }
    },
  });
  await options.stateStore.deleteExpiredClientCommands();
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

function validateMutationRequest(request: Request, origin: string): Response | null {
  if (request.headers.get("origin") !== origin) return errorResponse(403, "invalid-origin", "Invalid request Origin");
  const fetchSite = request.headers.get("sec-fetch-site");
  if (fetchSite && fetchSite !== "same-origin" && fetchSite !== "none") {
    return errorResponse(403, "cross-site-request", "Cross-site request was rejected");
  }
  return null;
}

function eventStreamResponse(store: ConnectStateStore, request: Request, afterCursor: number): Response {
  const encoder = new TextEncoder();
  let cursor = afterCursor;
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
          const events = await store.listClientEvents(cursor);
          for (const stored of events) {
            if (closed) return;
            cursor = stored.cursor;
            controller.enqueue(
              encoder.encode(
                `id: ${stored.cursor}\nevent: ${stored.event.type}\ndata: ${JSON.stringify(stored.event)}\n\n`,
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
    await store.abandonClientCommand(requestId).catch(() => undefined);
    throw error;
  }
}

function commandError(status: number, code: string, message: string, retryable = false) {
  return { status, body: clientErrorView(code, message, retryable) };
}

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: securityHeaders({ "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" }),
  });
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
      "default-src 'self'; script-src 'self'; script-src-attr 'none'; style-src 'self'; style-src-elem 'self'; style-src-attr 'unsafe-inline'; font-src 'self'; img-src 'self' data: blob:; connect-src 'self'; worker-src 'none'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff",
    "Cross-Origin-Opener-Policy": "same-origin",
    "Cross-Origin-Resource-Policy": "same-origin",
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
