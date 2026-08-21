import { randomUUID } from "node:crypto";
import { getAgentBinding } from "../config";
import type { ConnectStateStore } from "../persistence/state";
import {
  requireModel,
  resolveEffort,
  resolveModelSelection,
  runtimeModelSelectionLabel,
} from "../runtime/model-selection";
import type { RuntimeModelOption, SelectableRuntimeThread } from "../runtime/types";
import { workBuddyCapabilityAvailability, workBuddyCapabilityFailure } from "../runtime/workbuddy-availability";
import { workBuddyRuntimeTargetKind } from "../runtime/workbuddy-runtime-target";
import type {
  AgentBindingConfig,
  ConnectConfig,
  OutputVisibility,
  RuntimeModelSelection,
  RuntimeSessionRecord,
  SessionIntentRecord,
  WorkspaceRecord,
} from "../types";
import { createSessionContinuity, type SessionContinuity } from "../workspaces/session-continuity";
import type { RuntimeWorkspaceChoice } from "../workspaces/workspace-catalog";
import type { WorkspaceCatalog } from "../workspaces/workspaces";
import { commandAddressPrefix } from "./message-mapper";
import type { NormalizedInboundMessage } from "./protocol";

export interface ChatCommandContext {
  message: NormalizedInboundMessage;
  agentId: string;
  ownerUserId: string;
  config: ConnectConfig;
  stateStore: ConnectStateStore;
  workspaces: WorkspaceCatalog;
  sessionContinuity?: SessionContinuity;
  closeRuntimeSession?: (chatId: string) => Promise<boolean>;
  invalidateRuntimeSession?: (chatId: string) => Promise<boolean>;
  cancelRuntimeTurn?: (chatId: string) => Promise<boolean>;
  runtimeFamilyFor(binding: AgentBindingConfig): string;
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
  "/workspace",
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
  ["/workspace", "/workspace [workspace-ref]"],
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
    `- \`${prefix}/workspace [workspace-ref]\` — inspect or select the next Workspace (Binding Owner only).`,
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
  if (command === "/workspace") return args.length === 1;
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
  if (command === "/workspace") return await handleWorkspace(ctx, args);
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
    (command === "/workspace" && args.length <= 1) ||
    (command === "/mode" && args.length <= 1) ||
    (command === "/model" && args.length <= 2 && (args[0]?.toLowerCase() !== "default" || args.length === 1));
  return valid ? null : commandUsage(message.chatType, command);
}

