import { describe, expect, it, mock } from "bun:test";
import { startBindingScopedClientGateway } from "../src/client-interface/binding-scoped-gateway";

describe("Binding-Scoped Client Gateway", () => {
  it("overwrites a caller-supplied Binding scope before forwarding to Client Interface", async () => {
    let gatewayFetch: ((request: Request) => Response | Promise<Response>) | null = null;
    const forwarded: Request[] = [];
    const fetchImpl = mock(async (request: Request) => {
      forwarded.push(request);
      return Response.json({ accepted: true });
    });
    const gateway = await startBindingScopedClientGateway({
      bindingId: "personal",
      upstreamOrigin: "http://127.0.0.1:47823",
      port: 48101,
      fetchImpl,
      serverFactory: (options) => {
        gatewayFetch = options.fetch;
        return { port: options.port, stop: async () => undefined };
      },
    });
    if (!gatewayFetch) throw new Error("test gateway did not expose a request handler");

    const response = await (gatewayFetch as (request: Request) => Response | Promise<Response>)(
      new Request("https://personal.apps.example/client/v1/bootstrap", {
        headers: { "x-clawchat-connect-binding-scope": "work" },
      }),
    );

    expect(response.status).toBe(200);
    expect(gateway.origin).toBe("http://127.0.0.1:48101");
    expect(forwarded).toHaveLength(1);
    expect(forwarded[0]?.url).toBe("http://127.0.0.1:47823/client/v1/bootstrap");
    expect(forwarded[0]?.headers.get("x-clawchat-connect-binding-scope")).toBe("personal");
    await gateway.stop();
  });
});
