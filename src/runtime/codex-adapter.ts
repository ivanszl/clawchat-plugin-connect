import { createReadStream } from "node:fs";
import { readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import type { CodexOptions, ThreadEvent, ThreadItem, ThreadOptions, TurnOptions } from "@openai/codex-sdk";
import type { RuntimeOutputEvent } from "../output-visibility";
import type { CodexAgentBindingConfig, CodexSandboxMode, RuntimeWorkspace } from "../types";
import type {
  ConnectRuntimeAdapter,
  ConnectRuntimePrompt,
  ConnectRuntimeSession,
  ConnectRuntimeStartContext,
  RuntimeThreadSummary,
} from "./types";

export interface CodexThreadLike {
  readonly id: string | null;
  runStreamed(input: string, options?: TurnOptions): Promise<{ events: AsyncIterable<ThreadEvent> }>;
}

export interface CodexClientLike {
  startThread(options?: ThreadOptions): CodexThreadLike;
  resumeThread(id: string, options?: ThreadOptions): CodexThreadLike;
}

export interface CreateCodexRuntimeAdapterOptions {
  createCodex?: (options: CodexOptions) => Promise<CodexClientLike>;
}

const SANDBOX_MODES: readonly CodexSandboxMode[] = ["read-only", "workspace-write", "danger-full-access"];

export function createCodexRuntimeAdapter(options: CreateCodexRuntimeAdapterOptions = {}): ConnectRuntimeAdapter {
  const createCodex = options.createCodex ?? createOfficialCodexClient;
  return {
    kind: "codex",
    modes: SANDBOX_MODES,
    async discoverThreads(binding, workspace) {
      if (binding.kind !== "codex") throw new Error("Codex Runtime Adapter requires a Codex Agent Binding");
      return await discoverCodexThreads(binding, workspace.workingDirectory);
    },
    async start(binding, context) {
      if (binding.kind !== "codex") throw new Error("Codex Runtime Adapter requires a Codex Agent Binding");
      const client = await createCodex(codexOptions(binding));
      return new CodexRuntimeSession(client, binding, context);
    },
  };
}

async function discoverCodexThreads(
  binding: CodexAgentBindingConfig,
  workingDirectory: string,
): Promise<RuntimeThreadSummary[]> {
  const configuredHome = binding.env?.CODEX_HOME ?? process.env.CODEX_HOME;
  const sessionsRoot = join(resolve(configuredHome || join(homedir(), ".codex")), "sessions");
  const files = await listSessionFiles(sessionsRoot);
  const target = resolve(workingDirectory);
  const summaries = await Promise.all(files.map(async (path) => await readCodexThread(path, target)));
  return summaries
    .filter((summary): summary is RuntimeThreadSummary => summary !== null)
    .sort((left, right) => right.updatedAt - left.updatedAt);
}

async function listSessionFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true }).catch(() => []);
  const nested = await Promise.all(
    entries.map(async (entry) => {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) return await listSessionFiles(path);
      return entry.isFile() && entry.name.endsWith(".jsonl") ? [path] : [];
    }),
  );
  return nested.flat();
}

async function readCodexThread(path: string, targetDirectory: string): Promise<RuntimeThreadSummary | null> {
  const lines = createInterface({ input: createReadStream(path), crlfDelay: Number.POSITIVE_INFINITY });
  let runtimeThreadId = "";
  let updatedAt = 0;
  let name: string | null = null;
  try {
    for await (const line of lines) {
      const record = parseRecord(line);
      if (!record) continue;
      const payload = asRecord(record.payload);
      if (record.type === "session_meta" && payload) {
        const directory = stringField(payload.cwd);
        if (!directory || resolve(directory) !== targetDirectory) return null;
        runtimeThreadId = stringField(payload.id) || stringField(payload.session_id);
        updatedAt = Date.parse(stringField(payload.timestamp));
        if (!Number.isFinite(updatedAt)) updatedAt = 0;
        continue;
      }
      if (record.type === "event_msg" && payload?.type === "user_message" && !name) {
        name = normalizeThreadName(stringField(payload.message));
        if (runtimeThreadId) break;
      }
    }
  } catch {
    return null;
  } finally {
    lines.close();
  }
  return runtimeThreadId ? { runtimeThreadId, name, updatedAt } : null;
}

