import { describe, expect, mock, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  TurnSubmission,
  type TurnSubmissionCapability,
  type TurnSubmissionStaging,
} from "../src/client-interface/turn-submission";
import { FileTurnSubmissionStaging } from "../src/client-interface/turn-submission-staging";

const capability: TurnSubmissionCapability = {
  prompt: { allowed: true, required: false, maxCharacters: 64_000 },
  attachments: {
    allowedKinds: ["image"],
    allowedMediaTypes: ["image/*"],
    maxCount: 10,
    maxBytesEach: 100 * 1024 * 1024,
    maxBytesTotal: 100 * 1024 * 1024,
  },
};

describe("TurnSubmission", () => {
  test("accepts text-only and capability-permitted attachment-only drafts", async () => {
    const accepted = mock(async (sessionRef: string) => ({
      accepted: true as const,
      turnId: "turn-accepted",
      sessionRef,
    }));
    const staging: TurnSubmissionStaging = {
      stage: async () => ({ rollback: async () => undefined, transfer: () => undefined }),
    };
    const submissions = new TurnSubmission({ capabilityFor: async () => capability, staging, accept: accepted });

    await expect(
      submissions.submit({
        submissionId: "text-only",
        sessionRef: "NKEP79B8",
        prompt: "hello",
        attachments: [],
      }),
    ).resolves.toMatchObject({ accepted: true });
    await expect(
      submissions.submit({
        submissionId: "attachment-only",
        sessionRef: "NKEP79B8",
        prompt: "",
        attachments: [
          {
            name: "image.png",
            mime: "image/png",
            size: 4,
            readBytes: async () => new TextEncoder().encode("data"),
          },
        ],
      }),
    ).resolves.toMatchObject({ accepted: true });
  });

  test("rolls back every staged attachment when queue acceptance fails", async () => {
    const rollback = mock(async () => undefined);
    const transfer = mock(() => undefined);
    const staging: TurnSubmissionStaging = {
      stage: mock(async () => ({
        rollback,
        transfer,
      })),
    };
    const accept = mock(async () => {
      throw new Error("queue unavailable");
    });
    const submissions = new TurnSubmission({
      capabilityFor: async () => capability,
      staging,
      accept,
    });

    await expect(
      submissions.submit({
        submissionId: "submission-1",
        sessionRef: "NKEP79B8",
        prompt: "inspect",
        attachments: [
          {
            name: "image.png",
            mime: "image/png",
            size: 4,
            readBytes: async () => new TextEncoder().encode("data"),
          },
        ],
      }),
    ).rejects.toThrow("queue unavailable");

    expect(rollback).toHaveBeenCalledTimes(1);
    expect(transfer).not.toHaveBeenCalled();
  });

  test("revalidates capability after staging and rolls back when the effective model changed", async () => {
    const rollback = mock(async () => undefined);
    const accept = mock(async () => ({
      accepted: true as const,
      turnId: "turn-1",
      sessionRef: "NKEP79B8",
    }));
    let capabilityRead = 0;
    const submissions = new TurnSubmission({
      capabilityFor: async () => {
        capabilityRead += 1;
        return capabilityRead === 1
          ? capability
          : { ...capability, attachments: { ...capability.attachments, allowedKinds: [] } };
      },
      staging: {
        stage: async () => ({
          rollback,
          transfer: () => undefined,
        }),
      },
      accept,
    });

    await expect(
      submissions.submit({
        submissionId: "submission-2",
        sessionRef: "NKEP79B8",
        prompt: "",
        attachments: [
          {
            name: "image.png",
            mime: "image/png",
            size: 4,
            readBytes: async () => new TextEncoder().encode("data"),
          },
        ],
      }),
    ).rejects.toMatchObject({ code: "attachment-unsupported" });

    expect(rollback).toHaveBeenCalledTimes(1);
    expect(accept).not.toHaveBeenCalled();
  });

  test("rolls staging back when cancellation wins before queue acceptance", async () => {
    const rollback = mock(async () => undefined);
    const controller = new AbortController();
    const submissions = new TurnSubmission({
      capabilityFor: async () => capability,
      staging: {
        stage: async () => ({ rollback, transfer: () => undefined }),
      },
      accept: async (_sessionRef, _prompt, _staged, signal) =>
        await new Promise((_, reject) => {
          signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
          controller.abort();
        }),
    });

    await expect(
      submissions.submit(
        { submissionId: "cancelled", sessionRef: "NKEP79B8", prompt: "stop", attachments: [] },
        controller.signal,
      ),
    ).rejects.toHaveProperty("name", "AbortError");
    expect(rollback).toHaveBeenCalledTimes(1);
  });

  test("rejects when deterministic attachment bytes differ from the declared size", async () => {
    const directory = await mkdtemp(join(tmpdir(), "connect-turn-submission-"));
    try {
      const staging = new FileTurnSubmissionStaging(join(directory, "state.sqlite"));
      await expect(
        staging.stage({
          submissionId: "size-mismatch",
          sessionRef: "NKEP79B8",
          prompt: "",
          attachments: [
            {
              name: "image.png",
              mime: "image/png",
              size: 5,
              readBytes: async () => new TextEncoder().encode("data"),
            },
          ],
        }),
      ).rejects.toMatchObject({ code: "attachment-size-mismatch" });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
