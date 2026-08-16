import { isAbsolute, relative, sep } from "node:path";
import { CLIENT_API_PREFIX, type ClientErrorView, type UpdateBindingPreferencesRequest } from "../client-contract";

const MAX_JSON_BODY_BYTES = 128 * 1_024;
const OUTPUT_VISIBILITIES = new Set(["minimal", "normal", "full"]);

export class ClientRequestError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly retryable = false,
  ) {
    super(message);
  }
}

export async function readJsonBody<T>(request: Request): Promise<T> {
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

export function commandError(status: number, code: string, message: string, retryable = false) {
  return { status, body: clientErrorView(code, message, retryable) };
}

export function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: securityHeaders({ "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" }),
  });
}

export function isPathWithin(root: string, candidate: string): boolean {
  const nestedPath = relative(root, candidate);
  return nestedPath === "" || (!nestedPath.startsWith(`..${sep}`) && nestedPath !== ".." && !isAbsolute(nestedPath));
}

export function isClientAdministrationPath(pathname: string): boolean {
  return (
    pathname === `${CLIENT_API_PREFIX}/plugins` ||
    pathname.startsWith(`${CLIENT_API_PREFIX}/plugins/`) ||
    /^\/client\/v1\/bindings\/[^/]+\/provider$/u.test(pathname)
  );
}

export function snapshotResponse(value: unknown, watermark: number): Response {
  const response = jsonResponse(value);
  response.headers.set("X-Client-View-Watermark", String(watermark));
  return response;
}

export function errorResponse(
  status: number,
  code: string,
  message: string,
  retryable = false,
  diagnosticRef?: string,
): Response {
  const body = clientErrorView(code, message, retryable, diagnosticRef);
  return jsonResponse(body, status);
}

export function clientErrorView(
  code: string,
  message: string,
  retryable = false,
  diagnosticRef?: string,
): ClientErrorView {
  return { error: { code, message, retryable, ...(diagnosticRef ? { diagnosticRef } : {}) } };
}

export function securityHeaders(initial: Record<string, string> = {}): Headers {
  return new Headers({
    "Content-Security-Policy":
      "default-src 'self'; script-src 'self' blob:; script-src-attr 'none'; style-src 'self'; style-src-elem 'self'; style-src-attr 'unsafe-inline'; font-src 'self'; img-src 'self' data: blob: https:; connect-src 'self'; worker-src 'none'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff",
    "Cross-Origin-Opener-Policy": "same-origin",
    "Cross-Origin-Resource-Policy": "same-origin",
    ...initial,
  });
}

export function workspaceArtifactHeaders(initial: Record<string, string>): Headers {
  return securityHeaders({
    "Content-Security-Policy":
      "default-src 'none'; script-src 'none'; script-src-attr 'none'; style-src 'none'; img-src 'self' data:; connect-src 'none'; worker-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'self'",
    ...initial,
  });
}

export function eventCursor(request: Request, url: URL): number {
  const value = request.headers.get("last-event-id") || url.searchParams.get("after") || "0";
  const cursor = Number(value);
  return Number.isSafeInteger(cursor) && cursor >= 0 ? cursor : 0;
}

export function parseBeforeCursor(value: string | null): number | null {
  if (!value) return null;
  if (!/^s:\d+$/u.test(value)) throw new Error("invalid transcript cursor");
  const sequence = Number(value.slice(2));
  if (!Number.isSafeInteger(sequence) || sequence < 1) throw new Error("invalid transcript cursor");
  return sequence;
}

export function parseLimit(value: string | null): number {
  const parsed = Number(value ?? 100);
  return Number.isFinite(parsed) ? Math.max(1, Math.min(200, Math.trunc(parsed))) : 100;
}

export function validRequestId(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9_-]{8,100}$/u.test(value);
}

export function isStringRecord(value: unknown): value is Record<string, string> | undefined {
  return (
    value === undefined ||
    (Boolean(value) &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      Object.values(value as Record<string, unknown>).every((item) => typeof item === "string"))
  );
}

export function requireDisplayName(value: unknown): string {
  if (typeof value !== "string" || !value.trim() || value.trim().length > 80) {
    throw new ClientRequestError(400, "invalid-display-name", "displayName must contain 1 to 80 characters");
  }
  return value.trim();
}

export function validatePreferencePatch(body: UpdateBindingPreferencesRequest): void {
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

export function setOptionalString<T extends object, K extends keyof T>(target: T, key: K, value: T[K] | null): void {
  if (value === null || (typeof value === "string" && !value.trim())) delete target[key];
  else target[key] = (typeof value === "string" ? value.trim() : value) as T[K];
}

export function isMutation(method: string): boolean {
  return method !== "GET" && method !== "HEAD" && method !== "OPTIONS";
}
