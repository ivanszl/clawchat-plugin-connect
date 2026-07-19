import { randomUUID } from "node:crypto";
import { getAgent } from "./config";
import type { ProjectCatalog } from "./projects";
import type { NormalizedInboundMessage } from "./protocol";
import type { ConnectStateStore } from "./state";
import type { ConnectConfig, OutputVisibility, ProjectRecord, RuntimeSessionRecord } from "./types";

export interface ChatCommandContext {
  message: NormalizedInboundMessage;
  agentId: string;
  ownerUserId: string;
  config: ConnectConfig;
  stateStore: ConnectStateStore;
  projects: ProjectCatalog;
  closeRuntimeSession?: (chatId: string) => Promise<boolean>;
  invalidateRuntimeSession?: (chatId: string) => Promise<boolean>;
  cancelRuntimeTurn?: (chatId: string) => Promise<boolean>;
}

export interface ChatCommandResult {
  handled: boolean;
  text?: string;
}

const CODEX_MODES = ["read-only", "workspace-write", "danger-full-access"] as const;
const CONTROL_COMMANDS = new Set([
  "/clawchat-output",
  "/clawchat-status",
  "/status",
  "/new",
  "/list",
  "/switch",
  "/current",
  "/project",
  "/mode",
  "/cancel",
]);
const HELP = [
  "**ClawChat Connect commands**",
  "",
  "- `/clawchat-help` — show this help.",
  "- `/clawchat-status` or `/status` — show runtime status.",
  "- `/clawchat-output minimal|normal|full` — set output visibility.",
  "- `/new [name]` — start a new Session using the current Project.",
  "- `/list` — list Sessions.",
  "- `/switch <session>` — switch Session.",
  "- `/current` — show the current Session.",
  "- `/project add <name> <absolute-path>` — register a Project.",
  "- `/project list` — list Projects.",
  "- `/project use <name-or-id>` — start a new Session for a Project.",
  "- `/project current` — show the current Project.",
  "- `/project clear` — start a new Non-Project Session.",
  "- `/project remove <name-or-id>` — remove an unused Project.",
  "- `/mode <mode>` — set the runtime mode; Codex accepts read-only, workspace-write, or danger-full-access.",
  "- `/cancel` — cancel an active turn when supported.",
].join("\n");

export async function handleChatCommand(ctx: ChatCommandContext): Promise<ChatCommandResult> {
  const text = ctx.message.text.trim();
  if (!text.startsWith("/")) return { handled: false };
  const [command = "", ...args] = text.split(/\s+/u);
  if (command === "/clawchat-help") return { handled: true, text: HELP };
  if (CONTROL_COMMANDS.has(command) && ctx.message.sender.id !== ctx.ownerUserId) {
    return { handled: true, text: "Only the Agent Binding owner can run ClawChat Connect control commands." };
  }
  if (command === "/clawchat-output") return await handleOutput(ctx, args[0]);
  if (command === "/clawchat-status" || command === "/status") return await handleStatus(ctx);
  if (command === "/new") return await handleNew(ctx, args.join(" "));
  if (command === "/list") return await handleList(ctx);
  if (command === "/switch") return await handleSwitch(ctx, args[0]);
  if (command === "/current") return await handleCurrent(ctx);
  if (command === "/project") return await handleProject(ctx, args);
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
  const prior = await ctx.stateStore.getCurrentRuntimeSession(ctx.message.chatId, ctx.agentId);
  await closeRuntimeSession(ctx);
  const session = await createSession(ctx, {
    projectId: prior?.projectId ?? null,
    mode: prior?.mode ?? null,
    name: name.trim() || null,
  });
  return {
    handled: true,
    text: `Started new ClawChat Connect Session \`${session.sessionId}\`${session.name ? ` (${session.name})` : ""}.`,
  };
}

