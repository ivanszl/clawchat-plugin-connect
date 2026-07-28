import { infiniteQueryOptions, queryOptions } from "@tanstack/react-query";
import type {
  BindingPreferenceView,
  BootstrapView,
  CancelTurnResponse,
  ClientMediaAttachment,
  CreateSessionRequest,
  ProjectView,
  RespondToRuntimeInteractionRequest,
  RuntimeInteractionBlock,
  SessionArchiveResponse,
  SessionCatalogView,
  SessionDeleteResponse,
  SessionView,
  StartTurnResponse,
  TranscriptPageView,
  UpdateBindingPreferencesRequest,
} from "../../../src/client-contract";
import { CLIENT_API_PREFIX } from "../../../src/client-contract";
import { clientFetch, requestId } from "./http";

export const clientKeys = {
  bootstrap: ["client", "bootstrap"] as const,
  catalog: ["client", "session-catalog"] as const,
  session: (sessionRef: string) => ["client", "session", sessionRef] as const,
  transcript: (sessionRef: string) => ["client", "transcript", sessionRef] as const,
  projects: ["client", "projects"] as const,
};

export const bootstrapQueryOptions = queryOptions({
  queryKey: clientKeys.bootstrap,
  queryFn: async () => await clientFetch<BootstrapView>(`${CLIENT_API_PREFIX}/bootstrap`),
  staleTime: Number.POSITIVE_INFINITY,
});

export const catalogQueryOptions = queryOptions({
  queryKey: clientKeys.catalog,
  queryFn: async () => await clientFetch<SessionCatalogView>(`${CLIENT_API_PREFIX}/session-catalog`),
});

export async function refreshSessionCatalog(): Promise<SessionCatalogView> {
  return await clientFetch<SessionCatalogView>(`${CLIENT_API_PREFIX}/session-catalog?refresh=1`);
}

export function sessionQueryOptions(sessionRef: string) {
  return queryOptions({
    queryKey: clientKeys.session(sessionRef),
    queryFn: async () => await clientFetch<SessionView>(`${CLIENT_API_PREFIX}/sessions/${sessionRef}?refresh=1`),
    refetchInterval: 2_000,
    refetchIntervalInBackground: false,
  });
}

export const projectsQueryOptions = queryOptions({
  queryKey: clientKeys.projects,
  queryFn: async () => await clientFetch<ProjectView[]>(`${CLIENT_API_PREFIX}/projects`),
});

export function transcriptQueryOptions(sessionRef: string) {
  return infiniteQueryOptions({
    queryKey: clientKeys.transcript(sessionRef),
    initialPageParam: null as string | null,
    queryFn: async ({ pageParam }) => {
      const search = new URLSearchParams({ limit: "100" });
      if (pageParam) search.set("before", pageParam);
      return await clientFetch<TranscriptPageView>(
        `${CLIENT_API_PREFIX}/sessions/${sessionRef}/transcript?${search.toString()}`,
      );
    },
    getNextPageParam: (page) => page.beforeCursor ?? undefined,
  });
}

export async function uploadMedia(sessionRef: string, file: File): Promise<ClientMediaAttachment> {
  const body = new FormData();
  body.append("file", file, file.name);
  return await clientFetch<ClientMediaAttachment>(`${CLIENT_API_PREFIX}/sessions/${sessionRef}/media`, {
    method: "POST",
    body,
  });
}

export async function startTurn(
  sessionRef: string,
  prompt: string,
  media: ClientMediaAttachment[] = [],
): Promise<StartTurnResponse> {
  return await clientFetch<StartTurnResponse>(`${CLIENT_API_PREFIX}/sessions/${sessionRef}/turns`, {
    method: "POST",
    body: JSON.stringify({ requestId: requestId(), prompt, media }),
  });
}

export async function respondToRuntimeInteraction(
  interactionId: string,
  response: Omit<RespondToRuntimeInteractionRequest, "requestId">,
): Promise<RuntimeInteractionBlock> {
  return await clientFetch<RuntimeInteractionBlock>(
    `${CLIENT_API_PREFIX}/runtime-interactions/${encodeURIComponent(interactionId)}/respond`,
    {
      method: "POST",
      body: JSON.stringify({ requestId: requestId(), ...response }),
    },
  );
}

export async function createSession(input: Omit<CreateSessionRequest, "requestId">): Promise<SessionView> {
  return await clientFetch<SessionView>(`${CLIENT_API_PREFIX}/sessions`, {
    method: "POST",
    body: JSON.stringify({ requestId: requestId(), ...input }),
  });
}

export async function cancelTurn(sessionRef: string, turnId: string): Promise<CancelTurnResponse> {
  return await clientFetch<CancelTurnResponse>(
    `${CLIENT_API_PREFIX}/sessions/${sessionRef}/turns/${encodeURIComponent(turnId)}/cancel`,
    { method: "POST", body: JSON.stringify({ requestId: requestId() }) },
  );
}

export async function archiveSession(sessionRef: string): Promise<SessionArchiveResponse> {
  return await clientFetch<SessionArchiveResponse>(`${CLIENT_API_PREFIX}/sessions/${sessionRef}/archive`, {
    method: "POST",
    body: JSON.stringify({ requestId: requestId() }),
  });
}

export async function unarchiveSession(sessionRef: string): Promise<SessionArchiveResponse> {
  return await clientFetch<SessionArchiveResponse>(`${CLIENT_API_PREFIX}/sessions/${sessionRef}/unarchive`, {
    method: "POST",
    body: JSON.stringify({ requestId: requestId() }),
  });
}

export async function deleteSession(sessionRef: string): Promise<SessionDeleteResponse> {
  return await clientFetch<SessionDeleteResponse>(`${CLIENT_API_PREFIX}/sessions/${sessionRef}`, {
    method: "DELETE",
    body: JSON.stringify({ requestId: requestId() }),
  });
}

export async function updateSessionPreferences(
  sessionRef: string,
  model: string | null,
  reasoningEffort: string | null,
): Promise<SessionView> {
  return await clientFetch<SessionView>(`${CLIENT_API_PREFIX}/sessions/${sessionRef}/preferences`, {
    method: "PATCH",
    body: JSON.stringify({ requestId: requestId(), model, reasoningEffort }),
  });
}

export async function addProject(
  name: string,
  rootPath: string,
  additionalDirectories: string[],
): Promise<ProjectView> {
  return await clientFetch<ProjectView>(`${CLIENT_API_PREFIX}/projects`, {
    method: "POST",
    body: JSON.stringify({ requestId: requestId(), name, rootPath, additionalDirectories }),
  });
}

export async function removeProject(projectId: string): Promise<{ projectId: string; removed: true }> {
  return await clientFetch(`${CLIENT_API_PREFIX}/projects/${encodeURIComponent(projectId)}`, {
    method: "DELETE",
    body: JSON.stringify({ requestId: requestId() }),
  });
}

export async function updateBindingPreferences(
  bindingId: string,
  updates: Omit<UpdateBindingPreferencesRequest, "requestId">,
): Promise<BindingPreferenceView & { outputVisibility: BootstrapView["outputVisibility"] }> {
  return await clientFetch(`${CLIENT_API_PREFIX}/bindings/${encodeURIComponent(bindingId)}/preferences`, {
    method: "PATCH",
    body: JSON.stringify({ requestId: requestId(), ...updates }),
  });
}
