import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { getAgent } from "./config";
import type { NormalizedInboundMessage } from "./protocol";
import type { ConnectStateStore } from "./state";
import type { ConnectConfig, OutputVisibility } from "./types";

export interface ChatCommandContext {
  message: NormalizedInboundMessage;
  agentId: string;
  config: ConnectConfig;
  stateStore: ConnectStateStore;
  closeRuntimeSession?: (chatId: string) => Promise<boolean>;
  invalidateRuntimeSession?: (chatId: string) => Promise<boolean>;
  /** @deprecated Use closeRuntimeSession and invalidateRuntimeSession. */
  resetRuntimeSession?: (chatId: string) => Promise<boolean>;
  cancelRuntimeTurn?: (chatId: string) => Promise<boolean>;
}

export interface ChatCommandResult {
  handled: boolean;
  text?: string;
}

const CODEX_MODES = ["read-only", "workspace-write", "danger-full-access"] as const;
const HELP = [
  "**ClawChat Connect commands**",
  "",
  "- `/clawchat-help` — show this help.",
  "- `/clawchat-status` or `/status` — show runtime status.",
  "- `/clawchat-output minimal|normal|full` — set output visibility.",
  "- `/new [name]` — start a new session.",
  "- `/list` — list sessions.",
  "- `/switch <session>` — switch session.",
  "- `/current` — show current session.",
  "- `/dir [path|reset]` — show, set, or clear current session directory.",
  "- `/cd <path>` — compatibility alias for `/dir <path>`.",
  "- `/mode <mode>` — set the runtime mode; Codex accepts read-only, workspace-write, or danger-full-access.",
  "- `/cancel` — cancel an active turn when supported.",
].join("\n");

export async function handleChatCommand(ctx: ChatCommandContext): Promise<ChatCommandResult> {
  const text = ctx.message.text.trim();
  if (!text.startsWith("/")) return { handled: false };
  const [command = "", ...args] = text.split(/\s+/u);
  if (command === "/clawchat-help") return { handled: true, text: HELP };
  if (command === "/clawchat-output") return await handleOutput(ctx, args[0]);
  if (command === "/clawchat-status" || command === "/status") return await handleStatus(ctx);
  if (command === "/new") return await handleNew(ctx, args.join(" "));
  if (command === "/list") return await handleList(ctx);
  if (command === "/switch") return await handleSwitch(ctx, args[0]);
  if (command === "/current") return await handleCurrent(ctx);
  if (command === "/dir" || command === "/cd") return await handleDir(ctx, args.join(" "));
  if (command === "/mode") return await handleMode(ctx, args[0]);
  if (command === "/cancel") return await handleCancel(ctx);
  if (command.startsWith("/clawchat-"))
    return { handled: true, text: `Unknown ClawChat command: ${command}\n\n${HELP}` };
  return { handled: false };
}

async function handleOutput(ctx: ChatCommandContext, rawMode: string | undefined): Promise<ChatCommandResult> {
  const mode = parseOutputVisibility(rawMode);
  if (!mode) return { handled: true, text: "Usage: /clawchat-output minimal|normal|full" };
  await ctx.stateStore.setOutputVisibility(ctx.message.chatId, mode);
  const detail: Record<OutputVisibility, string> = {
    minimal: "final only",
    normal: "final and assistant-visible output",
    full: "all runtime/tool/progress/reasoning output",
  };
  return { handled: true, text: `ClawChat output visibility set to \`${mode}\` (${detail[mode]}).` };
}

async function handleStatus(ctx: ChatCommandContext): Promise<ChatCommandResult> {
  const status = await ctx.stateStore.getRuntimeStatus().catch(() => null);
  return {
    handled: true,
    text: status
      ? [
          "**ClawChat Connect status**",
          `- agent: \`${status.activeAgent ?? ctx.agentId}\``,
          `- websocket: \`${status.websocketConnected === true ? "connected" : status.websocketConnected === false ? "disconnected" : "unknown"}\``,
          `- active chats: \`${status.activeChats}\``,
          `- running turns: \`${status.globalRunning}\``,
          `- queued turns: \`${status.globalQueued}\``,
        ].join("\n")
      : `ClawChat Connect agent \`${ctx.agentId}\` is configured, but runtime status has not been recorded yet.`,
  };
}

async function handleNew(ctx: ChatCommandContext, name: string): Promise<ChatCommandResult> {
  const prior = await ctx.stateStore.getCurrentRuntimeSession(ctx.message.chatId);
  await closeRuntimeSession(ctx);
  const sessionId = randomUUID();
  await ctx.stateStore.upsertRuntimeSession({
    chatId: ctx.message.chatId,
    sessionId,
    agentId: ctx.agentId,
    name: name.trim() || null,
    cwd: prior?.cwd ?? null,
    mode: prior?.mode ?? null,
    runtimeSessionId: null,
    isCurrent: true,
  });
  return {
    handled: true,
    text: `Started new ClawChat Connect session \`${sessionId}\`${name.trim() ? ` (${name.trim()})` : ""}.`,
  };
}

