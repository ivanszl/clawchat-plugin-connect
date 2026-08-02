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
    deliver: async (_event, reply) => {
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
    deliver: async (_event, reply) => {
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

it("suppresses buffered group output when the terminal response is no-reply", async () => {
  const projected: string[] = [];
  const delivered: string[] = [];
  const surface = new ClawChatTurnSurface({
    noReplyProtocol: true,
    project: async (event) => {
      projected.push(event.text);
    },
    materialize: (event) => ({ text: event.text, requiredControl: false }),
    deliver: async (_event, reply) => {
      delivered.push(reply.text);
    },
  });

  await surface.accept(activity("thinking", "reasoning", "checking", "reasoning"));
  await surface.accept(activity("progress", "progress", "still working", "progress"));
  await surface.accept(activity("draft", "assistant", "maybe this", "assistant"));
  await surface.accept(activity("final", "assistant", "<clawchat:no-reply/>", "final"));
  await surface.complete();

  expect(projected).toEqual(["checking", "still working", "maybe this", "<clawchat:no-reply/>"]);
  expect(delivered).toEqual([]);
});

it("keeps required group controls immediate when a later response is no-reply", async () => {
  const delivered: string[] = [];
  const surface = new ClawChatTurnSurface({
    noReplyProtocol: true,
    project: async () => undefined,
    materialize: (event) => ({ text: event.text, requiredControl: event.data?.requiredControl === true }),
    deliver: async (_event, reply) => {
      delivered.push(reply.text);
    },
  });

  await surface.accept(activity("control", "error", "approval required", "control"));
  await surface.accept(activity("final", "assistant", "[ClawChat : no_reply]", "final"));
  await surface.complete();

  expect(delivered).toEqual(["approval required"]);
});

it("strips a group no-reply signal while preserving explicit media", async () => {
  const delivered: string[] = [];
  const surface = new ClawChatTurnSurface({
    noReplyProtocol: true,
    project: async () => undefined,
    materialize: (event) => ({ text: event.text, requiredControl: false }),
    deliver: async (_event, reply) => {
      delivered.push(reply.text);
    },
  });

  await surface.accept(
    activity("final", "assistant", "<clawchat:noreply/>\nHere it is: ![chart](./chart.png)", "final"),
  );
  await surface.complete();

  expect(delivered).toEqual(["Here it is: ![chart](./chart.png)"]);
});

it("does not interpret no-reply syntax on a direct ClawChat surface", async () => {
  const delivered: string[] = [];
  const surface = new ClawChatTurnSurface({
    project: async () => undefined,
    materialize: (event) => ({ text: event.text, requiredControl: false }),
    deliver: async (_event, reply) => {
      delivered.push(reply.text);
    },
  });

  await surface.accept(activity("final", "assistant", "<clawchat:no-reply/>", "final"));
  await surface.complete();

  expect(delivered).toEqual(["<clawchat:no-reply/>"]);
});

it("does not suppress ordinary group prose that merely discusses a missing reply", async () => {
  const delivered: string[] = [];
  const surface = new ClawChatTurnSurface({
    noReplyProtocol: true,
    project: async () => undefined,
    materialize: (event) => ({ text: event.text, requiredControl: false }),
    deliver: async (_event, reply) => {
      delivered.push(reply.text);
    },
  });

  await surface.accept(activity("final", "assistant", "There is no reply from the server yet.", "final"));
  await surface.complete();

  expect(delivered).toEqual(["There is no reply from the server yet."]);
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
