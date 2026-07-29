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
  return (await clientFetchResponse<T>(path, init)).value;
}

export async function clientFetchSnapshot<T>(
  path: string,
  init: RequestInit = {},
): Promise<{ value: T; watermark: number }> {
  const result = await clientFetchResponse<T>(path, init);
  const watermark = Number(result.response.headers.get("X-Client-View-Watermark"));
  if (!Number.isSafeInteger(watermark) || watermark < 0) {
    throw new ClientInterfaceError(502, "missing-snapshot-watermark", "Connect Client 快照缺少有效水位", true);
  }
  return { value: result.value, watermark };
}

async function clientFetchResponse<T>(path: string, init: RequestInit): Promise<{ value: T; response: Response }> {
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
  return { value: (await response.json()) as T, response };
}

export function requestId(): string {
  return crypto.randomUUID().replaceAll("-", "_");
}
