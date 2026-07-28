import { expect, it } from "bun:test";
import { ClawChatTurnSurface, ClientTurnSurface } from "../src/runtime/turn-surface";

it("projects every Runtime Activity before a ClawChat delivery failure", async () => {
  const order: string[] = [];
  const surface = new ClawChatTurnSurface({
    project: async (event) => {
      order.push(`project:${event.text}`);
    },
    materialize: (event) => ({ text: event.text, requiredControl: event.kind === "control" }),
    deliver: async (reply) => {
      order.push(`deliver:${reply.text}`);
      throw new Error("ClawChat unavailable");
    },
  });

  await expect(surface.accept({ kind: "control", text: "approval required" })).rejects.toThrow("ClawChat unavailable");
  expect(order).toEqual(["project:approval required", "deliver:approval required"]);
});

it("keeps Client-originated Runtime Activity local", async () => {
  const projected: string[] = [];
  const surface = new ClientTurnSurface({
    project: async (event) => {
      projected.push(event.text);
    },
  });

  await surface.accept({ kind: "final", text: "local result" });
  expect(projected).toEqual(["local result"]);
});
