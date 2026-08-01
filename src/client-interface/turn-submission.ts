import type { TurnSubmissionCapability } from "../client-contract";
import type { RuntimeSkillSummary } from "../runtime/types";
export type TurnSubmissionAttachmentKind = "image" | "file" | "audio" | "video";
export type { TurnSubmissionCapability } from "../client-contract";

export interface TurnSubmissionAttachment {
  name: string;
  mime: string;
  size: number;
  readBytes(): Promise<Uint8Array>;
}

export interface TurnSubmissionDraft {
  submissionId: string;
  sessionRef: string;
  prompt: string;
  skill?: RuntimeSkillSummary | null;
  attachments: TurnSubmissionAttachment[];
}

export interface StagedTurnSubmission {
  rollback(): Promise<void>;
  transfer(): void;
}

export interface TurnSubmissionStaging {
  stage(draft: TurnSubmissionDraft, signal?: AbortSignal): Promise<StagedTurnSubmission>;
}

export interface AcceptedTurnSubmission {
  accepted: true;
  turnId: string;
  sessionRef: string;
}

export interface TurnSubmissionOptions {
  capabilityFor(sessionRef: string): Promise<TurnSubmissionCapability>;
  staging: TurnSubmissionStaging;
  accept(
    sessionRef: string,
    prompt: string,
    skill: RuntimeSkillSummary | null,
    staged: StagedTurnSubmission,
    signal?: AbortSignal,
  ): Promise<AcceptedTurnSubmission>;
}

export class TurnSubmissionError extends Error {
  constructor(
    readonly code:
      | "empty-submission"
      | "prompt-unsupported"
      | "prompt-required"
      | "prompt-too-long"
      | "too-many-attachments"
      | "attachment-too-large"
      | "attachments-too-large"
      | "attachment-unsupported"
      | "attachment-size-mismatch",
    message: string,
  ) {
    super(message);
    this.name = "TurnSubmissionError";
  }
}

export class TurnSubmission {
  constructor(private readonly options: TurnSubmissionOptions) {}

  async submit(draft: TurnSubmissionDraft, signal?: AbortSignal): Promise<AcceptedTurnSubmission> {
    const immutable = snapshotDraft(draft);
    validateDraft(immutable, await this.options.capabilityFor(immutable.sessionRef));
    signal?.throwIfAborted();
    const staged = await this.options.staging.stage(immutable, signal);
    try {
      signal?.throwIfAborted();
      validateDraft(immutable, await this.options.capabilityFor(immutable.sessionRef));
      const accepted = await this.options.accept(
        immutable.sessionRef,
        immutable.prompt,
        immutable.skill ?? null,
        staged,
        signal,
      );
      staged.transfer();
      return accepted;
    } catch (error) {
      await staged.rollback();
      throw error;
    }
  }
}

function snapshotDraft(draft: TurnSubmissionDraft): TurnSubmissionDraft {
  return {
    submissionId: draft.submissionId,
    sessionRef: draft.sessionRef,
    prompt: draft.prompt,
    skill: draft.skill ? { ...draft.skill } : null,
    attachments: draft.attachments.map((attachment) => ({ ...attachment })),
  };
}

export function validateDraft(draft: TurnSubmissionDraft, capability: TurnSubmissionCapability): void {
  const prompt = draft.prompt.trim();
  if (!prompt && draft.attachments.length === 0) {
    throw new TurnSubmissionError("empty-submission", "A prompt or at least one attachment is required");
  }
  if (prompt && !capability.prompt.allowed) {
    throw new TurnSubmissionError("prompt-unsupported", "The current Turn Submission does not accept text");
  }
  if (!prompt && capability.prompt.required) {
    throw new TurnSubmissionError("prompt-required", "A prompt is required");
  }
  if (prompt.length > capability.prompt.maxCharacters) {
    throw new TurnSubmissionError(
      "prompt-too-long",
      `Prompt must contain at most ${capability.prompt.maxCharacters} characters`,
    );
  }
  if (draft.attachments.length > capability.attachments.maxCount) {
    throw new TurnSubmissionError(
      "too-many-attachments",
      `At most ${capability.attachments.maxCount} attachments are allowed`,
    );
  }
  let total = 0;
  for (const attachment of draft.attachments) {
    const kind = attachmentKind(attachment.mime);
    if (
      !kind ||
      !capability.attachments.allowedKinds.includes(kind) ||
      !mediaTypeAllowed(attachment.mime, capability.attachments.allowedMediaTypes)
    ) {
      throw new TurnSubmissionError(
        "attachment-unsupported",
        `${attachment.name} is not supported by the current Turn Submission`,
      );
    }
    if (attachment.size > capability.attachments.maxBytesEach) {
      throw new TurnSubmissionError("attachment-too-large", `${attachment.name} is too large`);
    }
    total += attachment.size;
  }
  if (total > capability.attachments.maxBytesTotal) {
    throw new TurnSubmissionError("attachments-too-large", "The attachments exceed the total byte limit");
  }
}

export function mediaTypeAllowed(mediaType: string, allowed: readonly string[]): boolean {
  return allowed.some((pattern) => {
    if (pattern === "*/*") return true;
    if (pattern.endsWith("/*")) return mediaType.startsWith(pattern.slice(0, -1));
    return pattern === mediaType;
  });
}

export function attachmentKind(mime: string): TurnSubmissionAttachmentKind | null {
  if (mime.startsWith("image/")) return "image";
  if (mime.startsWith("audio/")) return "audio";
  if (mime.startsWith("video/")) return "video";
  if (mime) return "file";
  return null;
}
