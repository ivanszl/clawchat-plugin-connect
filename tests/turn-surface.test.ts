import { expect, it } from "bun:test";
import { materializeRuntimeOutput, policyForOutputVisibility } from "../src/output-visibility";
import { ClawChatTurnSurface, ClientTurnSurface } from "../src/runtime/turn-surface";
import type { RuntimeActivity } from "../src/runtime/types";
import type { OutputVisibility } from "../src/types";

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

it("applies every output visibility level before the terminal no-reply veto", async () => {
  for (const mode of ["minimal", "normal", "full"] satisfies OutputVisibility[]) {
    const projected: string[] = [];
    const delivered: string[] = [];
    const policy = policyForOutputVisibility(mode);
    const surface = new ClawChatTurnSurface({
      noReplyProtocol: true,
      project: async (event) => {
        projected.push(event.text);
      },
      materialize: (event) => materializeRuntimeOutput(event, policy),
      deliver: async (_event, reply) => {
        delivered.push(reply.text);
      },
    });

    await surface.accept(activity("reasoning", "reasoning", "private reasoning", "reasoning"));
    await surface.accept(activity("assistant", "assistant", "candidate response", "assistant"));
    await surface.accept(activity("final", "assistant", "<clawchat:no-reply/>", "final"));
    await surface.complete();

    expect(projected).toEqual(["private reasoning", "candidate response", "<clawchat:no-reply/>"]);
    expect(delivered).toEqual([]);
  }
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

  await surface.accept(activity("final", "assistant", "clawchat:no-reply Here it is: ![chart](./chart.png)", "final"));
  await surface.complete();

  expect(delivered).toEqual(["Here it is: ![chart](./chart.png)"]);
});

it("suppresses intermediate media before a terminal group no-reply signal", async () => {
  const delivered: string[] = [];
  const surface = new ClawChatTurnSurface({
    noReplyProtocol: true,
    project: async () => undefined,
    materialize: (event) => ({ text: event.text, requiredControl: false }),
    deliver: async (_event, reply) => {
      delivered.push(reply.text);
    },
  });

  await surface.accept(activity("artifact", "assistant", "Generated: ![chart](./chart.png)", "assistant"));
  await surface.accept(activity("final", "assistant", "<clawchat:no-reply/>", "final"));
  await surface.complete();

  expect(delivered).toEqual([]);
});

it("recognizes no-reply only when the completed final response starts with a signal-shaped line", async () => {
  const delivered: string[] = [];
  const surface = new ClawChatTurnSurface({
    noReplyProtocol: true,
    project: async () => undefined,
    materialize: (event) => ({ text: event.text, requiredControl: false }),
    deliver: async (_event, reply) => {
      delivered.push(reply.text);
    },
  });

  await surface.accept(activity("final", "assistant", "<clawchat:no-reply/>", "assistant"));
  await surface.accept(
    activity("final", "assistant", "Use <clawchat:no-reply/> when a group answer is unnecessary.", "final"),
  );
  await surface.complete();

  expect(delivered).toEqual(["Use <clawchat:no-reply/> when a group answer is unnecessary."]);
});

it("suppresses documented terminal no-reply variants and any ordinary caption", async () => {
  for (const text of [
    "clawchat:no-reply",
    "  **<CLAWCHAT:NOREPLY/>**  ",
    "<clawchat-noreply/>",
    "<clawchat:no-reply/> This caption is still ordinary output.",
    "[ClawChat : no_reply]\nThis caption is still ordinary output.",
  ]) {
    const delivered: string[] = [];
    const surface = new ClawChatTurnSurface({
      noReplyProtocol: true,
      project: async () => undefined,
      materialize: (event) => ({ text: event.text, requiredControl: false }),
      deliver: async (_event, reply) => {
        delivered.push(reply.text);
      },
    });

    await surface.accept(activity("final", "assistant", text, "final"));
    await surface.complete();

    expect(delivered).toEqual([]);
  }
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
