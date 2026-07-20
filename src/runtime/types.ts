import type { RuntimeOutputEvent, RuntimeOutputKind } from "../output-visibility";
import type { AgentBindingConfig, RuntimeWorkspace } from "../types";

export interface ConnectRuntimePrompt {
  prompt: string;
  workspace: RuntimeWorkspace;
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

export interface RuntimeThreadSummary {
  runtimeThreadId: string;
  name: string | null;
  updatedAt: number;
}

export interface SelectableRuntimeThread extends RuntimeThreadSummary {
  sessionRef: string;
}

export interface ConnectRuntimeSession {
  prompt(input: ConnectRuntimePrompt): AsyncIterable<RuntimeOutputEvent>;
  close(): Promise<void>;
  cancel?(): Promise<boolean>;
}

export interface ConnectRuntimeAdapter {
  readonly kind: string;
  readonly modes: readonly string[];
  discoverThreads?(binding: AgentBindingConfig, workspace: RuntimeWorkspace): Promise<RuntimeThreadSummary[]>;
  start(binding: AgentBindingConfig, context: ConnectRuntimeStartContext): Promise<ConnectRuntimeSession>;
}
