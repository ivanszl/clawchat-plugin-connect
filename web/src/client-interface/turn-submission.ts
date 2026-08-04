import type { SlashSuggestionView, StartTurnResponse } from "../../../src/client-contract";
import { CLIENT_API_PREFIX } from "../../../src/client-contract";
import { ClientInterfaceError } from "./http";

export type TurnSubmissionPhase = "transferring" | "accepting";

export interface ClientTurnSubmission {
  submissionId: string;
  sessionRef: string;
  prompt: string;
  selection?: SlashSuggestionView | null;
  attachments: File[];
}

export interface TurnSubmissionProgress {
  phase: TurnSubmissionPhase;
  transferredBytes: number;
  totalBytes: number;
}

export class TurnSubmissionCancelledError extends Error {
  constructor() {
    super("Turn Submission was cancelled before acceptance");
    this.name = "TurnSubmissionCancelledError";
  }
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
  if (error instanceof TurnSubmissionCancelledError) {
    message = translate("@connect.composer.error.submissionCancelled");
  } else if (error instanceof ClientInterfaceError) {
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

type SubmissionOutcome =
  | StartTurnResponse
  | { pending: true; submissionId: string; sessionRef: string }
  | { cancelled: true; submissionId: string; sessionRef: string };

export function submitTurn(
  draft: ClientTurnSubmission,
  options: {
    signal?: AbortSignal;
    onProgress?: (progress: TurnSubmissionProgress) => void;
  } = {},
): Promise<StartTurnResponse> {
  const totalBytes = draft.attachments.reduce((total, file) => total + file.size, 0);
  const body = new FormData();
  body.append("prompt", draft.prompt);
  if (draft.selection) {
    body.append("selectionKind", draft.selection.kind);
    body.append("selectionId", draft.selection.id);
    body.append("selectionName", draft.selection.name);
  }
  for (const file of draft.attachments) body.append("attachments", file, file.name);
  options.onProgress?.({ phase: "transferring", transferredBytes: 0, totalBytes });

  return new Promise((resolve, reject) => {
    const request = new XMLHttpRequest();
    let settled = false;
    const finish = (action: () => void) => {
      if (settled) return;
      settled = true;
      options.signal?.removeEventListener("abort", abort);
      action();
    };
    const abort = () => {
      request.abort();
      void cancelTurnSubmission(draft.sessionRef, draft.submissionId).then(
        (outcome) =>
          finish(() => {
            if ("accepted" in outcome) resolve(outcome);
            else reject(new TurnSubmissionCancelledError());
          }),
        (error) => finish(() => reject(error)),
      );
    };
    options.signal?.addEventListener("abort", abort, { once: true });
    request.open("POST", submissionUrl(draft.sessionRef, draft.submissionId));
    request.setRequestHeader("Accept", "application/json");
    request.upload.addEventListener("progress", (event) => {
      const ratio = event.lengthComputable && event.total > 0 ? event.loaded / event.total : 0;
      options.onProgress?.({
        phase: "transferring",
        transferredBytes: Math.min(totalBytes, Math.round(totalBytes * ratio)),
        totalBytes,
      });
    });
    request.upload.addEventListener("load", () => {
      options.onProgress?.({ phase: "accepting", transferredBytes: totalBytes, totalBytes });
    });
    request.addEventListener("load", () => {
      let value: unknown;
      try {
        value = JSON.parse(request.responseText);
      } catch {
        value = null;
      }
      if (request.status >= 200 && request.status < 300) {
        finish(() => resolve(value as StartTurnResponse));
        return;
      }
      const error = value as {
        error?: { code?: string; message?: string; retryable?: boolean; diagnosticRef?: string };
      } | null;
      const failure = new ClientInterfaceError(
        request.status,
        error?.error?.code ?? `http-${request.status}`,
        error?.error?.message ?? `Connect Client 请求失败（HTTP ${request.status}）`,
        error?.error?.retryable ?? request.status >= 500,
        error?.error?.diagnosticRef,
      );
      if (error?.error?.code) {
        finish(() => reject(failure));
        return;
      }
      void requestOutcome(draft.sessionRef, draft.submissionId, "GET").then(
        (outcome) =>
          finish(() => {
            if ("accepted" in outcome) resolve(outcome);
            else if ("cancelled" in outcome) reject(new TurnSubmissionCancelledError());
            else
              reject(
                new ClientInterfaceError(0, "submission-outcome-unknown", "无法确认提交结果，请使用相同提交重试", true),
              );
          }),
        () => finish(() => reject(failure)),
      );
    });
    request.addEventListener("abort", () => {
      if (!options.signal?.aborted) {
        finish(() =>
          reject(new ClientInterfaceError(0, "submission-outcome-unknown", "无法确认提交结果，请重试", true)),
        );
      }
    });
    request.addEventListener("error", () => {
      finish(() => reject(new ClientInterfaceError(0, "submission-outcome-unknown", "无法确认提交结果，请重试", true)));
    });
    request.send(body);
  });
}

export async function cancelTurnSubmission(
  sessionRef: string,
  submissionId: string,
): Promise<StartTurnResponse | { cancelled: true; submissionId: string; sessionRef: string }> {
  let outcome = await requestOutcome(sessionRef, submissionId, "DELETE");
  for (let attempt = 0; "pending" in outcome && attempt < 20; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    outcome = await requestOutcome(sessionRef, submissionId, "GET");
  }
  if ("pending" in outcome) {
    throw new ClientInterfaceError(0, "submission-outcome-unknown", "无法确认提交结果，请使用相同提交重试", true);
  }
  return outcome;
}

async function requestOutcome(
  sessionRef: string,
  submissionId: string,
  method: "GET" | "DELETE",
): Promise<SubmissionOutcome> {
  const response = await fetch(submissionUrl(sessionRef, submissionId), {
    method,
    headers: { Accept: "application/json" },
  });
  const value = (await response.json().catch(() => null)) as
    | SubmissionOutcome
    | { error?: { code?: string; message?: string; retryable?: boolean; diagnosticRef?: string } }
    | null;
  if (response.ok) return value as SubmissionOutcome;
  const error = value && "error" in value ? value.error : undefined;
  if (error?.code === "submission-cancelled") {
    return { cancelled: true, submissionId, sessionRef };
  }
  throw new ClientInterfaceError(
    response.status,
    error?.code ?? `http-${response.status}`,
    error?.message ?? `Connect Client 请求失败（HTTP ${response.status}）`,
    error?.retryable ?? response.status >= 500,
    error?.diagnosticRef,
  );
}

function submissionUrl(sessionRef: string, submissionId: string): string {
  return `${CLIENT_API_PREFIX}/sessions/${encodeURIComponent(sessionRef)}/turn-submissions/${encodeURIComponent(submissionId)}`;
}
