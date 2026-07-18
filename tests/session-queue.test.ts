import { describe, expect, it } from "bun:test";
import { SessionQueue } from "../src/runtime/session-queue";

describe("SessionQueue", () => {
  it("serializes turns per chat while allowing different chats", async () => {
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
    const queue = new SessionQueue({ maxConcurrentTurns: 1, maxPendingPerChat: 1 });
    const blocker = queue.enqueue("a", async () => await new Promise((resolve) => setTimeout(resolve, 10)));
    const queued = queue.enqueue("a", async () => undefined);
    await expect(queue.enqueue("a", async () => undefined)).rejects.toThrow(/too many pending/);
    await Promise.all([blocker, queued]);
  });
});
