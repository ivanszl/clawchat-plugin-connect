import { useMutation } from "@tanstack/react-query";
import { useRef, useState } from "react";
import { ClientInterfaceError, requestId } from "../../client-interface/http";
import { submitTurn, type TurnSubmissionProgress } from "../../client-interface/turn-submission";

export function useTurnSubmission(sessionRef: string) {
  const controller = useRef<AbortController | null>(null);
  const retryIdentity = useRef<string | null>(null);
  const [progress, setProgress] = useState<TurnSubmissionProgress | null>(null);
  const mutation = useMutation({
    mutationFn: async ({ prompt, files }: { prompt: string; files: File[] }) => {
      const submissionId = retryIdentity.current ?? requestId();
      retryIdentity.current = submissionId;
      const abort = new AbortController();
      controller.current = abort;
      try {
        const accepted = await submitTurn(
          {
            submissionId,
            sessionRef,
            prompt,
            attachments: [...files],
          },
          { signal: abort.signal, onProgress: setProgress },
        );
        retryIdentity.current = null;
        return accepted;
      } catch (error) {
        const ambiguous =
          error instanceof ClientInterfaceError &&
          (error.code === "submission-outcome-unknown" || error.code === "command-in-progress");
        if (!ambiguous) retryIdentity.current = null;
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
