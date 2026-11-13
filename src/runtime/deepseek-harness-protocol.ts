import type { RuntimeInteractionRequest } from "./types";

export const DSH_BRIDGE_PROTOCOL_NAME = "clawchat-connect-dsh-bridge" as const;
// Major 2: frames may be up to 16 MiB and the Bridge degrades oversized events instead of exiting. A major 1 Bridge
// (1 MiB limit, kills the process on an oversized event) is refused at the handshake.
export const DSH_BRIDGE_PROTOCOL_MAJOR = 2 as const;
// One limit for both ends: the Bridge imports the same module as a sibling Plugin asset.
export { DSH_BRIDGE_MAX_FRAME_BYTES } from "../plugin/official/deepseek-harness-frame.mjs";

export interface DshBridgeCapabilities {
  promptQueue: boolean;
  promptSteer: boolean;
  cancel: boolean;
  durableReceipt: boolean;
  history: boolean;
  approvals: boolean;
  questions: boolean;
  models: boolean;
  presets: boolean;
  permissionPresets: boolean;
  skills: boolean;
  commands: boolean;
  imageInput: boolean;
  localProducedFilePresentation: boolean;
  portableArtifactOutput: false;
  archive: boolean;
  restore: false;
  delete: false;
  crossProcessSessionOwnership: boolean;
}

export interface DshBridgeHello {
  type: "hello";
  protocol: { name: typeof DSH_BRIDGE_PROTOCOL_NAME; major: number; build: string; maxFrameBytes?: number };
  home: string;
  profile: string | null;
  capabilities: DshBridgeCapabilities;
}

export interface DshBridgeRequest {
  type: "request";
  id: string;
  method: string;
  params: unknown;
}

export type DshBridgeResponse =
  | { type: "response"; id: string; ok: true; result: unknown }
  | { type: "response"; id: string; ok: false; error: { code: string; message: string } };

export interface DshBridgeEvent {
  type: "event";
  sessionId: string;
  event: DshSessionEvent;
}
export interface DshBridgeInteraction {
  type: "interaction";
  id: string;
  sessionId: string;
  request: RuntimeInteractionRequest;
}

export type DshBridgeFrame = DshBridgeHello | DshBridgeResponse | DshBridgeEvent | DshBridgeInteraction;

export interface DshSessionHeader {
  id: string;
  createdAt: number;
  cwd?: string;
  parentSession?: string;
  origin?: "subagent";
  agentPreset?: string;
}

export interface DshBridgeTruncationField {
  path: string;
  originalBytes: number;
  previewBytes: number;
  kind?: "text" | "binary";
}

/** Present when the Bridge shortened an event to fit the frame limit; the inline text carries its own marker too. */
export interface DshBridgeTruncation {
  truncated: true;
  placeholder?: boolean;
  originalBytes: number;
  fields: DshBridgeTruncationField[];
  omittedFields?: number;
  note?: string;
}

export interface DshSessionEvent {
  seq: number;
  time: number;
  type: string;
  data: unknown;
  truncated?: DshBridgeTruncation;
}

export interface DshBridgeSessionSummary {
  header: DshSessionHeader;
  owned: boolean;
  archived: boolean;
  title: string | null;
  updatedAt: number;
}

export interface DshBridgeCatalogModel {
  provider: string;
  id: string;
  name: string;
  description?: string;
  inputModalities?: string[];
  isDefault?: boolean;
  imageLimits?: DshBridgeImageLimits;
  contextWindow?: number;
  defaultMaxTokens?: number;
  reasoning?: {
    efforts: Array<{ id: string; name: string; description?: string }>;
    defaultEffort?: string;
  };
}

export interface DshBridgeImageLimits {
  maxImageBytes: number;
  maxImagesPerMessage: number;
  maxMessageImageBytes: number;
  mediaTypes: string[];
}

export interface DshBridgeCatalogSkill {
  name: string;
  description: string;
  userInvocable: boolean;
}
export interface DshBridgeCatalogPreset {
  id: string;
  name?: string;
  description?: string;
  broken?: string;
}

export interface DshBridgePresetCatalog {
  defaultId: string;
  presets: DshBridgeCatalogPreset[];
}

export interface DshBridgePermissionPresetCatalog {
  defaultId: string;
  presets: Array<{ id: string; name: string; description?: string }>;
}

export interface DshBridgeCatalogCommand {
  name: string;
  description: string;
}

export interface DshBridgeAdmission {
  inputId: string;
  messageId: string;
}