function parseRecord(line: string): Record<string, unknown> | null {
  try {
    return asRecord(JSON.parse(line));
  } catch {
    return null;
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function stringField(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function normalizeThreadName(value: string): string | null {
  const normalized = value
    .replace(/^ClawChat (?:direct|group) message from [^:]+:\s*/u, "")
    .replace(/\s+/gu, " ")
    .trim();
  if (!normalized) return null;
  return normalized.length <= 100 ? normalized : `${normalized.slice(0, 99).trimEnd()}…`;
}

async function createOfficialCodexClient(options: CodexOptions): Promise<CodexClientLike> {
  const { Codex } = await import("@openai/codex-sdk");
  return new Codex(options);
}

function codexOptions(binding: CodexAgentBindingConfig): CodexOptions {
  const env = binding.env ? { ...definedProcessEnvironment(), ...binding.env } : undefined;
  return {
    ...(binding.codexPathOverride ? { codexPathOverride: binding.codexPathOverride } : {}),
    ...(env ? { env } : {}),
  };
}

function definedProcessEnvironment(): Record<string, string> {
  return Object.fromEntries(
    Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined),
  );
}

class CodexRuntimeSession implements ConnectRuntimeSession {
  private thread: CodexThreadLike | null = null;
  private activeTurn: AbortController | null = null;
  private threadWorkspaceKey: string | null = null;
  private threadSandboxMode: CodexSandboxMode | null = null;
  private runtimeSessionId: string | null;

  constructor(
    private readonly client: CodexClientLike,
    private readonly binding: CodexAgentBindingConfig,
    private readonly context: ConnectRuntimeStartContext,
  ) {
    this.runtimeSessionId = context.runtimeSessionId;
  }

  async *prompt(input: ConnectRuntimePrompt): AsyncIterable<RuntimeOutputEvent> {
    if (this.activeTurn) throw new Error("Codex already has an active turn for this session");
    const sandboxMode = resolveSandboxMode(input.mode, this.binding.sandboxMode);
    const thread = this.ensureThread(input.workspace, sandboxMode);
    const controller = new AbortController();
    this.activeTurn = controller;
    let emittedFailure = false;
    try {
      const streamed = await thread.runStreamed(input.prompt, { signal: controller.signal });
      let pendingAgentMessage: string | null = null;
      const seenErrors = new Set<string>();
      for await (const event of streamed.events) {
        if (controller.signal.aborted) return;
        if (event.type === "thread.started") {
          await this.recordRuntimeSessionId(event.thread_id);
          continue;
        }
        if (event.type === "turn.started") {
          yield { kind: "progress", text: "Codex turn started." };
          continue;
        }
        if (event.type === "item.started") {
          const progress = formatStartedItem(event.item);
          if (progress) yield progress;
          continue;
        }
        if (event.type === "item.updated") continue;
        if (event.type === "item.completed") {
          if (event.item.type === "agent_message") {
            if (pendingAgentMessage !== null) yield { kind: "assistant", text: pendingAgentMessage };
            pendingAgentMessage = event.item.text;
            continue;
          }
          const mapped = formatCompletedItem(event.item);
          if (mapped) {
            if (event.item.type === "error") seenErrors.add(event.item.message.trim());
            yield mapped;
          }
          continue;
        }
        if (event.type === "turn.completed") {
          yield { kind: "progress", text: formatUsage(event.usage) };
          if (pendingAgentMessage !== null) {
            yield { kind: "final", text: pendingAgentMessage };
            pendingAgentMessage = null;
          }
          continue;
        }
        if (event.type === "turn.failed") {
          if (pendingAgentMessage !== null) {
            yield { kind: "assistant", text: pendingAgentMessage };
            pendingAgentMessage = null;
          }
          const message = event.error.message.trim();
          if (!seenErrors.has(message)) {
            yield { kind: "final", text: `Codex turn failed: ${message}` };
            seenErrors.add(message);
          }
          emittedFailure = true;
          continue;
        }
        if (event.type === "error") {
          const message = event.message.trim();
          if (!seenErrors.has(message)) {
            yield { kind: "final", text: `Codex stream error: ${message}` };
            seenErrors.add(message);
          }
          emittedFailure = true;
        }
      }
      if (pendingAgentMessage !== null) yield { kind: "final", text: pendingAgentMessage };
    } catch (error) {
      if (controller.signal.aborted) return;
      if (!emittedFailure) {
        yield {
          kind: "final",
          text: `Codex execution failed: ${error instanceof Error ? error.message : String(error)}`,
        };
      }
    } finally {
      if (this.activeTurn === controller) this.activeTurn = null;
    }
  }

  async cancel(): Promise<boolean> {
    if (!this.activeTurn) return false;
    this.activeTurn.abort();
    return true;
  }

  async close(): Promise<void> {
    this.activeTurn?.abort();
    this.activeTurn = null;
  }

  private ensureThread(workspace: RuntimeWorkspace, sandboxMode: CodexSandboxMode): CodexThreadLike {
    const additionalDirectories = [
      ...new Set([...(this.binding.additionalDirectories ?? []), ...workspace.additionalDirectories]),
    ];
    const workspaceKey = JSON.stringify({
      workingDirectory: workspace.workingDirectory,
      additionalDirectories,
      skipGitRepoCheck: workspace.skipGitRepoCheck || this.binding.skipGitRepoCheck === true,
    });
    if (this.thread) {
      if (this.threadWorkspaceKey !== workspaceKey || this.threadSandboxMode !== sandboxMode) {
        throw new Error("Codex thread options changed; invalidate the current runtime session before continuing");
      }
      return this.thread;
    }
    const options: ThreadOptions = {
      workingDirectory: workspace.workingDirectory,
      model: this.binding.model,
      sandboxMode,
      skipGitRepoCheck: workspace.skipGitRepoCheck || this.binding.skipGitRepoCheck === true,
      modelReasoningEffort: this.binding.modelReasoningEffort,
      networkAccessEnabled: this.binding.networkAccessEnabled,
      webSearchMode: this.binding.webSearchMode,
      approvalPolicy: this.binding.approvalPolicy ?? "never",
      additionalDirectories: additionalDirectories.length > 0 ? additionalDirectories : undefined,
    };
    this.thread = this.runtimeSessionId
      ? this.client.resumeThread(this.runtimeSessionId, options)
      : this.client.startThread(options);
    this.threadWorkspaceKey = workspaceKey;
    this.threadSandboxMode = sandboxMode;
    return this.thread;
  }

  private async recordRuntimeSessionId(runtimeSessionId: string): Promise<void> {
    const id = runtimeSessionId.trim();
    if (!id || id === this.runtimeSessionId) return;
    this.runtimeSessionId = id;
    await this.context.onRuntimeSessionId(id);
  }
}

function resolveSandboxMode(mode: string | undefined, configured: CodexSandboxMode | undefined): CodexSandboxMode {
  if (!mode) return configured ?? "workspace-write";
  if (SANDBOX_MODES.includes(mode as CodexSandboxMode)) return mode as CodexSandboxMode;
  throw new Error(`Codex mode must be one of: ${SANDBOX_MODES.join(", ")}`);
}

function formatStartedItem(item: ThreadItem): RuntimeOutputEvent | null {
  if (item.type === "command_execution") return { kind: "progress", text: `Codex running command: ${item.command}` };
  if (item.type === "mcp_tool_call")
    return { kind: "progress", text: `Codex calling MCP tool: ${item.server}/${item.tool}` };
  if (item.type === "web_search") return { kind: "progress", text: `Codex searching the web: ${item.query}` };
  return null;
}

function formatCompletedItem(item: ThreadItem): RuntimeOutputEvent | null {
  if (item.type === "reasoning") return { kind: "reasoning", text: item.text };
  if (item.type === "command_execution") {
    const exit = item.exit_code === undefined ? "unknown" : String(item.exit_code);
    const output = item.aggregated_output.trim();
    return {
      kind: "tool",
      text: [
        `Codex command (${item.status}, exit ${exit}):`,
        `\`${item.command}\``,
        ...(output ? ["```text", output, "```"] : []),
      ].join("\n"),
    };
  }
  if (item.type === "file_change") {
    const changes = item.changes.map((change) => `- ${change.kind}: ${change.path}`);
    return { kind: "tool", text: [`Codex file changes (${item.status}):`, ...changes].join("\n") };
  }
  if (item.type === "mcp_tool_call") {
    const details = item.error
      ? `error: ${item.error.message}`
      : item.result === undefined
        ? "no result"
        : safeJson(item.result);
    return {
      kind: "tool",
      text: [
        `Codex MCP tool (${item.status}): ${item.server}/${item.tool}`,
        `arguments: ${safeJson(item.arguments)}`,
        details,
      ].join("\n"),
    };
  }
  if (item.type === "web_search") return { kind: "tool", text: `Codex web search: ${item.query}` };
  if (item.type === "todo_list") {
    return {
      kind: "progress",
      text: ["Codex tasks:", ...item.items.map((todo) => `- [${todo.completed ? "x" : " "}] ${todo.text}`)].join("\n"),
    };
  }
  if (item.type === "error") return { kind: "final", text: `Codex item error: ${item.message}` };
  return null;
}

function formatUsage(usage: {
  input_tokens: number;
  cached_input_tokens: number;
  output_tokens: number;
  reasoning_output_tokens: number;
}): string {
  return `Codex usage: ${usage.input_tokens} input, ${usage.cached_input_tokens} cached, ${usage.output_tokens} output, ${usage.reasoning_output_tokens} reasoning tokens.`;
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2) ?? String(value);
  } catch {
    return "[unserializable]";
  }
}