async function handleList(ctx: ChatCommandContext): Promise<ChatCommandResult> {
  const sessions = await ctx.stateStore.listRuntimeSessions(ctx.message.chatId);
  if (sessions.length === 0) return { handled: true, text: "No ClawChat Connect sessions yet. Use /new to start one." };
  return {
    handled: true,
    text: [
      "**ClawChat Connect sessions**",
      "",
      ...sessions.map(
        (session) =>
          `- ${session.sessionId}${session.isCurrent ? " (current)" : ""}${session.name ? ` — ${session.name}` : ""}${session.cwd ? ` — ${session.cwd}` : " — directory not set"}`,
      ),
    ].join("\n"),
  };
}

async function handleSwitch(ctx: ChatCommandContext, sessionId: string | undefined): Promise<ChatCommandResult> {
  if (!sessionId) return { handled: true, text: "Usage: /switch <session>" };
  const sessions = await ctx.stateStore.listRuntimeSessions(ctx.message.chatId);
  if (!sessions.some((session) => session.sessionId === sessionId)) {
    return { handled: true, text: `Unknown session \`${sessionId}\`. Use /list to see sessions.` };
  }
  await closeRuntimeSession(ctx);
  const switched = await ctx.stateStore.switchRuntimeSession(ctx.message.chatId, sessionId);
  return {
    handled: true,
    text: switched
      ? `Switched to session \`${sessionId}\`.`
      : `Unknown session \`${sessionId}\`. Use /list to see sessions.`,
  };
}

async function handleCurrent(ctx: ChatCommandContext): Promise<ChatCommandResult> {
  const current = await ctx.stateStore.getCurrentRuntimeSession(ctx.message.chatId);
  if (!current) return { handled: true, text: "No current ClawChat Connect session. Use /new or /dir <path>." };
  return {
    handled: true,
    text: [
      "**Current ClawChat Connect session**",
      `- id: \`${current.sessionId}\``,
      `- agent: \`${current.agentId}\``,
      `- directory: ${current.cwd ? `\`${current.cwd}\`` : "not set"}`,
      `- mode: ${current.mode ? `\`${current.mode}\`` : "default"}`,
    ].join("\n"),
  };
}

async function handleDir(ctx: ChatCommandContext, rawPath: string): Promise<ChatCommandResult> {
  const value = rawPath.trim();
  if (!value) {
    const current = await ctx.stateStore.getCurrentRuntimeSession(ctx.message.chatId);
    return {
      handled: true,
      text: current?.cwd
        ? `Current directory: \`${current.cwd}\``
        : "No working directory set. Use `/dir /absolute/path/to/repo`.",
    };
  }
  if (value === "reset") {
    await ctx.stateStore.setCurrentSessionDirectory(ctx.message.chatId, ctx.agentId, null);
    await invalidateRuntimeSession(ctx);
    return {
      handled: true,
      text: "Cleared the current session working directory. Use `/dir /absolute/path/to/repo` before the next agent turn.",
    };
  }
  if (!value.startsWith("/")) return { handled: true, text: "Usage: /dir /absolute/path/to/repo" };
  const cwd = resolve(value);
  await ctx.stateStore.setCurrentSessionDirectory(ctx.message.chatId, ctx.agentId, cwd);
  await invalidateRuntimeSession(ctx);
  return { handled: true, text: `Current session directory set to \`${cwd}\`.` };
}

async function handleMode(ctx: ChatCommandContext, mode: string | undefined): Promise<ChatCommandResult> {
  if (!mode) return { handled: true, text: "Usage: /mode <mode>" };
  const current = await ctx.stateStore.getCurrentRuntimeSession(ctx.message.chatId);
  const agent = getAgent(ctx.config, current?.agentId || ctx.agentId);
  if (agent.kind === "codex" && !CODEX_MODES.includes(mode as (typeof CODEX_MODES)[number])) {
    return { handled: true, text: `Usage for Codex: /mode ${CODEX_MODES.join("|")}` };
  }
  await ctx.stateStore.upsertRuntimeSession({
    chatId: ctx.message.chatId,
    sessionId: current?.sessionId ?? "default",
    agentId: current?.agentId || ctx.agentId,
    runtimeSessionId: current?.runtimeSessionId ?? null,
    name: current?.name ?? null,
    cwd: current?.cwd ?? null,
    mode,
    isCurrent: true,
  });
  await invalidateRuntimeSession(ctx);
  return { handled: true, text: `Current session mode set to \`${mode}\`.` };
}

async function handleCancel(ctx: ChatCommandContext): Promise<ChatCommandResult> {
  const cancelled = await ctx.cancelRuntimeTurn?.(ctx.message.chatId).catch(() => false);
  return {
    handled: true,
    text: cancelled
      ? "Cancelled the active ClawChat Connect turn."
      : "No active cancellable ClawChat Connect turn was found.",
  };
}

async function closeRuntimeSession(ctx: ChatCommandContext): Promise<boolean> {
  return (await (ctx.closeRuntimeSession ?? ctx.resetRuntimeSession)?.(ctx.message.chatId)) ?? false;
}

async function invalidateRuntimeSession(ctx: ChatCommandContext): Promise<boolean> {
  return (await (ctx.invalidateRuntimeSession ?? ctx.resetRuntimeSession)?.(ctx.message.chatId)) ?? false;
}

function parseOutputVisibility(value: unknown): OutputVisibility | null {
  const mode = typeof value === "string" ? value.trim().toLowerCase() : "";
  return mode === "minimal" || mode === "normal" || mode === "full" ? mode : null;
}
