import type { ClientErrorView } from "../../../src/client-contract";

export class ClientInterfaceError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly retryable: boolean,
    readonly diagnosticRef?: string,
  ) {
    super(message);
    this.name = "ClientInterfaceError";
  }
}

export async function clientFetch<T>(path: string, init: RequestInit = {}): Promise<T> {
  const method = (init.method ?? "GET").toUpperCase();
  const headers = new Headers(init.headers);
  headers.set("Accept", "application/json");
  if (init.body != null && !(init.body instanceof FormData)) headers.set("Content-Type", "application/json");
  const response = await fetch(path, { ...init, method, headers });
  if (!response.ok) {
    let view: ClientErrorView | null = null;
    try {
      view = (await response.json()) as ClientErrorView;
    } catch {
      // The status remains useful when an intermediary returned a non-JSON body.
    }
    throw new ClientInterfaceError(
      response.status,
      view?.error.code ?? `http-${response.status}`,
      view?.error.message ?? `Connect Client 请求失败（HTTP ${response.status}）`,
      view?.error.retryable ?? response.status >= 500,
      view?.error.diagnosticRef,
    );
  }
  return (await response.json()) as T;
}

export function requestId(): string {
  return crypto.randomUUID().replaceAll("-", "_");
}
