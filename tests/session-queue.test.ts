import { describe, expect, it } from "bun:test";
import { SessionQueue } from "../src/runtime/session-queue";

describe("SessionQueue", () => {
  it("returns an immediate ticket and lets callers cancel queued work", async () => {
    const queue = new SessionQueue({ maxConcurrentTurns: 1 });
    let releaseFirst: () => void = () => undefined;
    const first = queue.submit(
      "a",
      async () =>
        await new Promise<void>((resolve) => {
          releaseFirst = resolve;
        }),
    );
    await Bun.sleep(0);
    const secondRan: string[] = [];
    const second = queue.submit("a", async () => {
      secondRan.push("ran");
    });

    expect(first.state).toBe("running");
    expect(second.state).toBe("queued");
    expect(second.cancel()).toBe(true);
    expect(second.state).toBe("cancelled");
    await expect(second.completion).rejects.toThrow("cancelled before execution");
    expect(secondRan).toEqual([]);

    releaseFirst();
    await first.completion;
  });

  it("serializes turns per Session while allowing different Sessions", async () => {
    const queue = new SessionQueue({ maxConcurrentTurns: 2 });
    const order: string[] = [];
    await Promise.all([
      queue.enqueue("a", async () => {
        order.push("a1");
        await Promise.resolve();
        order.push("a1done");
      }),
      queue.enqueue("a", async () => {
        order.push("a2");
      }),
      queue.enqueue("b", async () => {
        order.push("b1");
      }),
    ]);
    expect(order.indexOf("a1done")).toBeLessThan(order.indexOf("a2"));
    expect(order).toContain("b1");
  });
  it("rejects queue overflow visibly to caller", async () => {
    const queue = new SessionQueue({ maxConcurrentTurns: 1, maxPendingPerSession: 1 });
    const blocker = queue.enqueue("a", async () => await new Promise((resolve) => setTimeout(resolve, 10)));
    const queued = queue.enqueue("a", async () => undefined);
    await expect(queue.enqueue("a", async () => undefined)).rejects.toThrow(/too many pending turns for Session a/);
    await Promise.all([blocker, queued]);
  });
  it("does not persist Turn acceptance when queue capacity rejects the submission", async () => {
    const queue = new SessionQueue({ maxConcurrentTurns: 1, maxPendingPerSession: 1 });
    let release: () => void = () => undefined;
    let markStarted: () => void = () => undefined;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const running = queue.submit("a", async () => {
      markStarted();
      await new Promise<void>((resolve) => {
        release = resolve;
      });
    });
    await started;
    const queued = queue.submit("a", async () => undefined);
    let accepted = false;

    await expect(
      queue.submitAccepted(
        "a",
        async () => undefined,
        async () => {
          accepted = true;
        },
      ),
    ).rejects.toThrow("too many pending turns");
    expect(accepted).toBe(false);

    release();
    await Promise.all([running.completion, queued.completion]);
  });

  it("claims a Session for lifecycle after cancelling queued turns and rejects new turns until completion", async () => {
    const queue = new SessionQueue({ maxConcurrentTurns: 1 });
    let finishRunning: (() => void) | undefined;
    const running = queue.enqueue(
      "a",
      async () =>
        await new Promise<void>((resolve) => {
          finishRunning = resolve;
        }),
    );
    await Bun.sleep(0);
    const queued = queue.enqueue("a", async () => {
      throw new Error("queued turn must not run");
    });
    const lifecycle = queue.claim("a", async () => "deleted");

    await expect(queued).rejects.toThrow("Session a lifecycle operation started");
    await expect(queue.enqueue("a", async () => undefined)).rejects.toThrow(
      "Session a lifecycle operation is in progress",
    );
    finishRunning?.();
    await expect(running).resolves.toBeUndefined();
    await expect(lifecycle).resolves.toBe("deleted");
    await expect(queue.enqueue("a", async () => undefined)).resolves.toBeUndefined();
  });
});
