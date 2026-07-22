import { randomUUID } from "node:crypto";
import { getAgentBinding } from "./config";
import type { ProjectCatalog } from "./projects";
import type { NormalizedInboundMessage } from "./protocol";
import type { SelectableRuntimeThread } from "./runtime/types";
import type { ConnectStateStore } from "./state";
import type {
  AgentBindingConfig,
  ConnectConfig,
  OutputVisibility,
  ProjectRecord,
  RuntimeSessionRecord,
  SessionIntentRecord,
} from "./types";

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
  runtimeModesFor?: (binding: AgentBindingConfig) => readonly string[];
  discoverRuntimeThreads?: (chatId: string) => Promise<SelectableRuntimeThread[]>;
}

export interface ChatCommandResult {
  handled: boolean;
  text?: string;
}

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
  "- `/help` — show this help.",
  "- `/clawchat-status` or `/status` — show runtime status.",
  "- `/clawchat-output minimal|normal|full` — set output visibility.",
  "- `/new [name]` — prepare a new Session for the next message using the selected Project.",
  "- `/list` — list Sessions.",
  "- `/switch <name-or-ref>` — switch or import a Session by name or 8-character Ref.",
  "- `/current` — show the current Session.",
  "- `/project add <name> <absolute-path>` — register a Project.",
  "- `/project list` — list Projects.",
  "- `/project use <name-or-id>` — select a Project for the next Session.",
  "- `/project current` — show the current Project.",
  "- `/project clear` — select an isolated workspace for the next Session.",
  "- `/project remove <name-or-id>` — remove an unused Project.",
  "- `/mode <mode>` — set one of the modes exposed by the selected Runtime Adapter.",
  "- `/cancel` — cancel an active turn when supported.",
].join("\n");

export async function handleChatCommand(ctx: ChatCommandContext): Promise<ChatCommandResult> {
  const text = ctx.message.text.trim();
  if (!text.startsWith("/")) return { handled: false };
  const [command = "", ...args] = text.split(/\s+/u);
  if (command === "/help") return { handled: true, text: HELP };
  if (CONTROL_COMMANDS.has(command) && ctx.message.sender.id !== ctx.ownerUserId) {
    return { handled: true, text: "Only the Agent Binding owner can run ClawChat Connect control commands." };
  }
  if (command === "/clawchat-output") return await handleOutput(ctx, args[0]);
  if (command === "/clawchat-status" || command === "/status") return await handleStatus(ctx);
  if (command === "/new") return await handleNew(ctx, args.join(" "));
  if (command === "/list") return await handleList(ctx);
  if (command === "/switch") return await handleSwitch(ctx, args.join(" "));
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
  const status = await ctx.stateStore.getRuntimeStatus(ctx.agentId).catch(() => null);
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
  const selected = await selectedSessionContext(ctx);
  await closeRuntimeSession(ctx);
  await ctx.stateStore.setSessionIntent({
    chatId: ctx.message.chatId,
    agentId: ctx.agentId,
    projectId: selected?.projectId ?? null,
    mode: selected?.mode ?? null,
    name: name.trim() || null,
  });
  return {
    handled: true,
    text: `The next message will start${name.trim() ? ` Session \`${name.trim()}\`` : " a new Session"}.`,
  };
}

async function handleList(ctx: ChatCommandContext): Promise<ChatCommandResult> {
  const intent = await ctx.stateStore.getSessionIntent(ctx.message.chatId, ctx.agentId);
  const discovered = (await ctx.discoverRuntimeThreads?.(ctx.message.chatId)) ?? [];
  const sessions = sessionsInCurrentWorkspace(
    await ctx.stateStore.listRuntimeSessions(ctx.message.chatId, ctx.agentId),
    intent,
  );
  if (sessions.length === 0 && discovered.length === 0)
    return {
      handled: true,
      text: intent
        ? "No Sessions in the selected workspace. Send a message to start one."
        : "No ClawChat Connect Sessions yet. Send a message to start one.",
    };
  const projects = new Map((await ctx.projects.list()).map((project) => [project.projectId, project]));
  return {
    handled: true,
    text: [
      "**ClawChat Connect Sessions**",
      "",
      ...sessions.map((session) => formatSession(session, session.projectId ? projects.get(session.projectId) : null)),
      ...discovered.map(
        (thread) => `- ${runtimeThreadLabel(thread)} · \`${thread.sessionRef}\` (available) — Runtime Thread`,
      ),
    ].join("\n"),
  };
}

