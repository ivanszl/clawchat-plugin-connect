import { infiniteQueryOptions, queryOptions } from "@tanstack/react-query";
import type {
  BindingPreferenceView,
  BootstrapView,
  CancelTurnResponse,
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
};

export const bootstrapQueryOptions = queryOptions({
  queryKey: clientKeys.bootstrap,
  queryFn: async () => await clientFetch<BootstrapView>(`${CLIENT_API_PREFIX}/bootstrap`),
  staleTime: Number.POSITIVE_INFINITY,
});

export const catalogQueryOptions = queryOptions({
  queryKey: clientKeys.catalog,
  queryFn: async () => await clientFetch<SessionCatalogView>(`${CLIENT_API_PREFIX}/session-catalog`),
  refetchInterval: 3_000,
});

export function sessionQueryOptions(sessionRef: string) {
  return queryOptions({
    queryKey: clientKeys.session(sessionRef),
    queryFn: async () => await clientFetch<SessionView>(`${CLIENT_API_PREFIX}/sessions/${sessionRef}`),
    refetchInterval: 2_000,
  });
}

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

export async function startTurn(sessionRef: string, prompt: string): Promise<StartTurnResponse> {
  return await clientFetch<StartTurnResponse>(`${CLIENT_API_PREFIX}/sessions/${sessionRef}/turns`, {
    method: "POST",
    body: JSON.stringify({ requestId: requestId(), prompt }),
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

export async function updateBindingPreferences(
  bindingId: string,
  updates: Omit<UpdateBindingPreferencesRequest, "requestId">,
): Promise<BindingPreferenceView & { outputVisibility: BootstrapView["outputVisibility"] }> {
  return await clientFetch(`${CLIENT_API_PREFIX}/bindings/${encodeURIComponent(bindingId)}/preferences`, {
    method: "PATCH",
    body: JSON.stringify({ requestId: requestId(), ...updates }),
  });
}
