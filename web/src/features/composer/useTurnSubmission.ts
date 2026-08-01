import { useMutation } from "@tanstack/react-query";
import { useRef, useState } from "react";
import type { SlashSuggestionView } from "../../../../src/client-contract";
import { ClientInterfaceError, requestId } from "../../client-interface/http";
import {
  submitTurn,
  TurnSubmissionCancelledError,
  type TurnSubmissionProgress,
} from "../../client-interface/turn-submission";

export function useTurnSubmission(sessionRef: string) {
  const controller = useRef<AbortController | null>(null);
  const retryIdentity = useRef(new TurnSubmissionIdentity());
  const [progress, setProgress] = useState<TurnSubmissionProgress | null>(null);
  const mutation = useMutation({
    mutationFn: async ({
      prompt,
      files,
      selection,
    }: {
      prompt: string;
      files: File[];
      selection: SlashSuggestionView | null;
    }) => {
      const submissionId = retryIdentity.current.begin(requestId);
      const abort = new AbortController();
      controller.current = abort;
      try {
        const accepted = await submitTurn(
          {
            submissionId,
            sessionRef,
            prompt,
            selection,
            attachments: [...files],
          },
          { signal: abort.signal, onProgress: setProgress },
        );
        retryIdentity.current.accepted();
        return accepted;
      } catch (error) {
        retryIdentity.current.failed(error);
        throw error;
      } finally {
        controller.current = null;
      }
    },
    onSettled: () => setProgress(null),
  });
  return {
    ...mutation,
    progress,
    cancel: () => controller.current?.abort(),
  };
}

export class TurnSubmissionIdentity {
  private value: string | null = null;

  begin(create: () => string): string {
    this.value ??= create();
    return this.value;
  }

  accepted(): void {
    this.value = null;
  }

  failed(error: unknown): void {
    const outcomeUnknown =
      error instanceof ClientInterfaceError &&
      (error.code === "submission-outcome-unknown" || error.code === "command-in-progress");
    const terminalCancellation =
      error instanceof TurnSubmissionCancelledError ||
      (error instanceof ClientInterfaceError && error.code === "submission-cancelled");
    if (terminalCancellation || !outcomeUnknown) this.value = null;
  }
}