async function handleSwitch(ctx: ChatCommandContext, rawReference: string | undefined): Promise<ChatCommandResult> {
  const reference = rawReference?.trim() ?? "";
  if (!reference) return { handled: true, text: "Usage: /switch <name-or-ref>" };
  const discovered = (await ctx.discoverRuntimeThreads?.(ctx.message.chatId)) ?? [];
  const sessions = await ctx.stateStore.listRuntimeSessions(ctx.message.chatId, ctx.agentId);
  const matches = matchingSessions(sessions, reference);
  if (matches.length > 1) return { handled: true, text: ambiguousSessionText(reference, matches) };
  const matched = matches[0];
  if (matched) {
    await closeRuntimeSession(ctx);
    const switched = await ctx.stateStore.switchRuntimeSession(ctx.message.chatId, ctx.agentId, matched.sessionId);
    return {
      handled: true,
      text: switched
        ? `Switched to Session \`${sessionLabel(matched)}\` (\`${matched.sessionRef}\`).`
        : `Unknown Session \`${reference}\`. Use /list to see Sessions.`,
    };
  }

  const threadMatches = matchingRuntimeThreads(discovered, reference);
  if (threadMatches.length > 1) return { handled: true, text: ambiguousRuntimeThreadText(reference, threadMatches) };
  const thread = threadMatches[0];
  if (!thread) return { handled: true, text: `Unknown Session \`${reference}\`. Use /list to see Sessions.` };
  const selected = await selectedSessionContext(ctx);
  if (!selected) return { handled: true, text: "Select a Project before importing a Runtime Thread." };
  await closeRuntimeSession(ctx);
  await ctx.stateStore.upsertRuntimeSession({
    chatId: ctx.message.chatId,
    sessionId: randomUUID(),
    agentId: ctx.agentId,
    runtimeSessionId: thread.runtimeThreadId,
    projectId: selected.projectId,
    name: thread.name,
    mode: selected.mode,
    hasMessages: true,
    isCurrent: true,
  });
  return {
    handled: true,
    text: `Imported and switched to Runtime Thread \`${runtimeThreadLabel(thread)}\` (\`${thread.sessionRef}\`).`,
  };
}

