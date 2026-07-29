import { expect, it } from "bun:test";
import { ClawChatTurnSurface, ClientTurnSurface } from "../src/runtime/turn-surface";
import type { RuntimeActivity } from "../src/runtime/types";

function activity(id: string, kind: RuntimeActivity["kind"], text: string, outputKind: string): RuntimeActivity {
  return {
    id,
    position: id,
    parentId: null,
    kind,
    text,
    state: "complete",
    source: "live",
    data: { outputKind, requiredControl: outputKind === "control" },
  };
}

it("projects every Runtime Activity before a ClawChat delivery failure", async () => {
  const order: string[] = [];
  const surface = new ClawChatTurnSurface({
    project: async (event) => {
      order.push(`project:${event.text}`);
    },
    materialize: (event) => ({ text: event.text, requiredControl: event.data?.requiredControl === true }),
    deliver: async (reply) => {
      order.push(`deliver:${reply.text}`);
      throw new Error("ClawChat unavailable");
    },
  });

  await expect(surface.accept(activity("control", "error", "approval required", "control"))).rejects.toThrow(
    "ClawChat unavailable",
  );
  expect(order).toEqual(["project:approval required", "deliver:approval required"]);
});

it("delivers only the completed current state when a Runtime Activity streamed before turn completion", async () => {
  const projected: string[] = [];
  const delivered: string[] = [];
  const surface = new ClawChatTurnSurface({
    project: async (event) => {
      projected.push(`${event.state}:${event.text}`);
    },
    materialize: (event) => ({ text: event.text, requiredControl: false }),
    deliver: async (reply) => {
      delivered.push(reply.text);
    },
  });

  await surface.accept({ ...activity("agent-message", "assistant", "hel", "assistant"), state: "streaming" });
  await surface.accept({ ...activity("agent-message", "assistant", "hello", "assistant"), state: "streaming" });
  await surface.accept(activity("agent-message", "assistant", "hello", "final"));
  await surface.complete();

  expect(projected).toEqual(["streaming:hel", "streaming:hello", "complete:hello"]);
  expect(delivered).toEqual(["hello"]);
});

it("keeps Client-originated Runtime Activity local", async () => {
  const projected: string[] = [];
  const surface = new ClientTurnSurface({
    project: async (event) => {
      projected.push(event.text);
    },
  });

  await surface.accept(activity("result", "assistant", "local result", "final"));
  expect(projected).toEqual(["local result"]);
});

it("projects Client-specific turn failures through the Client Turn Surface", async () => {
  const projected: string[] = [];
  const surface = new ClientTurnSurface({
    project: async (event) => {
      projected.push(event.text);
    },
  });

  await surface.fail(new Error("runtime stopped"));

  expect(projected).toEqual(["Connect Client turn failed: runtime stopped"]);
});
