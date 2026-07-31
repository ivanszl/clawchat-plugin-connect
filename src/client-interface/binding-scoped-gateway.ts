import type { ClientHttpServerFactory, ClientHttpServerHandle } from "./server";

export const BINDING_SCOPE_HEADER = "x-clawchat-connect-binding-scope";

export interface BindingScopedClientGatewayOptions {
  bindingId: string;
  upstreamOrigin: string;
  hostname?: string;
  port?: number;
  fetchImpl?: (request: Request) => Promise<Response>;
  serverFactory?: ClientHttpServerFactory;
}

export interface BindingScopedClientGatewayHandle {
  bindingId: string;
  origin: string;
  stop(): Promise<void>;
}

export async function startBindingScopedClientGateway(
  options: BindingScopedClientGatewayOptions,
): Promise<BindingScopedClientGatewayHandle> {
  const bindingId = requireText(options.bindingId, "Agent Binding ID");
  const upstream = new URL(options.upstreamOrigin);
  const hostname = options.hostname ?? "127.0.0.1";
  const requestedPort = options.port ?? 0;
  const fetchImpl = options.fetchImpl ?? (async (request: Request) => await fetch(request));
  const serverFactory: ClientHttpServerFactory = options.serverFactory ?? ((serverOptions) => Bun.serve(serverOptions));
  const server: ClientHttpServerHandle = serverFactory({
    hostname,
    port: requestedPort,
    idleTimeout: 0,
    fetch: async (request) => {
      const url = new URL(request.url);
      const target = new URL(`${url.pathname}${url.search}`, upstream);
      const headers = new Headers(request.headers);
      headers.set(BINDING_SCOPE_HEADER, bindingId);
      headers.delete("host");
      headers.delete("content-length");
      const init: RequestInit & { duplex?: "half" } = {
        method: request.method,
        headers,
        signal: request.signal,
      };
      if (request.method !== "GET" && request.method !== "HEAD") {
        init.body = request.body;
        init.duplex = "half";
      }
      return await fetchImpl(new Request(target, init));
    },
  });
  const port = server.port ?? requestedPort;
  if (!port) {
    await server.stop(true);
    throw new Error(`Binding-Scoped Client Gateway for ${bindingId} did not report its allocated port`);
  }
  return {
    bindingId,
    origin: `http://${hostname}:${port}`,
    stop: async () => await server.stop(true),
  };
}

function requireText(value: string, label: string): string {
  const text = value.trim();
  if (!text) throw new Error(`${label} is required`);
  return text;
}
