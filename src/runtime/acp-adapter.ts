import type { RuntimeOutputEvent } from "../output-visibility";
import type { AcpAgentConfig } from "../types";
import type { ConnectRuntimeAdapter, ConnectRuntimePrompt, ConnectRuntimeSession } from "./types";

export type {
  ConnectRuntimeAdapter,
  ConnectRuntimePrompt,
  ConnectRuntimeSession,
} from "./types";

type UnknownConnection = {
  prompt?: (input: unknown) => AsyncIterable<unknown> | Promise<unknown>;
  request?: (method: string, params: unknown) => Promise<unknown>;
  registerTools?: (tools: unknown, context: unknown) => Promise<boolean> | boolean;
  cancel?: () => Promise<boolean> | boolean;
  close?: () => Promise<void> | void;
  dispose?: () => Promise<void> | void;
};

export function createAcpRuntimeAdapter(): ConnectRuntimeAdapter {
  return {
    async start(agent) {
      if (agent.kind !== "acp") throw new Error("ACP runtime adapter requires an ACP agent");
      return new SdkRuntimeSession(await createConnection(agent));
    },
  };
}

async function createConnection(agent: AcpAgentConfig): Promise<UnknownConnection> {
  if (!agent.command.trim()) throw new Error("agent command is required");
  const sdk = await import("@agentclientprotocol/sdk");
  const factory =
    (sdk as Record<string, unknown>).ClientSideConnection ??
    (sdk as Record<string, unknown>).createClientSideConnection;
  const options = {
    command: agent.command,
    args: agent.args ?? [],
    env: agent.env,
    cwd: agent.processCwd,
  };
  if (typeof factory !== "function") {
    throw new Error("@agentclientprotocol/sdk ClientSideConnection API is unavailable");
  }
  return isClassLike(factory)
    ? new (factory as new (options: unknown) => UnknownConnection)(options)
    : await (factory as (options: unknown) => UnknownConnection | Promise<UnknownConnection>)(options);
}

class SdkRuntimeSession implements ConnectRuntimeSession {
  constructor(private readonly connection: UnknownConnection) {}

  async *prompt(input: ConnectRuntimePrompt): AsyncIterable<RuntimeOutputEvent> {
    if (this.connection.prompt) {
      const result = await this.connection.prompt(input);
      if (isAsyncIterable(result)) {
        for await (const item of result) yield normalizeRuntimeEvent(item);
        return;
      }
      yield normalizeRuntimeEvent(result);
      return;
    }
    if (this.connection.request) {
      yield normalizeRuntimeEvent(await this.connection.request("session/prompt", input));
      return;
    }
    throw new Error("ACP connection does not expose prompt or request");
  }

  async registerTools(tools: unknown, context: unknown): Promise<boolean> {
    if (this.connection.registerTools) return await this.connection.registerTools(tools, context);
    if (this.connection.request) {
      await this.connection.request("tools/register", { tools, context });
      return true;
    }
    return false;
  }

  async cancel(): Promise<boolean> {
    if (this.connection.cancel) return await this.connection.cancel();
    if (this.connection.request) {
      await this.connection.request("session/cancel", {});
      return true;
    }
    return false;
  }

  async close(): Promise<void> {
    if (this.connection.close) await this.connection.close();
    else if (this.connection.dispose) await this.connection.dispose();
  }
}

function isClassLike(value: unknown): boolean {
  return typeof value === "function" && /^class\s/u.test(Function.prototype.toString.call(value));
}

function isAsyncIterable(value: unknown): value is AsyncIterable<unknown> {
  return !!value && typeof (value as { [Symbol.asyncIterator]?: unknown })[Symbol.asyncIterator] === "function";
}

function normalizeRuntimeEvent(value: unknown): RuntimeOutputEvent {
  const record = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
  const kind =
    record.kind === "assistant" ||
    record.kind === "tool" ||
    record.kind === "progress" ||
    record.kind === "reasoning" ||
    record.kind === "control"
      ? record.kind
      : "final";
  const text = typeof record.text === "string" ? record.text : String(value ?? "");
  return { kind, text, requiredControl: record.requiredControl === true };
}
