import { randomUUID } from "node:crypto";
import { getAgentBinding } from "../config";
import type { ConnectStateStore } from "../persistence/state";
import type { ProjectCatalog } from "../projects/projects";
import { createSessionContinuity, type SessionContinuity } from "../projects/session-continuity";
import { type RuntimeWorkspaceChoice, workspaceView } from "../projects/workspace-catalog";
import { requireModel, resolveEffort, resolveModelSelection } from "../runtime/model-selection";
import type { RuntimeModelOption, SelectableRuntimeThread } from "../runtime/types";
import { workBuddyRuntimeTargetKind } from "../runtime/workbuddy-runtime-target";
import type {
  AgentBindingConfig,
  ConnectConfig,
  OutputVisibility,
  ProjectRecord,
  RuntimeSessionRecord,
  SessionIntentRecord,
} from "../types";
import { runtimeFamilyFor } from "../types";
import { commandAddressPrefix } from "./message-mapper";
import type { NormalizedInboundMessage } from "./protocol";

export interface ChatCommandContext {
  message: NormalizedInboundMessage;
  agentId: string;
  ownerUserId: string;
  config: ConnectConfig;
  stateStore: ConnectStateStore;
  projects: ProjectCatalog;
  sessionContinuity?: SessionContinuity;
  closeRuntimeSession?: (chatId: string) => Promise<boolean>;
  invalidateRuntimeSession?: (chatId: string) => Promise<boolean>;
  cancelRuntimeTurn?: (chatId: string) => Promise<boolean>;
  runtimeModesFor?: (
    binding: AgentBindingConfig,
    selected?: RuntimeSessionRecord | SessionIntentRecord | null,
  ) => readonly string[];
  listRuntimeModels?: (
    binding: AgentBindingConfig,
    selected?: RuntimeSessionRecord | SessionIntentRecord | null,
  ) => Promise<RuntimeModelOption[] | null>;
  discoverRuntimeThreads?: (chatId: string) => Promise<SelectableRuntimeThread[]>;
  listRuntimeWorkspaces?: () => Promise<RuntimeWorkspaceChoice[]>;
}

export interface ChatCommandResult {
  handled: boolean;
  text?: string;
}

const CONTROL_COMMANDS = new Set([
  "/clawchat-output",
  "/status",
  "/new",
  "/sessions",
  "/switch",
  "/project",
  "/mode",
  "/model",
  "/cancel",
]);
const REMOVED_COMMANDS = new Set(["/clawchat-status", "/list", "/current"]);
const COMMAND_USAGE = new Map([
  ["/help", "/help"],
  ["/status", "/status"],
  ["/clawchat-output", "/clawchat-output minimal|normal|full"],
  ["/new", "/new [name]"],
  ["/sessions", "/sessions"],
  ["/switch", "/switch <name-or-ref>"],
  ["/project", "/project [workspace-id|none]"],
  ["/mode", "/mode [mode|default]"],
  ["/model", "/model [model-id [reasoning-effort]|default]"],
  ["/cancel", "/cancel"],
]);
function helpText(chatType: NormalizedInboundMessage["chatType"]): string {
  const prefix = commandAddressPrefix(chatType);
  return [
    "**ClawChat Connect commands**",
    "",
    `- \`${prefix}/help\` — show this help.`,
    `- \`${prefix}/status\` — show runtime and current Session status (Binding Owner only).`,
    `- \`${prefix}/clawchat-output minimal|normal|full\` — set output visibility (Binding Owner only).`,
    `- \`${prefix}/new [name]\` — prepare a new Session for the next message (Binding Owner only).`,
    `- \`${prefix}/sessions\` — list Sessions in the selected workspace (Binding Owner only).`,
    `- \`${prefix}/switch <name-or-ref>\` — switch or import a Session (Binding Owner only).`,
    `- \`${prefix}/project [workspace-id|none]\` — inspect or select the next Project (Binding Owner only).`,
    `- \`${prefix}/model [model-id [reasoning-effort]|default]\` — inspect or select the model (Binding Owner only).`,
    `- \`${prefix}/mode [mode|default]\` — inspect or select the runtime mode (Binding Owner only).`,
    `- \`${prefix}/cancel\` — cancel an active turn when supported (Binding Owner only).`,
    "",
    "**Runtime Interaction responses (only when requested)**",
    "",
    `- \`${prefix}/approve\`, \`${prefix}/approve session\`, or \`${prefix}/deny\`.`,
    `- \`${prefix}/N\` — select a numbered option.`,
    `- \`${prefix}/answer <text>\` — answer a non-secret free-text question.`,
  ].join("\n");
}

