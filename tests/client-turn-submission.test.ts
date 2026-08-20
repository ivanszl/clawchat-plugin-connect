import { describe, expect, mock, test } from "bun:test";
import { ClientInterfaceError } from "../web/src/client-interface/http";
import {
  discardTurnSubmission,
  formatTurnSubmissionError,
  retryTurnSubmission,
  submitTurn,
} from "../web/src/client-interface/turn-submission";

describe("Client Turn Submission ownership", () => {
  test("localizes known submission failures by stable code and preserves diagnostic references", () => {
    const error = new ClientInterfaceError(
      400,
      "attachment-too-large",
      "runtime wording that must not select the translation",
      false,
      "diag-λ-2048",
    );

    expect(
      formatTurnSubmissionError(error, (key, values) => {
        if (key === "@connect.composer.error.attachmentTooLarge") return "The attachment is too large.";
        if (key === "@connect.composer.error.withDiagnostic") {
          return `${String(values?.message)} Diagnostic reference: ${String(values?.reference)}`;
        }
        return key;
      }),
    ).toBe("The attachment is too large. Diagnostic reference: diag-λ-2048");
  });

  test("keeps unknown server messages and diagnostic references unchanged", () => {
    const error = new ClientInterfaceError(502, "new-runtime-failure", "Runtime says: α/β failed", true, "raw-ref-908");

    expect(
      formatTurnSubmissionError(error, (key, values) =>
        key === "@connect.composer.error.withDiagnostic"
          ? `${String(values?.message)} [${String(values?.reference)}]`
          : key,
      ),
    ).toBe("Runtime says: α/β failed [raw-ref-908]");
  });

  test("returns as soon as the server durably owns a pending submission", async () => {
    const originalFetch = globalThis.fetch;
    const response = {
      submissionId: "submission-1",
      messageId: "turn_submission-1_user",
      sessionRef: "NKEP79B8",
      state: "pending",
      turnId: null,
      error: null,
    } as const;
    globalThis.fetch = mock(async (input, init) => {
      expect(String(input)).toBe("/client/v1/sessions/NKEP79B8/turn-submissions/submission-1");
      expect(init?.method).toBe("POST");
      expect(init?.body).toBeInstanceOf(FormData);
      return Response.json(response, { status: 202 });
    }) as unknown as typeof fetch;
    try {
      await expect(
        submitTurn({
          submissionId: "submission-1",
          sessionRef: "NKEP79B8",
          prompt: "hello",
          attachments: [],
        }),
      ).resolves.toEqual(response);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("reconciles an interrupted response from the durable submission outcome", async () => {
    const originalFetch = globalThis.fetch;
    let requests = 0;
    const outcome = {
      submissionId: "submission-1",
      messageId: "turn_submission-1_user",
      sessionRef: "NKEP79B8",
      state: "failed",
      turnId: null,
      error: { code: "runtime-offline", message: "offline", retryable: true },
    } as const;
    globalThis.fetch = mock(async (_input, init) => {
      requests += 1;
      if (init?.method === "POST") throw new TypeError("connection reset");
      return Response.json(outcome);
    }) as unknown as typeof fetch;
    try {
      await expect(
        submitTurn({
          submissionId: "submission-1",
          sessionRef: "NKEP79B8",
          prompt: "hello",
          attachments: [],
        }),
      ).resolves.toEqual(outcome);
      expect(requests).toBe(2);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("uses explicit retry and discard endpoints for a failed message", async () => {
    const originalFetch = globalThis.fetch;
    const requests: Array<{ url: string; method: string }> = [];
    globalThis.fetch = mock(async (input, init) => {
      requests.push({ url: String(input), method: init?.method ?? "GET" });
      if (String(input).endsWith("/retry")) {
        return Response.json({
          submissionId: "submission-1",
          messageId: "turn_submission-1_user",
          sessionRef: "NKEP79B8",
          state: "pending",
          turnId: null,
          error: null,
        });
      }
      return Response.json({ submissionId: "submission-1", sessionRef: "NKEP79B8", discarded: true });
    }) as unknown as typeof fetch;
    try {
      await retryTurnSubmission("NKEP79B8", "submission-1");
      await discardTurnSubmission("NKEP79B8", "submission-1");
      expect(requests).toEqual([
        {
          url: "/client/v1/sessions/NKEP79B8/turn-submissions/submission-1/retry",
          method: "POST",
        },
        {
          url: "/client/v1/sessions/NKEP79B8/turn-submissions/submission-1",
          method: "DELETE",
        },
      ]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
