import { describe, expect, test } from "bun:test";
import { ClientInterfaceError } from "../web/src/client-interface/http";
import { TurnSubmissionCancelledError } from "../web/src/client-interface/turn-submission";
import { TurnSubmissionIdentity } from "../web/src/features/composer/useTurnSubmission";

describe("Client Turn Submission ownership", () => {
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
});