export function isConnectControlMessage(text: string): boolean {
  const [command = ""] = text.trim().split(/\s+/u);
  return (
    command === "/help" ||
    CONTROL_COMMANDS.has(command) ||
    REMOVED_COMMANDS.has(command) ||
    command.startsWith("/clawchat-")
  );
}

/** Commands that change which Session or turn settings a following message observes. */
export function requiresOrderedSessionControl(text: string): boolean {
  const [command = "", ...args] = text.trim().split(/\s+/u);
  if (command === "/new") return true;
  if (command === "/switch") return args.length > 0;
  if (command === "/project") {
    const legacyAction = args[0]?.toLowerCase();
    return args.length > 0 && !["add", "list", "use", "current", "clear", "remove"].includes(legacyAction ?? "");
  }
  if (command === "/model" || command === "/mode") return args.length > 0;
  return false;
}

export async function handleChatCommand(ctx: ChatCommandContext): Promise<ChatCommandResult> {
  const text = ctx.message.text.trim();
  if (!text.startsWith("/")) return { handled: false };
  const [command = "", ...args] = text.split(/\s+/u);
  const invalidUsage = invalidCommandUsage(ctx.message, command, args);
  if (invalidUsage) return { handled: true, text: invalidUsage };
  if (command === "/help") return { handled: true, text: helpText(ctx.message.chatType) };
  if (CONTROL_COMMANDS.has(command) && ctx.message.sender.id !== ctx.ownerUserId) {
    return { handled: true, text: "Only the Agent Binding owner can run ClawChat Connect control commands." };
  }
  if (command === "/clawchat-output") return await handleOutput(ctx, args[0]);
  if (command === "/status") return await handleStatus(ctx);
  if (command === "/new") return await handleNew(ctx, args.join(" "));
  if (command === "/sessions") return await handleList(ctx);
  if (command === "/switch") return await handleSwitch(ctx, args.join(" "));
  if (command === "/project") return await handleProject(ctx, args);
  if (command === "/mode") return await handleMode(ctx, args[0]);
  if (command === "/model") return await handleModel(ctx, args);
  if (command === "/cancel") return await handleCancel(ctx);
  if (COMMAND_USAGE.has(command.toLowerCase())) return { handled: false };
  if (REMOVED_COMMANDS.has(command))
    return { handled: true, text: `Unknown Connect command: ${command}\n\n${helpText(ctx.message.chatType)}` };
  if (command.startsWith("/clawchat-"))
    return { handled: true, text: `Unknown ClawChat command: ${command}\n\n${helpText(ctx.message.chatType)}` };
  return { handled: false };
}

function commandUsage(chatType: NormalizedInboundMessage["chatType"], command: string): string {
  return `Usage: ${commandAddressPrefix(chatType)}${COMMAND_USAGE.get(command) ?? command}`;
}

