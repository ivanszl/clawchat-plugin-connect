import { access } from "node:fs/promises";
import { dirname, extname, join, resolve, sep } from "node:path";
import { securityHeaders } from "./client-http";

export async function staticResponse(assetsRoot: string, pathname: string, head: boolean): Promise<Response> {
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

export async function resolveClientAssetsPath(): Promise<string> {
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

export function isKnownStaticFile(path: string): boolean {
  return /^(?:favicon\.ico|manifest\.webmanifest|robots\.txt)$/u.test(path);
}

export function contentType(path: string): string {
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
