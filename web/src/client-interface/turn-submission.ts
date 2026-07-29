import type { StartTurnResponse } from "../../../src/client-contract";
import { CLIENT_API_PREFIX } from "../../../src/client-contract";
import { ClientInterfaceError } from "./http";

export type TurnSubmissionPhase = "transferring" | "accepting";

export interface ClientTurnSubmission {
  submissionId: string;
  sessionRef: string;
  prompt: string;
  attachments: File[];
}

export interface TurnSubmissionProgress {
  phase: TurnSubmissionPhase;
  transferredBytes: number;
  totalBytes: number;
}

export function submitTurn(
  draft: ClientTurnSubmission,
  options: {
    signal?: AbortSignal;
    onProgress?: (progress: TurnSubmissionProgress) => void;
  } = {},
): Promise<StartTurnResponse> {
  const totalBytes = draft.attachments.reduce((total, file) => total + file.size, 0);
  const body = new FormData();
  body.append("submissionId", draft.submissionId);
  body.append("prompt", draft.prompt);
  for (const file of draft.attachments) body.append("attachments", file, file.name);
  options.onProgress?.({ phase: "transferring", transferredBytes: 0, totalBytes });

  return new Promise((resolve, reject) => {
    const request = new XMLHttpRequest();
    const abort = () => request.abort();
    options.signal?.addEventListener("abort", abort, { once: true });
    request.open("POST", `${CLIENT_API_PREFIX}/sessions/${encodeURIComponent(draft.sessionRef)}/turn-submissions`);
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
      options.signal?.removeEventListener("abort", abort);
      let value: unknown;
      try {
        value = JSON.parse(request.responseText);
      } catch {
        value = null;
      }
      if (request.status >= 200 && request.status < 300) {
        resolve(value as StartTurnResponse);
        return;
      }
      const error = value as {
        error?: { code?: string; message?: string; retryable?: boolean; diagnosticRef?: string };
      } | null;
      reject(
        new ClientInterfaceError(
          request.status,
          error?.error?.code ?? `http-${request.status}`,
          error?.error?.message ?? `Connect Client 请求失败（HTTP ${request.status}）`,
          error?.error?.retryable ?? request.status >= 500,
          error?.error?.diagnosticRef,
        ),
      );
    });
    request.addEventListener("abort", () => {
      options.signal?.removeEventListener("abort", abort);
      reject(new DOMException("Turn Submission was cancelled", "AbortError"));
    });
    request.addEventListener("error", () => {
      options.signal?.removeEventListener("abort", abort);
      reject(new ClientInterfaceError(0, "submission-outcome-unknown", "无法确认提交结果，请重试", true));
    });
    request.send(body);
  });
}