function invalidCommandUsage(message: NormalizedInboundMessage, command: string, args: string[]): string | null {
  if (!COMMAND_USAGE.has(command)) return null;
  if (/[\r\n]/u.test(message.text)) return commandUsage(message.chatType, command);
  if (message.fragments.some((fragment) => ["image", "file", "audio", "video"].includes(fragment.kind))) {
    return commandUsage(message.chatType, command);
  }
  const valid =
    command === "/new" ||
    (["/help", "/status", "/sessions", "/cancel"].includes(command) && args.length === 0) ||
    (command === "/clawchat-output" && args.length === 1 && parseOutputVisibility(args[0]) !== null) ||
    (command === "/switch" && args.length >= 1) ||
    (command === "/project" && args.length <= 1) ||
    (command === "/mode" && args.length <= 1) ||
    (command === "/model" && args.length <= 2 && (args[0]?.toLowerCase() !== "default" || args.length === 1));
  return valid ? null : commandUsage(message.chatType, command);
}

async function handleOutput(ctx: ChatCommandContext, rawMode: string | undefined): Promise<ChatCommandResult> {
  const mode = parseOutputVisibility(rawMode);
  if (!mode) return { handled: true, text: commandUsage(ctx.message.chatType, "/clawchat-output") };
  await ctx.stateStore.setOutputVisibility(ctx.agentId, ctx.message.chatId, mode);
  const detail: Record<OutputVisibility, string> = {
    minimal: "final only",
    normal: "final and assistant-visible output",
    full: "all runtime/tool/progress/reasoning output",
  };
  return { handled: true, text: `ClawChat output visibility set to \`${mode}\` (${detail[mode]}).` };
}

async function handleStatus(ctx: ChatCommandContext): Promise<ChatCommandResult> {
  const status = await ctx.stateStore.getRuntimeStatus(ctx.agentId).catch(() => null);
  const selected = await selectedSessionContext(ctx);
  const project = selected?.projectId ? await ctx.projects.get(selected.projectId) : null;
  const binding = getAgentBinding(ctx.config, selected?.agentId ?? ctx.agentId);
  const models = (await ctx.listRuntimeModels?.(binding, selected).catch(() => null)) ?? null;
  let modelText = binding.model ?? "runtime default";
  let effortText = binding.modelReasoningEffort ?? "runtime default";
  let source = binding.model ? "binding" : "runtime";
  try {
    if (selected) {
      const effective = resolveModelSelection(binding, selected, models);
      modelText = effective.model ?? "runtime default";
      effortText = effective.reasoningEffort ?? "runtime default";
      source = effective.source;
    }
  } catch (error) {
    modelText = `${selected?.model ?? binding.model ?? "unknown"} (unavailable: ${error instanceof Error ? error.message : String(error)})`;
    effortText = selected?.reasoningEffort ?? binding.modelReasoningEffort ?? "unknown";
    source = selected?.model ? "session" : "binding";
  }
  return {
    handled: true,
    text: [
      "**ClawChat Connect status**",
      `- agent: \`${status?.activeAgent ?? ctx.agentId}\``,
      `- websocket: \`${status?.websocketConnected === true ? "connected" : status?.websocketConnected === false ? "disconnected" : "unknown"}\``,
      `- session: ${selected ? `${"sessionRef" in selected ? `\`${selected.sessionRef}\`` : "next Session (not started)"}${selected.name ? ` · ${selected.name}` : ""}` : "none"}`,
      ...(binding.kind === "workbuddy"
        ? [
            `- runtime target: ${
              selected &&
              "runtimeSessionId" in selected &&
              workBuddyRuntimeTargetKind(selected.runtimeSessionId) === "workbuddy-task"
                ? "WorkBuddy Task · desktop-synchronized"
                : "CodeBuddy Session · not shown in WorkBuddy Desktop"
            }`,
          ]
        : []),
      `- project: ${project ? `\`${project.name}\`` : "none (isolated workspace)"}`,
      `- mode: \`${selected?.mode ?? binding.sandboxMode ?? "runtime default"}\``,
      `- model: \`${modelText}\` · effort \`${effortText}\` (${source})`,
      `- active chats: \`${status?.activeChats ?? 0}\``,
      `- running turns: \`${status?.globalRunning ?? 0}\``,
      `- queued turns: \`${status?.globalQueued ?? 0}\``,
    ].join("\n"),
  };
}

