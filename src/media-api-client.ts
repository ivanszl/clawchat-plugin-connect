import { type Fragment, ProtocolError, StateError, TransportError } from "./protocol";

export type MediaUploadFetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export interface MediaUploadInput {
  file: Blob;
  filename?: string;
}

export interface UploadClawChatMediaOptions {
  uploadUrl?: string;
  token: string;
  fetch?: MediaUploadFetch;
}

export async function uploadClawChatMedia(
  options: UploadClawChatMediaOptions,
  file: Blob,
  input: { filename?: string } = {},
): Promise<Fragment> {
  if (!(file instanceof Blob)) throw new ProtocolError("media upload file must be a Blob");
  const uploadUrl = parseMediaUploadUrl(options.uploadUrl);
  const body = new FormData();
  body.append("file", file, input.filename?.trim() ?? "");
  let response: Response;
  try {
    response = await (options.fetch ?? globalThis.fetch)(uploadUrl, {
      method: "POST",
      headers: { authorization: `Bearer ${options.token}` },
      body,
    });
  } catch (error) {
    throw new TransportError(`media upload failed: ${error instanceof Error ? error.message : String(error)}`);
  }
  let parsed: unknown;
  try {
    parsed = await response.json();
  } catch (error) {
    if (!response.ok) throw new TransportError(`media upload failed with HTTP ${response.status}`);
    throw new TransportError(
      `media upload returned invalid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const envelope = objectRecord(parsed);
  if (!envelope || typeof envelope.code !== "number" || !Number.isSafeInteger(envelope.code)) {
    throw new ProtocolError("media upload response is missing an integer code");
  }
  if (envelope.code !== 0) {
    const detail = typeof envelope.msg === "string" && envelope.msg ? envelope.msg : "media upload rejected";
    throw new ProtocolError(`${envelope.code}: ${detail}`);
  }
  if (!response.ok) throw new TransportError(`media upload failed with HTTP ${response.status}`);
  if (!isUploadedMediaFragment(envelope.data)) {
    throw new ProtocolError("media upload response data is not a media Fragment");
  }
  return envelope.data;
}

function parseMediaUploadUrl(value: string | undefined): URL {
  if (!value?.trim()) throw new StateError("mediaUploadUrl is required for media uploads");
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new StateError("mediaUploadUrl is invalid");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new StateError(`mediaUploadUrl protocol is unsupported: ${url.protocol}`);
  }
  return url;
}

function objectRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function isUploadedMediaFragment(value: unknown): value is Fragment {
  const fragment = objectRecord(value);
  if (!fragment || !["image", "file", "audio", "video"].includes(String(fragment.kind))) return false;
  if (typeof fragment.url !== "string" || !fragment.url) return false;
  if (typeof fragment.name !== "string" || !fragment.name) return false;
  if (fragment.mime !== undefined && typeof fragment.mime !== "string") return false;
  if (
    fragment.size !== undefined &&
    (typeof fragment.size !== "number" || !Number.isFinite(fragment.size) || fragment.size < 0)
  )
    return false;
  return true;
}
