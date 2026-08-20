import type { InfiniteData } from "@tanstack/react-query";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import type {
  MessageBlock,
  SlashSuggestionView,
  TranscriptPageView,
  TurnSubmissionErrorView,
} from "../../../../src/client-contract";
import { ClientInterfaceError } from "../../client-interface/http";
import { clientKeys } from "../../client-interface/query-options";
import { retryTurnSubmission, submitTurn } from "../../client-interface/turn-submission";

interface TurnSubmissionVariables {
  submissionId: string;
  prompt: string;
  files: File[];
  selection: SlashSuggestionView | null;
}

interface LocalTurnSubmission extends TurnSubmissionVariables {
  sessionRef: string;
  objectUrls: string[];
}

const localTurnSubmissions = new Map<string, LocalTurnSubmission>();

export function useTurnSubmission(sessionRef: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ submissionId, prompt, files, selection }: TurnSubmissionVariables) =>
      await submitTurn({
        submissionId,
        sessionRef,
        prompt,
        selection,
        attachments: [...files],
      }),
    onMutate: ({ submissionId, prompt, files, selection }) => {
      const objectUrls = files.map((file) => URL.createObjectURL(file));
      localTurnSubmissions.set(submissionKey(sessionRef, submissionId), {
        submissionId,
        sessionRef,
        prompt,
        files,
        selection,
        objectUrls,
      });
      queryClient.setQueryData<InfiniteData<TranscriptPageView, string | null>>(
        clientKeys.transcript(sessionRef),
        (current) => appendOptimisticMessage(current, sessionRef, submissionId, prompt, files, objectUrls),
      );
      return { submissionId };
    },
    onError: (error, _variables, context) => {
      if (!context) return;
      queryClient.setQueryData<InfiniteData<TranscriptPageView, string | null>>(
        clientKeys.transcript(sessionRef),
        (current) => markUnpersistedMessageFailed(current, `turn_${context.submissionId}_user`, submissionError(error)),
      );
    },
    onSettled: async (_data, error, _variables, context) => {
      if (error) return;
      await queryClient.invalidateQueries({ queryKey: clientKeys.transcript(sessionRef) });
      if (context) releaseLocalTurnSubmission(sessionRef, context.submissionId);
    },
  });
}

export async function retryVisibleTurnSubmission(sessionRef: string, submissionId: string): Promise<void> {
  const local = localTurnSubmissions.get(submissionKey(sessionRef, submissionId));
  if (!local) {
    await retryTurnSubmission(sessionRef, submissionId);
    return;
  }
  await submitTurn({
    submissionId: local.submissionId,
    sessionRef: local.sessionRef,
    prompt: local.prompt,
    selection: local.selection,
    attachments: local.files,
  });
}

export function releaseLocalTurnSubmission(sessionRef: string, submissionId: string): void {
  const key = submissionKey(sessionRef, submissionId);
  const local = localTurnSubmissions.get(key);
  if (!local) return;
  localTurnSubmissions.delete(key);
  for (const url of local.objectUrls) URL.revokeObjectURL(url);
}

function submissionKey(sessionRef: string, submissionId: string): string {
  return `${sessionRef}:${submissionId}`;
}

function appendOptimisticMessage(
  current: InfiniteData<TranscriptPageView, string | null> | undefined,
  sessionRef: string,
  submissionId: string,
  prompt: string,
  files: File[],
  objectUrls: string[],
): InfiniteData<TranscriptPageView, string | null> | undefined {
  if (!current?.pages[0]) return current;
  const messageId = `turn_${submissionId}_user`;
  if (current.pages.some((page) => page.blocks.some((block) => block.id === messageId))) return current;
  const blocks = current.pages.flatMap((page) => page.blocks);
  const sequence = blocks.reduce((highest, block) => Math.max(highest, block.sequence), 0) + 1;
  const now = new Date().toISOString();
  const message: MessageBlock = {
    id: messageId,
    type: "message",
    origin: "client",
    state: "pending",
    plainText: prompt,
    role: "user",
    author: "You",
    markdown: prompt,
    media: files.map((file, index) => ({
      kind: mediaKind(file.type),
      url: objectUrls[index] ?? "",
      name: file.name,
      mime: file.type || null,
      width: null,
      height: null,
    })),
    delivery: {
      submissionId,
      state: "pending",
      error: null,
      allowedActions: [],
    },
    revision: 0,
    sequence,
    createdAt: now,
    updatedAt: now,
  };
  const pages = [...current.pages];
  pages[0] = { ...pages[0], sessionRef, blocks: [...pages[0].blocks, message] };
  return { ...current, pages };
}

function markUnpersistedMessageFailed(
  current: InfiniteData<TranscriptPageView, string | null> | undefined,
  messageId: string,
  error: TurnSubmissionErrorView,
): InfiniteData<TranscriptPageView, string | null> | undefined {
  if (!current) return current;
  const updatedAt = new Date().toISOString();
  return {
    ...current,
    pages: current.pages.map((page) => ({
      ...page,
      blocks: page.blocks.map((block) => {
        if (block.id !== messageId || block.type !== "message" || block.revision > 0 || !block.delivery) {
          return block;
        }
        return {
          ...block,
          state: "error",
          delivery: {
            ...block.delivery,
            state: "failed",
            error,
            allowedActions: ["retry"],
          },
          updatedAt,
        };
      }),
    })),
  };
}

function submissionError(error: unknown): TurnSubmissionErrorView {
  if (error instanceof ClientInterfaceError) {
    return {
      code: error.code,
      message: error.message,
      retryable: true,
      ...(error.diagnosticRef ? { diagnosticRef: error.diagnosticRef } : {}),
    };
  }
  return {
    code: "client-request-failed",
    message: error instanceof Error ? error.message : "Connect Client request failed",
    retryable: true,
  };
}

function mediaKind(mime: string): "image" | "file" | "audio" | "video" {
  if (mime.startsWith("image/")) return "image";
  if (mime.startsWith("audio/")) return "audio";
  if (mime.startsWith("video/")) return "video";
  return "file";
}