async function handleNew(ctx: ChatCommandContext, name: string): Promise<ChatCommandResult> {
  const binding = getAgentBinding(ctx.config, ctx.agentId);
  const selected = await selectedSessionContext(ctx);
  await closeRuntimeSession(ctx);
  await continuityFor(ctx)
    .inConversation({ chatId: ctx.message.chatId, bindingId: ctx.agentId })
    .planNext({
      projectId: selected?.projectId ?? null,
      mode: selected?.mode ?? null,
      model: selected?.model ?? null,
      reasoningEffort: selected?.reasoningEffort ?? null,
      name: name.trim() || null,
    });
  return {
    handled: true,
    text:
      binding.kind === "workbuddy"
        ? `The next message will start${name.trim() ? ` CodeBuddy Session \`${name.trim()}\`` : " a new CodeBuddy Session"}. It will not appear in WorkBuddy Desktop; use \`/sessions\` and \`/switch <session-ref>\` for a desktop-synchronized WorkBuddy Task.`
        : `The next message will start${name.trim() ? ` Session \`${name.trim()}\`` : " a new Session"}.`,
  };
}

async function handleList(ctx: ChatCommandContext): Promise<ChatCommandResult> {
  const binding = getAgentBinding(ctx.config, ctx.agentId);
  const intent = await ctx.stateStore.getSessionIntent(ctx.message.chatId, ctx.agentId);
  const discovered = (await ctx.discoverRuntimeThreads?.(ctx.message.chatId)) ?? [];
  const sessions = sessionsInCurrentWorkspace(
    await ctx.stateStore.listRuntimeSessions(ctx.message.chatId, ctx.agentId),
    intent,
    binding.kind === "workbuddy",
  );
  if (sessions.length === 0 && discovered.length === 0) {
    const current = intent ?? (await ctx.stateStore.getCurrentRuntimeSession(ctx.message.chatId, ctx.agentId));
    const project = current?.projectId ? await ctx.projects.get(current.projectId) : null;
    return {
      handled: true,
      text: `No Sessions in ${project ? `Project \`${project.name}\`` : "the Non-Project workspace"}. Send a message to start one.`,
    };
  }
  const projects = new Map((await ctx.projects.list()).map((project) => [project.projectId, project]));
  return {
    handled: true,
    text: [
      "**ClawChat Connect Sessions**",
      intent?.projectId
        ? `Workspace: Project \`${(await ctx.projects.get(intent.projectId))?.name ?? "unknown"}\``
        : intent
          ? "Workspace: Non-Project (next Session)"
          : sessions[0]?.projectId
            ? `Workspace: Project \`${(await ctx.projects.get(sessions[0].projectId))?.name ?? "unknown"}\``
            : "Workspace: Non-Project",
      "",
      ...sessions.map((session) =>
        formatSession(
          session,
          session.projectId ? projects.get(session.projectId) : null,
          binding.kind === "workbuddy",
        ),
      ),
      ...discovered.map(
        (thread) =>
          `- ${runtimeThreadLabel(thread)} · \`${thread.sessionRef}\` (available) — ${
            binding.kind === "workbuddy" ? "WorkBuddy Task · desktop-synchronized" : "Runtime Thread"
          }`,
      ),
    ].join("\n"),
  };
}