function workBuddyCapabilityFailureText(
  error: unknown,
  capability: "Task discovery" | "model catalog",
  retryCommand: "/sessions" | "/switch" | "/model",
): string | null {
  const failure = workBuddyCapabilityFailure(error);
  if (!failure) return null;
  const state = workBuddyCapabilityAvailability(failure.code);
  const action =
    state === "unsupported"
      ? `Update the selected WorkBuddy Runtime Capability before retrying \`${retryCommand}\`.`
      : state === "unavailable"
        ? `Restore WorkBuddy, then retry \`${retryCommand}\`.`
        : `Open the exact WorkBuddy Task and resolve its identity or replay conflict before retrying \`${retryCommand}\`.`;
  return `WorkBuddy ${capability} is ${state === "conflict" ? "conflicted" : state}: ${failure.message}\n${action}`;
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
  const workspace =
    (selected?.workspaceRef ? await ctx.workspaces.get(selected.agentId, selected.workspaceRef) : null) ??
    (await ctx.workspaces.ensureDefault(selected?.agentId ?? ctx.agentId));
  const binding = getAgentBinding(ctx.config, selected?.agentId ?? ctx.agentId);
  const models = (await ctx.listRuntimeModels?.(binding, selected).catch(() => null)) ?? null;
  let modelText = binding.model ? runtimeModelSelectionLabel(binding.model) : "runtime default";
  let effortText = binding.modelReasoningEffort ?? "runtime default";
  let source = binding.model ? "binding" : "runtime";
  try {
    if (selected) {
      const effective = resolveModelSelection(binding, selected, models);
      modelText = effective.model ? runtimeModelSelectionLabel(effective.model) : "runtime default";
      effortText = effective.reasoningEffort ?? "runtime default";
      source = effective.source;
    }
  } catch (error) {
    const unavailableModel = selected?.model ?? binding.model;
    modelText = `${unavailableModel ? runtimeModelSelectionLabel(unavailableModel) : "unknown"} (unavailable: ${error instanceof Error ? error.message : String(error)})`;
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
      ...(ctx.runtimeFamilyFor(binding) === "workbuddy"
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
      `- workspace: \`${workspace.name}\` (\`${workspace.workspaceRef}\`)`,
      `- mode: \`${selected?.mode ?? "runtime default"}\``,
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
      workspaceRef: selected?.workspaceRef ?? (await ctx.workspaces.ensureDefault(ctx.agentId)).workspaceRef,
      mode: selected?.mode ?? null,
      model: selected?.model ?? null,
      reasoningEffort: selected?.reasoningEffort ?? null,
      name: name.trim() || null,
    });
  return {
    handled: true,
    text:
      ctx.runtimeFamilyFor(binding) === "workbuddy"
        ? `The next message will start${name.trim() ? ` CodeBuddy Session \`${name.trim()}\`` : " a new CodeBuddy Session"}. It will not appear in WorkBuddy Desktop; use \`/sessions\` and \`/switch <session-ref>\` for a desktop-synchronized WorkBuddy Task.`
        : `The next message will start${name.trim() ? ` Session \`${name.trim()}\`` : " a new Session"}.`,
  };
}

async function handleList(ctx: ChatCommandContext): Promise<ChatCommandResult> {
  const binding = getAgentBinding(ctx.config, ctx.agentId);
  const intent = await ctx.stateStore.getSessionIntent(ctx.message.chatId, ctx.agentId);
  let discovered: SelectableRuntimeThread[] = [];
  let discoveryFailure: string | null = null;
  try {
    discovered = (await ctx.discoverRuntimeThreads?.(ctx.message.chatId)) ?? [];
  } catch (error) {
    discoveryFailure = workBuddyCapabilityFailureText(error, "Task discovery", "/sessions");
    if (!discoveryFailure) throw error;
  }
  const sessions = sessionsInCurrentWorkspace(
    await ctx.stateStore.listRuntimeSessions(ctx.message.chatId, ctx.agentId),
    intent,
  );
  if (sessions.length === 0 && discovered.length === 0) {
    const current = intent ?? (await ctx.stateStore.getCurrentRuntimeSession(ctx.message.chatId, ctx.agentId));
    const workspace = current?.workspaceRef
      ? await ctx.workspaces.get(current.agentId, current.workspaceRef)
      : await ctx.workspaces.ensureDefault(ctx.agentId);
    return {
      handled: true,
      text: [
        `No Sessions in Workspace \`${workspace?.name ?? "unknown"}\`. Send a message to start one.`,
        ...(discoveryFailure ? ["", discoveryFailure] : []),
      ].join("\n"),
    };
  }
  const workspaces = new Map(
    (await ctx.workspaces.list(ctx.agentId)).map((workspace) => [workspace.workspaceRef, workspace]),
  );
  const selectedWorkspaceRef = intent?.workspaceRef ?? sessions[0]?.workspaceRef;
  return {
    handled: true,
    text: [
      "**ClawChat Connect Sessions**",
      `Workspace: \`${selectedWorkspaceRef ? (workspaces.get(selectedWorkspaceRef)?.name ?? "unknown") : "unknown"}\``,
      "",
      ...sessions.map((session) =>
        formatSession(
          session,
          session.workspaceRef ? workspaces.get(session.workspaceRef) : null,
          ctx.runtimeFamilyFor(binding) === "workbuddy",
        ),
      ),
      ...discovered.map(
        (thread) =>
          `- ${runtimeThreadLabel(thread)} · \`${thread.sessionRef}\` (available) — ${
            ctx.runtimeFamilyFor(binding) === "workbuddy" ? "WorkBuddy Task · desktop-synchronized" : "Runtime Thread"
          }`,
      ),
      ...(discoveryFailure ? ["", discoveryFailure] : []),
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
      if (!selected?.workspaceRef)
        return { handled: true, text: "Select a Workspace before importing a Runtime Thread." };
      await closeRuntimeSession(ctx);
      const adopted = await conversationSessions(ctx).adopt({
        sessionRef: target.sessionRef,
        sessionId: randomUUID(),
        selection: { ...selected, workspaceRef: selected.workspaceRef, name: selected.name ?? null },
      });
      return {
        handled: true,
        text: adopted
          ? `Imported and switched to Session \`${adopted.sessionRef}\`.`
          : `Unknown Session \`${reference}\`. Use /sessions to see Sessions.`,
      };
    }
  }

  let discovered: SelectableRuntimeThread[];
  try {
    discovered = (await ctx.discoverRuntimeThreads?.(ctx.message.chatId)) ?? [];
  } catch (error) {
    const discoveryFailure = workBuddyCapabilityFailureText(error, "Task discovery", "/switch");
    if (!discoveryFailure) throw error;
    return { handled: true, text: discoveryFailure };
  }
  const threadMatches = matchingRuntimeThreads(discovered, reference);
  if (threadMatches.length > 1) return { handled: true, text: ambiguousRuntimeThreadText(reference, threadMatches) };
  const thread = threadMatches[0];
  if (!thread) return { handled: true, text: `Unknown Session \`${reference}\`. Use /sessions to see Sessions.` };
  const selected = await selectedSessionContext(ctx);
  if (!selected?.workspaceRef) return { handled: true, text: "Select a Workspace before importing a Runtime Thread." };
  await closeRuntimeSession(ctx);
  await conversationSessions(ctx).adopt({
    sessionRef: thread.sessionRef,
    sessionId: randomUUID(),
    selection: { ...selected, workspaceRef: selected.workspaceRef, name: thread.name },
  });
  return {
    handled: true,
    text: `Imported and switched to Runtime Thread \`${runtimeThreadLabel(thread)}\` (\`${thread.sessionRef}\`).`,
  };
}

