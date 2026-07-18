import { readFile, stat } from "node:fs/promises";
import { basename, extname } from "node:path";
import {
  type ClawChatApiClient,
  ClawChatApiError,
  type FetchLike,
  MAX_MEDIA_UPLOAD_BYTES,
  type MediaUploadResult,
} from "./api-client";
export type MediaFragment = MediaUploadResult;
const MIME_BY_EXT: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".pdf": "application/pdf",
  ".txt": "text/plain",
  ".md": "text/markdown",
  ".mp3": "audio/mpeg",
  ".m4a": "audio/mp4",
  ".wav": "audio/wav",
  ".mp4": "video/mp4",
  ".mov": "video/quicktime",
  ".webm": "video/webm",
};
export interface DownloadedMedia {
  buffer: Buffer;
  mime: string;
  name: string;
  size: number;
}
export function inferMimeFromPath(path: string): string {
  return MIME_BY_EXT[extname(path).toLowerCase()] ?? "application/octet-stream";
}
export async function uploadLocalMediaFile(api: ClawChatApiClient, filePath: string): Promise<MediaFragment> {
  const fileStat = await stat(filePath);
  if (!fileStat.isFile()) throw new Error(`${filePath} is not a regular file`);
  if (fileStat.size > MAX_MEDIA_UPLOAD_BYTES)
    throw new Error(`media file too large (${fileStat.size} bytes; max 20MB)`);
  return await api.uploadMedia({
    buffer: await readFile(filePath),
    filename: basename(filePath),
    mime: inferMimeFromPath(filePath),
  });
}
export async function downloadRemoteMedia(
  url: string,
  fetchImpl: FetchLike = globalThis.fetch.bind(globalThis),
): Promise<DownloadedMedia> {
  const parsed = new URL(url);
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:")
    throw new ClawChatApiError("validation", "media URL must be http:// or https://");
  const response = await fetchImpl(parsed.toString());
  if (!response.ok) throw new ClawChatApiError("transport", `media download failed with status ${response.status}`);
  const contentLength = response.headers.get("content-length");
  if (contentLength && Number(contentLength) > MAX_MEDIA_UPLOAD_BYTES)
    throw new ClawChatApiError("validation", `media download too large (${contentLength} bytes; max 20MB)`);
  const arrayBuffer = await response.arrayBuffer();
  if (arrayBuffer.byteLength > MAX_MEDIA_UPLOAD_BYTES)
    throw new ClawChatApiError("validation", `media download too large (${arrayBuffer.byteLength} bytes; max 20MB)`);
  return {
    buffer: Buffer.from(arrayBuffer),
    mime: response.headers.get("content-type")?.split(";")[0]?.trim() || inferMimeFromPath(parsed.pathname),
    name: basename(parsed.pathname) || "download",
    size: arrayBuffer.byteLength,
  };
}