async function handleSwitch(ctx: ChatCommandContext, rawReference: string | undefined): Promise<ChatCommandResult> {
  const reference = rawReference?.trim() ?? "";
  if (!reference) return { handled: true, text: "Usage: /switch <name-or-ref>" };
  const sessions = await ctx.stateStore.listRuntimeSessions(ctx.message.chatId, ctx.agentId);
  const matches = matchingSessions(sessions, reference);
  if (matches.length > 1) return { handled: true, text: ambiguousSessionText(reference, matches) };
  const matched = matches[0];
  if (matched) {
    await closeRuntimeSession(ctx);
    const switched = await conversationSessions(ctx).switchTo(matched.sessionId);
    return {
      handled: true,
      text: switched
        ? `Switched to Session \`${sessionLabel(matched)}\` (\`${matched.sessionRef}\`).`
        : `Unknown Session \`${reference}\`. Use /sessions to see Sessions.`,
    };
  }

  if (SESSION_REF_PATTERN.test(reference)) {
    const target = await ctx.stateStore.getSessionRefTarget(reference);
    if (
      target?.agentId === ctx.agentId &&
      target.chatId !== ctx.message.chatId &&
      target.runtimeSessionId &&
      !target.sessionId
    ) {
      const selected = await selectedSessionContext(ctx);
      if (!selected) return { handled: true, text: "Select a Project before importing a Runtime Thread." };
      await closeRuntimeSession(ctx);
      const adopted = await conversationSessions(ctx).adopt({
        sessionRef: target.sessionRef,
        sessionId: randomUUID(),
        selection: { ...selected, name: selected.name ?? null },
      });
      return {
        handled: true,
        text: adopted
          ? `Imported and switched to Session \`${adopted.sessionRef}\`.`
          : `Unknown Session \`${reference}\`. Use /sessions to see Sessions.`,
      };
    }
  }

  const discovered = (await ctx.discoverRuntimeThreads?.(ctx.message.chatId)) ?? [];
  const threadMatches = matchingRuntimeThreads(discovered, reference);
  if (threadMatches.length > 1) return { handled: true, text: ambiguousRuntimeThreadText(reference, threadMatches) };
  const thread = threadMatches[0];
  if (!thread) return { handled: true, text: `Unknown Session \`${reference}\`. Use /sessions to see Sessions.` };
  const selected = await selectedSessionContext(ctx);
  if (!selected) return { handled: true, text: "Select a Project before importing a Runtime Thread." };
  await closeRuntimeSession(ctx);
  await conversationSessions(ctx).adopt({
    sessionRef: thread.sessionRef,
    sessionId: randomUUID(),
    selection: { ...selected, name: thread.name },
  });
  return {
    handled: true,
    text: `Imported and switched to Runtime Thread \`${runtimeThreadLabel(thread)}\` (\`${thread.sessionRef}\`).`,
  };
}

