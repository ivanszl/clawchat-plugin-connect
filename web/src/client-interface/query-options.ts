import { infiniteQueryOptions, queryOptions } from "@tanstack/react-query";
import type {
  BindingPreferenceView,
  BootstrapView,
  CancelTurnResponse,
  CreateSessionRequest,
  ProjectView,
  RespondToRuntimeInteractionRequest,
  RuntimeInteractionBlock,
  SessionArchiveResponse,
  SessionCatalogView,
  SessionDeleteResponse,
  SessionView,
  TranscriptPageView,
  UpdateBindingPreferencesRequest,
} from "../../../src/client-contract";
import { CLIENT_API_PREFIX } from "../../../src/client-contract";
import { installClientViewSnapshot } from "./client-events";
import { clientFetch, clientFetchSnapshot, requestId } from "./http";

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
  queryFn: async ({ client }) => {
    const snapshot = await clientFetchSnapshot<SessionCatalogView>(`${CLIENT_API_PREFIX}/session-catalog`);
    await installClientViewSnapshot(client, { watermark: snapshot.watermark, catalog: snapshot.value });
    return snapshot.value;
  },
});

export async function refreshSessionCatalog(client: import("@tanstack/react-query").QueryClient): Promise<void> {
  const snapshot = await clientFetchSnapshot<SessionCatalogView>(`${CLIENT_API_PREFIX}/session-catalog?refresh=1`);
  await installClientViewSnapshot(client, { watermark: snapshot.watermark, catalog: snapshot.value });
  await Promise.all([
    client.invalidateQueries({ queryKey: ["client", "session"], refetchType: "active" }),
    client.invalidateQueries({ queryKey: ["client", "transcript"], refetchType: "active" }),
  ]);
}

export function sessionQueryOptions(sessionRef: string) {
  return queryOptions({
    queryKey: clientKeys.session(sessionRef),
    queryFn: async ({ client }) => {
      const snapshot = await clientFetchSnapshot<SessionView>(`${CLIENT_API_PREFIX}/sessions/${sessionRef}?refresh=1`);
      await installClientViewSnapshot(client, { watermark: snapshot.watermark, sessions: [snapshot.value] });
      return snapshot.value;
    },
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
    queryFn: async ({ pageParam, client }) => {
      const search = new URLSearchParams({ limit: "100" });
      if (pageParam) search.set("before", pageParam);
      const snapshot = await clientFetchSnapshot<TranscriptPageView>(
        `${CLIENT_API_PREFIX}/sessions/${sessionRef}/transcript?${search.toString()}`,
      );
      if (!pageParam) {
        await installClientViewSnapshot(client, {
          watermark: snapshot.watermark,
          transcripts: [snapshot.value],
        });
      }
      return snapshot.value;
    },
    getNextPageParam: (page) => page.beforeCursor ?? undefined,
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
