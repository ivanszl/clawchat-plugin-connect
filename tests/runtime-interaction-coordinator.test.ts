import { describe, expect, it } from "bun:test";
import type { RuntimeInteractionBlock, RuntimeInteractionBlockContent } from "../src/client-contract";
import type { TranscriptProjection } from "../src/client-interface/transcript-projection";
import { RuntimeInteractionCoordinator } from "../src/runtime/runtime-interaction-coordinator";

class FakeProjection {
  readonly blocks: RuntimeInteractionBlock[] = [];

  constructor(private readonly beforeUpsert?: () => Promise<void>) {}

  async upsertRuntimeInteraction(
    _sessionRef: string,
    input: RuntimeInteractionBlockContent,
  ): Promise<RuntimeInteractionBlock> {
    await this.beforeUpsert?.();
    const previous = this.blocks.find((block) => block.id === input.id);
    const block = {
      ...input,
      revision: (previous?.revision ?? 0) + 1,
      sequence: previous?.sequence ?? this.blocks.length + 1,
      createdAt: previous?.createdAt ?? new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    const index = this.blocks.findIndex((candidate) => candidate.id === input.id);
    if (index >= 0) this.blocks[index] = block;
    else this.blocks.push(block);
    return block;
  }
}

describe("RuntimeInteractionCoordinator", () => {
  it("settles an approval once and rejects a late response", async () => {
    const projection = new FakeProjection();
    const coordinator = new RuntimeInteractionCoordinator(projection as unknown as TranscriptProjection);
    const result = coordinator.request(
      {
        kind: "approval",
        action: "command",
        title: "Run?",
        description: "git push",
        command: "git push",
        options: [
          { id: "approve-once", label: "Approve once" },
          { id: "deny", label: "Deny" },
        ],
      },
      { sessionRef: "ABCDEFGH", turnId: "turn-1", origin: "client" },
    );
    await waitFor(() => projection.blocks.length === 1);
    const interactionId = projection.blocks[0]?.interactionId ?? "";

    await expect(
      coordinator.respond(interactionId, { requestId: "request-1", optionId: "approve-once" }),
    ).resolves.toMatchObject({ responseState: "resolved", resolvedOptionId: "approve-once" });
    await expect(result).resolves.toEqual({ kind: "approval", optionId: "approve-once" });
    await expect(coordinator.respond(interactionId, { requestId: "request-2", optionId: "deny" })).rejects.toEqual(
      expect.objectContaining({ code: "interaction-not-pending" }),
    );
  });

  it("returns secret answers without projecting their values", async () => {
    const projection = new FakeProjection();
    const coordinator = new RuntimeInteractionCoordinator(projection as unknown as TranscriptProjection);
    const result = coordinator.request(
      {
        kind: "user-input",
        title: "Credentials",
        description: "Enter token",
        autoResolutionMs: null,
        questions: [
          {
            id: "token",
            header: "Token",
            prompt: "Secret token",
            secret: true,
            allowOther: false,
            options: null,
          },
        ],
      },
      { sessionRef: "ABCDEFGH", turnId: "turn-1", origin: "client" },
    );
    await waitFor(() => projection.blocks.length === 1);
    const interactionId = projection.blocks[0]?.interactionId ?? "";
    await coordinator.respond(interactionId, { requestId: "request-1", answers: { token: ["top-secret"] } });

    await expect(result).resolves.toEqual({ kind: "user-input", answers: { token: ["top-secret"] } });
    expect(JSON.stringify(projection.blocks)).not.toContain("top-secret");
    expect(projection.blocks[0]).toMatchObject({ responseState: "resolved", plainText: "Credentials\n已安全回答" });
  });

  it("expires an Interaction when its Runtime Turn aborts during initial projection", async () => {
    let releaseProjection: (() => void) | undefined;
    let firstProjection = true;
    const projectionStarted = Promise.withResolvers<void>();
    const projection = new FakeProjection(async () => {
      if (!firstProjection) return;
      firstProjection = false;
      await new Promise<void>((resolve) => {
        projectionStarted.resolve();
        releaseProjection = resolve;
      });
    });
    const coordinator = new RuntimeInteractionCoordinator(projection as unknown as TranscriptProjection);
    const controller = new AbortController();
    const result = coordinator.request(
      {
        kind: "approval",
        action: "command",
        title: "Run?",
        description: "git push",
        options: [{ id: "deny", label: "Deny" }],
      },
      { sessionRef: "ABCDEFGH", turnId: "turn-abort", origin: "client", signal: controller.signal },
    );

    await projectionStarted.promise;
    controller.abort();
    releaseProjection?.();

    await expect(
      Promise.race([
        result,
        Bun.sleep(20).then(() => {
          throw new Error("Interaction did not settle after abort");
        }),
      ]),
    ).rejects.toMatchObject({ code: "interaction-expired" });
    expect(projection.blocks.at(-1)).toMatchObject({
      responseState: "expired",
      state: "cancelled",
      resolvedBy: "system",
    });
    expect(coordinator.hasPending("ABCDEFGH")).toBe(false);
  });
});

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (predicate()) return;
    await Bun.sleep(0);
  }
  throw new Error("condition was not reached");
}