async function handleProject(ctx: ChatCommandContext, args: string[]): Promise<ChatCommandResult> {
  const reference = args.join(" ").trim();
  try {
    if (!reference) {
      const projects = await ctx.projects.list();
      const workspaces =
        (await ctx.listRuntimeWorkspaces?.()) ??
        projects.flatMap((project) => {
          const workspace = workspaceView(project.rootPath);
          return workspace
            ? [
                {
                  workspaceId: workspace.id,
                  name: workspace.name,
                  rootPath: project.rootPath,
                  projectId: project.projectId,
                  projectName: project.name,
                },
              ]
            : [];
        });
      const selected = await selectedSessionContext(ctx);
      const current = selected?.projectId ? await ctx.projects.get(selected.projectId) : null;
      const currentWorkspace = current
        ? workspaces.find((workspace) => workspace.projectId === current.projectId)
        : null;
      return {
        handled: true,
        text: [
          "**ClawChat Connect Workspaces**",
          `Current: ${currentWorkspace ? `\`${currentWorkspace.name}\`` : "none (isolated workspace)"}`,
          "",
          ...(workspaces.length > 0
            ? workspaces.map((workspace) => `- \`${workspace.name}\` (${workspace.workspaceId}) — Project`)
            : ["No workspaces discovered."]),
        ].join("\n"),
      };
    }
    if (["add", "list", "use", "current", "clear", "remove"].includes(args[0]?.toLowerCase() ?? ""))
      return { handled: true, text: "This Project command was removed. Use `/help` for the supported commands." };
    const selected = await selectedSessionContext(ctx);
    let project: ProjectRecord | null = null;
    let workspaceName: string | null = null;
    if (reference.toLowerCase() !== "none") {
      const workspaces =
        (await ctx.listRuntimeWorkspaces?.()) ??
        (await ctx.projects.list()).flatMap((candidate) => {
          const workspace = workspaceView(candidate.rootPath);
          return workspace
            ? [
                {
                  workspaceId: workspace.id,
                  name: workspace.name,
                  rootPath: candidate.rootPath,
                  projectId: candidate.projectId,
                  projectName: candidate.name,
                },
              ]
            : [];
        });
      const workspace = workspaces.find((candidate) => candidate.workspaceId.toLowerCase() === reference.toLowerCase());
      if (!workspace) {
        return {
          handled: true,
          text: `Unknown Workspace ID \`${reference}\`. Use /project to see Projects.`,
        };
      }
      project = await ctx.projects.require(workspace.projectId);
      workspaceName = workspace.name;
    }
    await closeRuntimeSession(ctx);
    await conversationSessions(ctx).planNext({
      projectId: project?.projectId ?? null,
      name: selected?.name ?? null,
      mode: selected?.mode ?? null,
      model: selected?.model ?? null,
      reasoningEffort: selected?.reasoningEffort ?? null,
    });
    return {
      handled: true,
      text: project
        ? `Selected workspace \`${workspaceName ?? workspaceView(project.rootPath)?.name ?? project.name}\`; the next message will start a Session.`
        : "Selected an isolated Non-Project workspace; the next message will start a Session.",
    };
  } catch (error) {
    return { handled: true, text: `Project command failed: ${error instanceof Error ? error.message : String(error)}` };
  }
}

async function handleMode(ctx: ChatCommandContext, mode: string | undefined): Promise<ChatCommandResult> {
  const intent = await ctx.stateStore.getSessionIntent(ctx.message.chatId, ctx.agentId);
  const current = await ctx.stateStore.getCurrentRuntimeSession(ctx.message.chatId, ctx.agentId);
  const binding = getAgentBinding(ctx.config, current?.agentId || intent?.agentId || ctx.agentId);
  const modes = ctx.runtimeModesFor?.(binding, current ?? intent) ?? [];
  if (!mode)
    return {
      handled: true,
      text: `Current mode: \`${intent?.mode ?? current?.mode ?? binding.sandboxMode ?? "runtime default"}\`. Available: ${modes.join(", ") || "none"}.`,
    };
  const selectedMode = mode === "default" ? null : mode;
  if (ctx.runtimeModesFor) {
    if (modes.length === 0)
      return { handled: true, text: `Runtime ${runtimeFamilyFor(binding)} does not support configurable modes.` };
    if (selectedMode && !modes.includes(selectedMode)) {
      return { handled: true, text: commandUsage(ctx.message.chatType, "/mode") };
    }
  }
  if (intent || !current) {
    await conversationSessions(ctx).changeMode(selectedMode);
    return { handled: true, text: `Next Session mode set to \`${selectedMode ?? "default"}\`.` };
  }
  await conversationSessions(ctx).changeMode(selectedMode);
  await invalidateRuntimeSession(ctx);
  return {
    handled: true,
    text: `Current Session mode set to \`${selectedMode ?? "default"}\`; the next turn starts a new Runtime Thread boundary.`,
  };
}

