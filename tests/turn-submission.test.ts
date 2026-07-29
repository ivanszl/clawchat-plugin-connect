import { describe, expect, mock, test } from "bun:test";
import {
  TurnSubmission,
  type TurnSubmissionCapability,
  type TurnSubmissionStaging,
} from "../src/client-interface/turn-submission";

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
  test("rolls back every staged attachment when queue acceptance fails", async () => {
    const rollback = mock(async () => undefined);
    const transfer = mock(() => undefined);
    const staging: TurnSubmissionStaging = {
      stage: mock(async () => ({
        media: [
          {
            kind: "image" as const,
            url: "/client/v1/turn-submissions/submission-1/attachments/0",
            stagedPath: "/owned/submission/image.png",
            name: "image.png",
            mime: "image/png",
            size: 4,
          },
        ],
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
            bytes: new Blob(["data"]),
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
          media: [],
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
            bytes: new Blob(["data"]),
          },
        ],
      }),
    ).rejects.toMatchObject({ code: "attachment-unsupported" });

    expect(rollback).toHaveBeenCalledTimes(1);
    expect(accept).not.toHaveBeenCalled();
  });
});