/**
 * One bounded window of the newest matching Session events (ascending). `complete` is true only when no matching
 * event was left out; `nextBeforeSeq` (pass it as `beforeSeq`) is set when the byte budget cut the window.
 */
export interface DshBridgeHistory {
  header: DshSessionHeader;
  events: DshSessionEvent[];
  complete: boolean;
  nextBeforeSeq: number | null;
}

export interface DshBridgeHistoryParams {
  sessionId: string;
  /** Header only: no events. */
  headerOnly?: boolean;
  /** Scope to the N latest Turns plus Turn-less command events. */
  lastTurns?: number;
  types?: string[];
  beforeSeq?: number;
  limit?: number;
  maxBytes?: number;
}

export class DshBridgeRemoteError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "DshBridgeRemoteError";
  }
}

export function parseDshBridgeFrame(line: string): DshBridgeFrame {
  const decoded = JSON.parse(line) as unknown;
  if (typeof decoded !== "object" || decoded === null || Array.isArray(decoded)) {
    throw new Error("DSH Bridge frame must be an object");
  }
  const value = decoded as Record<string, unknown>;
  if (typeof value.type !== "string") throw new Error("DSH Bridge frame must have a type");
  if (value.type === "hello") return parseHello(value);
  if (value.type === "response") {
    if (typeof value.id !== "string" || typeof value.ok !== "boolean") {
      throw new Error("DSH Bridge response is malformed");
    }
    if (value.ok) return { type: "response", id: value.id, ok: true, result: value.result };
    const error = value.error as { code?: unknown; message?: unknown } | null;
    if (!error || typeof error !== "object" || typeof error.code !== "string" || typeof error.message !== "string") {
      throw new Error("DSH Bridge error response is malformed");
    }
    return {
      type: "response",
      id: value.id,
      ok: false,
      error: { code: error.code, message: error.message },
    };
  }
  if (value.type === "event") {
    if (typeof value.sessionId !== "string" || !isSessionEvent(value.event)) {
      throw new Error("DSH Bridge event frame is malformed");
    }
    return { type: "event", sessionId: value.sessionId, event: value.event };
  }
  if (value.type === "interaction") {
    const request = value.request as { kind?: unknown } | null;
    if (
      typeof value.id !== "string" ||
      typeof value.sessionId !== "string" ||
      !request ||
      typeof request !== "object" ||
      (request.kind !== "approval" && request.kind !== "user-input")
    ) {
      throw new Error("DSH Bridge interaction frame is malformed");
    }
    return {
      type: "interaction",
      id: value.id,
      sessionId: value.sessionId,
      request: value.request as RuntimeInteractionRequest,
    };
  }
  throw new Error(`Unsupported DSH Bridge frame type: ${value.type}`);
}

function parseHello(value: Record<string, unknown>): DshBridgeHello {
  const protocol = value.protocol as {
    name?: unknown;
    major?: unknown;
    build?: unknown;
    maxFrameBytes?: unknown;
  } | null;
  if (
    !protocol ||
    typeof protocol !== "object" ||
    protocol.name !== DSH_BRIDGE_PROTOCOL_NAME ||
    typeof protocol.major !== "number" ||
    typeof protocol.build !== "string" ||
    (protocol.maxFrameBytes !== undefined &&
      (!Number.isSafeInteger(protocol.maxFrameBytes) || (protocol.maxFrameBytes as number) <= 0)) ||
    typeof value.home !== "string" ||
    (value.profile !== null && typeof value.profile !== "string") ||
    !isCapabilities(value.capabilities)
  ) {
    throw new Error("DSH Bridge hello frame is malformed");
  }
  return value as unknown as DshBridgeHello;
}

function isSessionEvent(value: unknown): value is DshSessionEvent {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const event = value as Partial<DshSessionEvent>;
  return (
    Number.isSafeInteger(event.seq) &&
    Number.isFinite(event.time) &&
    typeof event.type === "string" &&
    Object.hasOwn(event, "data")
  );
}

function isCapabilities(value: unknown): value is DshBridgeCapabilities {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const capabilities = value as Record<string, unknown>;
  const booleanKeys: Array<keyof DshBridgeCapabilities> = [
    "promptQueue",
    "promptSteer",
    "cancel",
    "durableReceipt",
    "history",
    "approvals",
    "questions",
    "models",
    "presets",
    "permissionPresets",
    "skills",
    "commands",
    "imageInput",
    "localProducedFilePresentation",
    "portableArtifactOutput",
    "archive",
    "restore",
    "delete",
    "crossProcessSessionOwnership",
  ];
  return booleanKeys.every((key) => typeof capabilities[key] === "boolean");
}
