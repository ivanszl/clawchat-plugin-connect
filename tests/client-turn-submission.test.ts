import { describe, expect, mock, test } from "bun:test";
import { ClientInterfaceError } from "../web/src/client-interface/http";
import {
  cancelTurnSubmission,
  formatTurnSubmissionError,
  submitTurn,
  TurnSubmissionCancelledError,
} from "../web/src/client-interface/turn-submission";
import { TurnSubmissionIdentity } from "../web/src/features/composer/useTurnSubmission";

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

  test("retries an unknown outcome with the same identity", () => {
    const identity = new TurnSubmissionIdentity();
    expect(identity.begin(() => "submission-1")).toBe("submission-1");

    identity.failed(new ClientInterfaceError(0, "submission-outcome-unknown", "unknown", true));

    expect(identity.begin(() => "submission-2")).toBe("submission-1");
  });

  test("clears identity after authoritative acceptance or cancellation", () => {
    const identity = new TurnSubmissionIdentity();
    expect(identity.begin(() => "submission-1")).toBe("submission-1");
    identity.failed(new TurnSubmissionCancelledError());
    expect(identity.begin(() => "submission-2")).toBe("submission-2");
    identity.accepted();
    expect(identity.begin(() => "submission-3")).toBe("submission-3");
  });

  test("treats queue acceptance as authoritative when cancellation races it", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mock(
      async () =>
        new Response(JSON.stringify({ accepted: true, turnId: "turn-1", sessionRef: "NKEP79B8" }), {
          status: 202,
          headers: { "content-type": "application/json" },
        }),
    ) as unknown as typeof fetch;
    try {
      await expect(cancelTurnSubmission("NKEP79B8", "submission-1")).resolves.toEqual({
        accepted: true,
        turnId: "turn-1",
        sessionRef: "NKEP79B8",
      });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("polls a pending cancellation until the server reports its terminal outcome", async () => {
    const originalFetch = globalThis.fetch;
    let requests = 0;
    globalThis.fetch = mock(async () => {
      requests += 1;
      return new Response(
        JSON.stringify(
          requests === 1
            ? { pending: true, submissionId: "submission-1", sessionRef: "NKEP79B8" }
            : { error: { code: "submission-cancelled", message: "cancelled", retryable: false } },
        ),
        {
          status: requests === 1 ? 202 : 409,
          headers: { "content-type": "application/json" },
        },
      );
    }) as unknown as typeof fetch;
    try {
      await expect(cancelTurnSubmission("NKEP79B8", "submission-1")).resolves.toMatchObject({
        cancelled: true,
      });
      expect(requests).toBe(2);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("surfaces a failed authoritative cancellation request", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mock(
      async () =>
        new Response(JSON.stringify({ error: { code: "runtime-offline", message: "offline", retryable: true } }), {
          status: 503,
          headers: { "content-type": "application/json" },
        }),
    ) as unknown as typeof fetch;
    try {
      await expect(cancelTurnSubmission("NKEP79B8", "submission-1")).rejects.toMatchObject({
        code: "runtime-offline",
        retryable: true,
      });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("resolves transport abort through the server cancellation outcome", async () => {
    const originalFetch = globalThis.fetch;
    const originalXhr = globalThis.XMLHttpRequest;
    class FakeXMLHttpRequest extends EventTarget {
      readonly upload = new EventTarget();
      status = 0;
      responseText = "";
      open(): void {}
      setRequestHeader(): void {}
      send(): void {}
      abort(): void {
        this.dispatchEvent(new Event("abort"));
      }
    }
    globalThis.XMLHttpRequest = FakeXMLHttpRequest as unknown as typeof XMLHttpRequest;
    globalThis.fetch = mock(
      async () =>
        new Response(JSON.stringify({ cancelled: true, submissionId: "submission-1", sessionRef: "NKEP79B8" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    ) as unknown as typeof fetch;
    const controller = new AbortController();
    try {
      const submission = submitTurn(
        {
          submissionId: "submission-1",
          sessionRef: "NKEP79B8",
          prompt: "hello",
          attachments: [],
        },
        { signal: controller.signal },
      );
      controller.abort();
      await expect(submission).rejects.toBeInstanceOf(TurnSubmissionCancelledError);
    } finally {
      globalThis.fetch = originalFetch;
      globalThis.XMLHttpRequest = originalXhr;
    }
  });

  test("reconciles a non-Connect HTTP failure with an accepted submission outcome", async () => {
    const originalFetch = globalThis.fetch;
    const originalXhr = globalThis.XMLHttpRequest;
    class FakeXMLHttpRequest extends EventTarget {
      readonly upload = new EventTarget();
      status = 400;
      responseText = "upstream response was interrupted";
      open(): void {}
      setRequestHeader(): void {}
      send(): void {
        queueMicrotask(() => this.dispatchEvent(new Event("load")));
      }
      abort(): void {}
    }
    globalThis.XMLHttpRequest = FakeXMLHttpRequest as unknown as typeof XMLHttpRequest;
    globalThis.fetch = mock(async (input, init) => {
      expect(String(input)).toBe("/client/v1/sessions/NKEP79B8/turn-submissions/submission-1");
      expect(init?.method).toBe("GET");
      return new Response(JSON.stringify({ accepted: true, turnId: "turn-1", sessionRef: "NKEP79B8" }), {
        status: 202,
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof fetch;
    try {
      await expect(
        submitTurn({
          submissionId: "submission-1",
          sessionRef: "NKEP79B8",
          prompt: "hello",
          attachments: [],
        }),
      ).resolves.toEqual({ accepted: true, turnId: "turn-1", sessionRef: "NKEP79B8" });
    } finally {
      globalThis.fetch = originalFetch;
      globalThis.XMLHttpRequest = originalXhr;
    }
  });
});
