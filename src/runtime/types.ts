import type { RuntimeOutputEvent, RuntimeOutputKind } from "../output-visibility";
import type { AgentConfig } from "../types";

export interface ConnectRuntimePrompt {
  prompt: string;
  cwd: string;
  mode?: string;
  metadata?: Record<string, string>;
  outputPolicy?: {
    mode: string;
    allowedKinds: RuntimeOutputKind[];
  };
}

export interface ConnectRuntimeStartContext {
  agentId: string;
  chatId: string;
  sessionId: string;
  runtimeSessionId: string | null;
  configPath: string;
  stateDbPath: string;
  onRuntimeSessionId(runtimeSessionId: string): Promise<void>;
}

export interface ConnectRuntimeSession {
  readonly toolsAlreadyExposed?: boolean;
  prompt(input: ConnectRuntimePrompt): AsyncIterable<RuntimeOutputEvent>;
  close(): Promise<void>;
  cancel?(): Promise<boolean>;
  registerTools?: (tools: unknown, context: unknown) => Promise<boolean> | boolean;
}

export interface ConnectRuntimeAdapter {
  start(agent: AgentConfig, context: ConnectRuntimeStartContext): Promise<ConnectRuntimeSession>;
}