async function handleCurrent(ctx: ChatCommandContext): Promise<ChatCommandResult> {
  const intent = await ctx.stateStore.getSessionIntent(ctx.message.chatId, ctx.agentId);
  if (intent) {
    const project = intent.projectId ? await ctx.projects.get(intent.projectId) : null;
    return {
      handled: true,
      text: [
        "**Next Session (not started)**",
        `- name: ${intent.name ? `\`${intent.name}\`` : "automatic from the first message"}`,
        `- agent: \`${intent.agentId}\``,
        `- project: ${project ? `\`${project.name}\` (${project.rootPath})` : "none (isolated workspace)"}`,
        `- mode: ${intent.mode ? `\`${intent.mode}\`` : "default"}`,
      ].join("\n"),
    };
  }
  const current = await ctx.stateStore.getCurrentRuntimeSession(ctx.message.chatId, ctx.agentId);
  if (!current) return { handled: true, text: "No current Session. Send a message to start one." };
  const project = current.projectId ? await ctx.projects.get(current.projectId) : null;
  return {
    handled: true,
    text: [
      "**Current ClawChat Connect Session**",
      `- session: \`${sessionLabel(current)}\``,
      `- ref: \`${current.sessionRef}\``,
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
      const selected = await selectedSessionContext(ctx);
      await closeRuntimeSession(ctx);
      await ctx.stateStore.setSessionIntent({
        chatId: ctx.message.chatId,
        agentId: ctx.agentId,
        projectId: project.projectId,
        name: selected?.name ?? null,
        mode: selected?.mode ?? null,
      });
      return {
        handled: true,
        text: `Selected Project \`${project.name}\` at \`${project.rootPath}\`; the next message will start a Session.`,
      };
    }
    if (action === "current") {
      const intent = await ctx.stateStore.getSessionIntent(ctx.message.chatId, ctx.agentId);
      if (intent) {
        const project = intent.projectId ? await ctx.projects.get(intent.projectId) : null;
        return {
          handled: true,
          text: project
            ? `Next Session Project: \`${project.name}\` (${project.projectId}) at \`${project.rootPath}\`.`
            : "Next Session will use an isolated Non-Project workspace.",
        };
      }
      const current = await ctx.stateStore.getCurrentRuntimeSession(ctx.message.chatId, ctx.agentId);
      if (!current) {
        return {
          handled: true,
          text: "No current Session or pending Project selection. Send a message to start a Non-Project Session.",
        };
      }
      const project = current?.projectId ? await ctx.projects.get(current.projectId) : null;
      return {
        handled: true,
        text: project
          ? `Current Project: \`${project.name}\` (${project.projectId}) at \`${project.rootPath}\`.`
          : "Current Session is a Non-Project Session with an isolated workspace.",
      };
    }
    if (action === "clear") {
      const selected = await selectedSessionContext(ctx);
      await closeRuntimeSession(ctx);
      await ctx.stateStore.setSessionIntent({
        chatId: ctx.message.chatId,
        agentId: ctx.agentId,
        projectId: null,
        name: selected?.name ?? null,
        mode: selected?.mode ?? null,
      });
      return {
        handled: true,
        text: "Selected an isolated Non-Project workspace; the next message will start a Session.",
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
          : `Cannot remove Project \`${result.project.name}\`: ${result.referencedSessions} Session(s) and ${result.pendingIntents} Session Intent(s) still reference it.`,
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
  const intent = await ctx.stateStore.getSessionIntent(ctx.message.chatId, ctx.agentId);
  const current = await ctx.stateStore.getCurrentRuntimeSession(ctx.message.chatId, ctx.agentId);
  const binding = getAgentBinding(ctx.config, current?.agentId || intent?.agentId || ctx.agentId);
  if (ctx.runtimeModesFor) {
    const modes = ctx.runtimeModesFor(binding);
    if (modes.length === 0)
      return { handled: true, text: `Runtime ${binding.kind} does not support configurable modes.` };
    if (!modes.includes(mode)) {
      return { handled: true, text: `Usage for ${binding.kind}: /mode ${modes.join("|")}` };
    }
  }
  if (intent || !current) {
    await ctx.stateStore.setSessionIntent({
      chatId: ctx.message.chatId,
      agentId: intent?.agentId || ctx.agentId,
      projectId: intent?.projectId ?? null,
      name: intent?.name ?? null,
      mode,
    });
    return { handled: true, text: `Next Session mode set to \`${mode}\`.` };
  }
  await ctx.stateStore.upsertRuntimeSession({
    chatId: ctx.message.chatId,
    sessionId: current?.sessionId ?? randomUUID(),
    agentId: current?.agentId || ctx.agentId,
    runtimeSessionId: current?.runtimeSessionId ?? null,
    projectId: current?.projectId ?? null,
    name: current?.name ?? null,
    mode,
    hasMessages: current?.hasMessages ?? true,
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

function formatProject(project: ProjectRecord): string {
  return `- ${project.name} (${project.projectId}) — ${project.rootPath}`;
}

function formatSession(session: RuntimeSessionRecord, project: ProjectRecord | null | undefined): string {
  const projectText = project ? `Project ${project.name}` : "Non-Project";
  return `- ${sessionLabel(session)} · \`${session.sessionRef}\`${session.isCurrent ? " (current)" : ""} — ${projectText}`;
}

function sessionLabel(session: RuntimeSessionRecord): string {
  return session.name?.trim() || "Unnamed Session";
}

function runtimeThreadLabel(thread: SelectableRuntimeThread): string {
  return thread.name?.trim() || "Unnamed Runtime Thread";
}

function sessionsInCurrentWorkspace(
  sessions: RuntimeSessionRecord[],
  intent: SessionIntentRecord | null,
): RuntimeSessionRecord[] {
  const materialized = sessions.filter((session) => session.hasMessages);
  if (intent) {
    if (!intent.projectId) return [];
    return materialized.filter((session) => session.projectId === intent.projectId);
  }
  const current = materialized.find((session) => session.isCurrent);
  if (!current) return [];
  if (!current.projectId) return [current];
  return materialized.filter((session) => session.projectId === current.projectId);
}

async function selectedSessionContext(
  ctx: ChatCommandContext,
): Promise<SessionIntentRecord | RuntimeSessionRecord | null> {
  return (
    (await ctx.stateStore.getSessionIntent(ctx.message.chatId, ctx.agentId)) ??
    (await ctx.stateStore.getCurrentRuntimeSession(ctx.message.chatId, ctx.agentId))
  );
}

function matchingSessions(sessions: RuntimeSessionRecord[], reference: string): RuntimeSessionRecord[] {
  const normalized = reference.toLowerCase();
  const exact = sessions.filter(
    (session) => session.sessionRef.toLowerCase() === normalized || session.name?.trim().toLowerCase() === normalized,
  );
  return exact;
}

function matchingRuntimeThreads(threads: SelectableRuntimeThread[], reference: string): SelectableRuntimeThread[] {
  const normalized = reference.toLowerCase();
  const exact = threads.filter(
    (thread) => thread.sessionRef.toLowerCase() === normalized || thread.name?.trim().toLowerCase() === normalized,
  );
  return exact;
}

function ambiguousSessionText(reference: string, sessions: RuntimeSessionRecord[]): string {
  return `Session \`${reference}\` is ambiguous. Use a Ref: ${sessions.map((session) => session.sessionRef).join(", ")}`;
}

function ambiguousRuntimeThreadText(reference: string, threads: SelectableRuntimeThread[]): string {
  return `Runtime Thread \`${reference}\` is ambiguous. Use a Ref: ${threads
    .map((thread) => thread.sessionRef)
    .join(", ")}`;
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