async function handleList(ctx: ChatCommandContext): Promise<ChatCommandResult> {
  const sessions = await ctx.stateStore.listRuntimeSessions(ctx.message.chatId, ctx.agentId);
  if (sessions.length === 0) return { handled: true, text: "No ClawChat Connect Sessions yet. Use /new to start one." };
  const projects = new Map((await ctx.projects.list()).map((project) => [project.projectId, project]));
  return {
    handled: true,
    text: [
      "**ClawChat Connect Sessions**",
      "",
      ...sessions.map((session) => {
        const project = session.projectId ? projects.get(session.projectId) : null;
        const projectText = project ? `Project ${project.name}` : "Non-Project";
        return `- ${session.sessionId}${session.isCurrent ? " (current)" : ""}${session.name ? ` — ${session.name}` : ""} — ${projectText}`;
      }),
    ].join("\n"),
  };
}

async function handleSwitch(ctx: ChatCommandContext, sessionId: string | undefined): Promise<ChatCommandResult> {
  if (!sessionId) return { handled: true, text: "Usage: /switch <session>" };
  const sessions = await ctx.stateStore.listRuntimeSessions(ctx.message.chatId, ctx.agentId);
  if (!sessions.some((session) => session.sessionId === sessionId)) {
    return { handled: true, text: `Unknown Session \`${sessionId}\`. Use /list to see Sessions.` };
  }
  await closeRuntimeSession(ctx);
  const switched = await ctx.stateStore.switchRuntimeSession(ctx.message.chatId, ctx.agentId, sessionId);
  return {
    handled: true,
    text: switched
      ? `Switched to Session \`${sessionId}\`.`
      : `Unknown Session \`${sessionId}\`. Use /list to see Sessions.`,
  };
}

async function handleCurrent(ctx: ChatCommandContext): Promise<ChatCommandResult> {
  const current = await ctx.stateStore.getCurrentRuntimeSession(ctx.message.chatId, ctx.agentId);
  if (!current) return { handled: true, text: "No current ClawChat Connect Session. Use /new to start one." };
  const project = current.projectId ? await ctx.projects.get(current.projectId) : null;
  return {
    handled: true,
    text: [
      "**Current ClawChat Connect Session**",
      `- id: \`${current.sessionId}\``,
      `- agent: \`${current.agentId}\``,
      `- project: ${project ? `\`${project.name}\` (${project.rootPath})` : "none (isolated workspace)"}`,
      `- mode: ${current.mode ? `\`${current.mode}\`` : "default"}`,
    ].join("\n"),
  };
}

async function handleProject(ctx: ChatCommandContext, args: string[]): Promise<ChatCommandResult> {
  const action = args[0]?.toLowerCase();
  try {
    if (action === "add") {
      const name = args[1] ?? "";
      const rootPath = args.slice(2).join(" ");
      if (!name || !rootPath) return { handled: true, text: "Usage: /project add <name> <absolute-path>" };
      const project = await ctx.projects.add(name, rootPath);
      return {
        handled: true,
        text: `Registered Project \`${project.name}\` (${project.projectId}) at \`${project.rootPath}\`.`,
      };
    }
    if (action === "list") {
      const projects = await ctx.projects.list();
      return {
        handled: true,
        text:
          projects.length > 0
            ? ["**ClawChat Connect Projects**", "", ...projects.map(formatProject)].join("\n")
            : "No Projects registered. Use /project add <name> <absolute-path>.",
      };
    }
    if (action === "use") {
      const reference = args.slice(1).join(" ").trim();
      if (!reference) return { handled: true, text: "Usage: /project use <name-or-id>" };
      const project = await ctx.projects.require(reference);
      const prior = await ctx.stateStore.getCurrentRuntimeSession(ctx.message.chatId, ctx.agentId);
      await closeRuntimeSession(ctx);
      const session = await createSession(ctx, { projectId: project.projectId, mode: prior?.mode ?? null });
      return {
        handled: true,
        text: `Started Session \`${session.sessionId}\` for Project \`${project.name}\` at \`${project.rootPath}\`.`,
      };
    }
    if (action === "current") {
      const current = await ctx.stateStore.getCurrentRuntimeSession(ctx.message.chatId, ctx.agentId);
      const project = current?.projectId ? await ctx.projects.get(current.projectId) : null;
      return {
        handled: true,
        text: project
          ? `Current Project: \`${project.name}\` (${project.projectId}) at \`${project.rootPath}\`.`
          : "Current Session is a Non-Project Session with an isolated workspace.",
      };
    }
    if (action === "clear") {
      const prior = await ctx.stateStore.getCurrentRuntimeSession(ctx.message.chatId, ctx.agentId);
      await closeRuntimeSession(ctx);
      const session = await createSession(ctx, { projectId: null, mode: prior?.mode ?? null });
      return {
        handled: true,
        text: `Started Non-Project Session \`${session.sessionId}\` with an isolated workspace.`,
      };
    }
    if (action === "remove") {
      const reference = args.slice(1).join(" ").trim();
      if (!reference) return { handled: true, text: "Usage: /project remove <name-or-id>" };
      const result = await ctx.projects.remove(reference);
      return {
        handled: true,
        text: result.removed
          ? `Removed Project \`${result.project.name}\`.`
          : `Cannot remove Project \`${result.project.name}\`: ${result.referencedSessions} Session(s) still reference it.`,
      };
    }
  } catch (error) {
    return { handled: true, text: `Project command failed: ${error instanceof Error ? error.message : String(error)}` };
  }
  return {
    handled: true,
    text: "Usage: /project add|list|use|current|clear|remove",
  };
}