async function handleWorkspace(ctx: ChatCommandContext, args: string[]): Promise<ChatCommandResult> {
  const reference = args.join(" ").trim();
  try {
    const workspaces =
      (await ctx.listRuntimeWorkspaces?.()) ??
      (await ctx.workspaces.list(ctx.agentId)).map((workspace) => ({
        workspaceRef: workspace.workspaceRef,
        name: workspace.name,
        rootPath: workspace.rootPath,
      }));
    if (!reference) {
      const selected = await selectedSessionContext(ctx);
      const current = selected?.workspaceRef
        ? workspaces.find((workspace) => workspace.workspaceRef === selected.workspaceRef)
        : null;
      return {
        handled: true,
        text: [
          "**ClawChat Connect Workspaces**",
          `Current: ${current ? `\`${current.name}\` (\`${current.workspaceRef}\`)` : "none"}`,
          "",
          ...(workspaces.length > 0
            ? workspaces.map((workspace) => `- \`${workspace.name}\` (\`${workspace.workspaceRef}\`)`)
            : ["No Workspaces available."]),
        ].join("\n"),
      };
    }
    const workspace = workspaces.find((candidate) => candidate.workspaceRef.toLowerCase() === reference.toLowerCase());
    if (!workspace) {
      return {
        handled: true,
        text: `Unknown Workspace Ref \`${reference}\`. Use /workspace to see Workspaces.`,
      };
    }
    await ctx.workspaces.require(ctx.agentId, workspace.workspaceRef);
    const selected = await selectedSessionContext(ctx);
    await closeRuntimeSession(ctx);
    await conversationSessions(ctx).planNext({
      workspaceRef: workspace.workspaceRef,
      name: selected?.name ?? null,
      mode: selected?.mode ?? null,
      model: selected?.model ?? null,
      reasoningEffort: selected?.reasoningEffort ?? null,
    });
    return {
      handled: true,
      text: `Selected Workspace \`${workspace.name}\`; the next message will start a Session.`,
    };
  } catch (error) {
    return {
      handled: true,
      text: `Workspace command failed: ${error instanceof Error ? error.message : String(error)}`,
    };
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
      text: `Current mode: \`${intent?.mode ?? current?.mode ?? "runtime default"}\`. Available: ${modes.join(", ") || "none"}.`,
    };
  const selectedMode = mode === "default" ? null : mode;
  if (ctx.runtimeModesFor) {
    if (modes.length === 0)
      return { handled: true, text: `Runtime ${ctx.runtimeFamilyFor(binding)} does not support configurable modes.` };
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

  let models: RuntimeModelOption[] | null;
  try {
    models = (await ctx.listRuntimeModels?.(binding, current ?? intent)) ?? null;
  } catch (error) {
    const catalogFailure = workBuddyCapabilityFailureText(error, "model catalog", "/model");
    if (!catalogFailure) throw error;
    return { handled: true, text: catalogFailure };
  }
  if (!models || models.length === 0)
    return {
      handled: true,
      text: `Runtime ${ctx.runtimeFamilyFor(binding)} does not support model selection.`,
    };

  if (!modelReference) {
    const effective = resolveModelSelection(binding, selected, models);
    return {
      handled: true,
      text: [
        `**Available ${ctx.runtimeFamilyFor(binding)} models**`,
        `Current: \`${effective.model ? runtimeModelSelectionLabel(effective.model) : "runtime default"}\`${effective.reasoningEffort ? ` · \`${effective.reasoningEffort}\`` : ""} (${effective.source})`,
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
    await persistModelSelection(ctx, model.selection, reasoningEffort);
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
  model: RuntimeModelSelection | null,
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
  workspace: WorkspaceRecord | null | undefined,
  describeWorkBuddyTarget = false,
): string {
  const workspaceText = workspace ? `Workspace ${workspace.name}` : "Workspace unavailable";
  const targetText = describeWorkBuddyTarget
    ? workBuddyRuntimeTargetKind(session.runtimeSessionId) === "workbuddy-task"
      ? " · WorkBuddy Task · desktop-synchronized"
      : " · CodeBuddy Session · Connect-only"
    : "";
  return `- ${sessionLabel(session)} · \`${session.sessionRef}\`${session.isCurrent ? " (current)" : ""} — ${workspaceText}${targetText}`;
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
  if (intent?.workspaceRef) {
    return materialized.filter((session) => session.workspaceRef === intent.workspaceRef);
  }
  const current = materialized.find((session) => session.isCurrent);
  if (!current) return [];
  if (!current.workspaceRef) return [current];
  return materialized.filter((session) => session.workspaceRef === current.workspaceRef);
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
  return (
    ctx.sessionContinuity ??
    createSessionContinuity({
      stateStore: ctx.stateStore,
      resolveDefaultWorkspace: async (bindingId) => (await ctx.workspaces.ensureDefault(bindingId)).workspaceRef,
    })
  );
}