async function handleModel(ctx: ChatCommandContext, args: string[]): Promise<ChatCommandResult> {
  const intent = await ctx.stateStore.getSessionIntent(ctx.message.chatId, ctx.agentId);
  const current = await ctx.stateStore.getCurrentRuntimeSession(ctx.message.chatId, ctx.agentId);
  const selected = intent ?? current ?? { model: null, reasoningEffort: null };
  const binding = getAgentBinding(ctx.config, intent?.agentId || current?.agentId || ctx.agentId);
  const modelReference = args[0]?.trim();
  if (modelReference?.toLowerCase() === "default") {
    await persistModelSelection(ctx, null, null);
    return { handled: true, text: "Session model now inherits the Agent Binding or runtime default." };
  }

  const models = (await ctx.listRuntimeModels?.(binding, current ?? intent)) ?? null;
  if (!models) return { handled: true, text: `Runtime ${runtimeFamilyFor(binding)} does not support model selection.` };

  if (!modelReference) {
    const effective = resolveModelSelection(binding, selected, models);
    return {
      handled: true,
      text: [
        `**Available ${runtimeFamilyFor(binding)} models**`,
        `Current: \`${effective.model ?? "runtime default"}\`${effective.reasoningEffort ? ` · \`${effective.reasoningEffort}\`` : ""} (${effective.source})`,
        "",
        ...models.map(
          (model) =>
            `- \`${model.id}\` — ${model.displayName}; efforts: ${model.supportedReasoningEfforts.join(", ")}${model.isDefault ? " (runtime default)" : ""}`,
        ),
      ].join("\n"),
    };
  }

  try {
    const model = requireModel(models, modelReference);
    const reasoningEffort = resolveEffort(model, args[1], true);
    await persistModelSelection(ctx, model.id, reasoningEffort);
    return {
      handled: true,
      text: `${intent || !current ? "Next Session" : "Current Session"} model set to \`${model.id}\` with \`${reasoningEffort}\` reasoning.`,
    };
  } catch (error) {
    return { handled: true, text: `Model selection failed: ${error instanceof Error ? error.message : String(error)}` };
  }
}

async function persistModelSelection(
  ctx: ChatCommandContext,
  model: string | null,
  reasoningEffort: string | null,
): Promise<void> {
  await conversationSessions(ctx).changeModel(model, reasoningEffort);
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

function formatSession(
  session: RuntimeSessionRecord,
  project: ProjectRecord | null | undefined,
  describeWorkBuddyTarget = false,
): string {
  const projectText = project ? `Project ${project.name}` : "Non-Project";
  const targetText = describeWorkBuddyTarget
    ? workBuddyRuntimeTargetKind(session.runtimeSessionId) === "workbuddy-task"
      ? " · WorkBuddy Task · desktop-synchronized"
      : " · CodeBuddy Session · Connect-only"
    : "";
  return `- ${sessionLabel(session)} · \`${session.sessionRef}\`${session.isCurrent ? " (current)" : ""} — ${projectText}${targetText}`;
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
  includeAllNonProjectSessions = false,
): RuntimeSessionRecord[] {
  const materialized = sessions.filter((session) => session.hasMessages);
  if (intent) {
    if (!intent.projectId) {
      return includeAllNonProjectSessions ? materialized.filter((session) => !session.projectId) : [];
    }
    return materialized.filter((session) => session.projectId === intent.projectId);
  }
  const current = materialized.find((session) => session.isCurrent);
  if (!current) return [];
  if (!current.projectId) {
    return includeAllNonProjectSessions ? materialized.filter((session) => !session.projectId) : [current];
  }
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

const SESSION_REF_PATTERN = /^[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{8}$/iu;

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

function conversationSessions(ctx: ChatCommandContext) {
  return continuityFor(ctx).inConversation({
    chatId: ctx.message.chatId,
    bindingId: ctx.agentId,
  });
}

function parseOutputVisibility(value: unknown): OutputVisibility | null {
  const mode = typeof value === "string" ? value.trim().toLowerCase() : "";
  return mode === "minimal" || mode === "normal" || mode === "full" ? mode : null;
}

function continuityFor(ctx: ChatCommandContext): SessionContinuity {
  return ctx.sessionContinuity ?? createSessionContinuity({ stateStore: ctx.stateStore });
}