async function handleMode(ctx: ChatCommandContext, mode: string | undefined): Promise<ChatCommandResult> {
  if (!mode) return { handled: true, text: "Usage: /mode <mode>" };
  const current = await ctx.stateStore.getCurrentRuntimeSession(ctx.message.chatId, ctx.agentId);
  const agent = getAgent(ctx.config, current?.agentId || ctx.agentId);
  if (agent.kind === "codex" && !CODEX_MODES.includes(mode as (typeof CODEX_MODES)[number])) {
    return { handled: true, text: `Usage for Codex: /mode ${CODEX_MODES.join("|")}` };
  }
  await ctx.stateStore.upsertRuntimeSession({
    chatId: ctx.message.chatId,
    sessionId: current?.sessionId ?? randomUUID(),
    agentId: current?.agentId || ctx.agentId,
    runtimeSessionId: current?.runtimeSessionId ?? null,
    projectId: current?.projectId ?? null,
    name: current?.name ?? null,
    mode,
    isCurrent: true,
  });
  await invalidateRuntimeSession(ctx);
  return { handled: true, text: `Current Session mode set to \`${mode}\`.` };
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

async function createSession(
  ctx: ChatCommandContext,
  values: { projectId: string | null; mode: string | null; name?: string | null },
): Promise<RuntimeSessionRecord> {
  const sessionId = randomUUID();
  await ctx.stateStore.upsertRuntimeSession({
    chatId: ctx.message.chatId,
    sessionId,
    agentId: ctx.agentId,
    runtimeSessionId: null,
    projectId: values.projectId,
    name: values.name ?? null,
    mode: values.mode,
    isCurrent: true,
  });
  const session = await ctx.stateStore.getCurrentRuntimeSession(ctx.message.chatId, ctx.agentId);
  if (!session) throw new Error("failed to create Session");
  return session;
}

function formatProject(project: ProjectRecord): string {
  return `- ${project.name} (${project.projectId}) — ${project.rootPath}`;
}

async function closeRuntimeSession(ctx: ChatCommandContext): Promise<boolean> {
  return (await ctx.closeRuntimeSession?.(ctx.message.chatId)) ?? false;
}

async function invalidateRuntimeSession(ctx: ChatCommandContext): Promise<boolean> {
  return (await ctx.invalidateRuntimeSession?.(ctx.message.chatId)) ?? false;
}

function parseOutputVisibility(value: unknown): OutputVisibility | null {
  const mode = typeof value === "string" ? value.trim().toLowerCase() : "";
  return mode === "minimal" || mode === "normal" || mode === "full" ? mode : null;
}
