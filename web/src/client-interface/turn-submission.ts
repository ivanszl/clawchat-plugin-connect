import type { SlashSuggestionView, StartTurnResponse } from "../../../src/client-contract";
import { CLIENT_API_PREFIX } from "../../../src/client-contract";
import { ClientInterfaceError, clientFetch } from "./http";

export interface ClientTurnSubmission {
  submissionId: string;
  sessionRef: string;
  prompt: string;
  selection?: SlashSuggestionView | null;
  attachments: File[];
}

const KNOWN_TURN_SUBMISSION_ERROR_KEYS = {
  "empty-submission": "@connect.composer.error.emptySubmission",
  "prompt-unsupported": "@connect.composer.error.promptUnsupported",
  "prompt-required": "@connect.composer.error.promptRequired",
  "prompt-too-long": "@connect.composer.error.promptTooLong",
  "too-many-attachments": "@connect.composer.error.tooManyAttachments",
  "attachment-too-large": "@connect.composer.error.attachmentTooLarge",
  "attachments-too-large": "@connect.composer.error.attachmentsTooLarge",
  "attachment-unsupported": "@connect.composer.error.attachmentUnsupported",
  "attachment-size-mismatch": "@connect.composer.error.attachmentSizeMismatch",
  "invalid-attachment": "@connect.composer.error.invalidAttachment",
  "invalid-selection": "@connect.composer.error.invalidSelection",
  "selection-prompt-mismatch": "@connect.composer.error.selectionPromptMismatch",
  "submission-cancelled": "@connect.composer.error.submissionCancelled",
  "submission-outcome-unknown": "@connect.composer.error.submissionOutcomeUnknown",
  "submission-too-large": "@connect.composer.error.submissionTooLarge",
  "submission-failed": "@connect.composer.error.submissionFailed",
  "command-in-progress": "@connect.composer.error.commandInProgress",
  "session-not-found": "@connect.composer.error.sessionNotFound",
  "session-state-conflict": "@connect.composer.error.sessionStateConflict",
  "request-id-conflict": "@connect.composer.error.requestIdConflict",
  "submission-id-conflict": "@connect.composer.error.submissionIdConflict",
} as const satisfies Readonly<Record<string, string>>;

type TurnSubmissionErrorKey =
  | (typeof KNOWN_TURN_SUBMISSION_ERROR_KEYS)[keyof typeof KNOWN_TURN_SUBMISSION_ERROR_KEYS]
  | "@connect.composer.error.unknown"
  | "@connect.composer.error.withDiagnostic";
type TurnSubmissionErrorTranslator = (key: TurnSubmissionErrorKey, values?: Record<string, unknown>) => string;

export function formatTurnSubmissionError(error: unknown, translate: TurnSubmissionErrorTranslator): string {
  let message: string;
  if (error instanceof ClientInterfaceError) {
    const key = KNOWN_TURN_SUBMISSION_ERROR_KEYS[error.code as keyof typeof KNOWN_TURN_SUBMISSION_ERROR_KEYS];
    message = key ? translate(key) : error.message;
  } else if (error instanceof Error) {
    message = error.message;
  } else {
    message = translate("@connect.composer.error.unknown");
  }
  if (!(error instanceof ClientInterfaceError) || !error.diagnosticRef) return message;
  return translate("@connect.composer.error.withDiagnostic", {
    message,
    reference: error.diagnosticRef,
  });
}

export async function submitTurn(
  draft: ClientTurnSubmission,
  options: { signal?: AbortSignal } = {},
): Promise<StartTurnResponse> {
  const body = new FormData();
  body.append("prompt", draft.prompt);
  if (draft.selection) {
    body.append("selectionKind", draft.selection.kind);
    body.append("selectionId", draft.selection.id);
    body.append("selectionName", draft.selection.name);
  }
  for (const file of draft.attachments) body.append("attachments", file, file.name);

  try {
    return await clientFetch<StartTurnResponse>(submissionUrl(draft.sessionRef, draft.submissionId), {
      method: "POST",
      body,
      signal: options.signal,
    });
  } catch (error) {
    if (options.signal?.aborted) throw error;
    try {
      return await getTurnSubmission(draft.sessionRef, draft.submissionId);
    } catch {
      throw error;
    }
  }
}

export async function getTurnSubmission(sessionRef: string, submissionId: string): Promise<StartTurnResponse> {
  return await clientFetch<StartTurnResponse>(submissionUrl(sessionRef, submissionId));
}

export async function retryTurnSubmission(sessionRef: string, submissionId: string): Promise<StartTurnResponse> {
  return await clientFetch<StartTurnResponse>(`${submissionUrl(sessionRef, submissionId)}/retry`, {
    method: "POST",
  });
}

export async function discardTurnSubmission(
  sessionRef: string,
  submissionId: string,
): Promise<{ submissionId: string; sessionRef: string; discarded: true }> {
  return await clientFetch(submissionUrl(sessionRef, submissionId), { method: "DELETE" });
}

function submissionUrl(sessionRef: string, submissionId: string): string {
  return `${CLIENT_API_PREFIX}/sessions/${encodeURIComponent(sessionRef)}/turn-submissions/${encodeURIComponent(submissionId)}`;
}
