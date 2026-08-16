import { describe, expect, it } from "bun:test";
import { createCodexRuntimeAdapter } from "../src/runtime/codex-adapter";
import { createOpenCodeRuntimeAdapter } from "../src/runtime/opencode-adapter";
import type { OpenCodeMessage, OpenCodeServerClient } from "../src/runtime/opencode-server";
import { runtimeInputIdentity } from "../src/runtime/types";
import {
  createWorkBuddyRuntimeAdapter,
  type WorkBuddyRuntimeAdapterBinding,
  type WorkBuddyRuntimeSource,
} from "../src/runtime/workbuddy-adapter";
import { runtimeAdapterConformance } from "./runtime-adapter-conformance";
import { pluginBinding } from "./runtime-adapter-fixture";

describe("Runtime input identity", () => {
  it("rejects a partially identified ClawChat context", () => {
    expect(
      runtimeInputIdentity(
        [
          "<clawchat_turn_context>",
          JSON.stringify({
            origin: "clawchat",
            message_id: "anchor",
            content_digest: "sha256:anchor",
            group_batch: { messages: [{ message_id: "missing-digest" }] },
          }),
          "</clawchat_turn_context>",
          "input",
        ].join("\n"),
      ),
    ).toBeNull();
  });

  it("rejects a Group Message Batch without exactly one matching anchor", () => {
    const context = (messages: Array<{ message_id: string; content_digest: string }>) =>
      [
        "<clawchat_turn_context>",
        JSON.stringify({
          origin: "clawchat",
          message_id: "anchor",
          content_digest: "digest-anchor",
          group_batch: { messages },
        }),
        "</clawchat_turn_context>",
        "input",
      ].join("\n");

    expect(runtimeInputIdentity(context([{ message_id: "other", content_digest: "digest-other" }]))).toBeNull();
    expect(
      runtimeInputIdentity(
        context([
          { message_id: "anchor", content_digest: "digest-anchor" },
          { message_id: "anchor", content_digest: "digest-anchor" },
        ]),
      ),
    ).toBeNull();
  });

  it("rejects conflicting digests for one ClawChat message identity", () => {
    expect(
      runtimeInputIdentity(
        [
          "<clawchat_turn_context>",
          JSON.stringify({
            origin: "clawchat",
            message_id: "anchor",
            content_digest: "digest-anchor",
            group_batch: {
              messages: [
                { message_id: "other", content_digest: "digest-actionable" },
                { message_id: "anchor", content_digest: "digest-anchor" },
              ],
            },
            recent_group_context: [{ message_id: "other", content_digest: "digest-context" }],
          }),
          "</clawchat_turn_context>",
          "input",
        ].join("\n"),
      ),
    ).toBeNull();
  });

  it("rejects duplicate and overlapping group roles even when their digests match", () => {
    const identity = (
      messages: Array<{ message_id: string; content_digest: string }>,
      context: Array<{ message_id: string; content_digest: string }>,
    ) =>
      runtimeInputIdentity(
        [
          "<clawchat_turn_context>",
          JSON.stringify({
            origin: "clawchat",
            message_id: "anchor",
            content_digest: "digest-anchor",
            group_batch: { messages },
            recent_group_context: context,
          }),
          "</clawchat_turn_context>",
          "input",
        ].join("\n"),
      );
    const anchor = { message_id: "anchor", content_digest: "digest-anchor" };
    const other = { message_id: "other", content_digest: "digest-other" };
    const context = { message_id: "context", content_digest: "digest-context" };

    expect(identity([other, other, anchor], [])).toBeNull();
    expect(identity([other, anchor], [context, context])).toBeNull();
    expect(identity([other, anchor], [other])).toBeNull();
  });
});

runtimeAdapterConformance("reference", () => {
  let closes = 0;
  let closed = false;
  let state: "active" | "archived" | "deleted" = "deleted";
  let failArchive = false;
  let pendingReject: ((error: Error) => void) | null = null;
  const lifecycleCalls: string[] = [];
  return {
    binding: pluginBinding(),
    activateThread: () => {
      state = "active";
    },
    closeCount: () => closes,
    failNextArchive: () => {
      failArchive = true;
    },
    lifecycleCalls: () => lifecycleCalls,
    startPendingOperation: async () =>
      await new Promise((_, reject) => {
        pendingReject = reject;
      }),
    adapter: {
      kind: "codex",
      modes: [],
      lifecycleCapabilities: { archive: true, restore: true, delete: true },
      discoverAllThreads: async () =>
        state === "active" ? [{ runtimeThreadId: "thread-1", name: null, updatedAt: 1 }] : [],
      discoverArchivedThreads: async () =>
        state === "archived" ? [{ runtimeThreadId: "thread-1", name: null, updatedAt: 1, isArchived: true }] : [],
      archiveThread: async () => {
        if (failArchive) {
          failArchive = false;
          throw new Error("native mutation is busy");
        }
        lifecycleCalls.push("archive");
        state = "archived";
      },
      unarchiveThread: async () => {
        lifecycleCalls.push("restore");
        state = "active";
      },
      deleteThread: async () => {
        lifecycleCalls.push("delete");
        state = "deleted";
      },
      readActivity: async () => ({
        completeness: "complete",
        limitations: [],
        activities: Array.from({ length: 201 }, (_, index) => ({
          id: `activity-${index}`,
          aliases: [`live-${index}`],
          position: `0.${index + 1}`,
          parentId: null,
          kind: "assistant" as const,
          text: "same output",
          state: "complete" as const,
          source: "history" as const,
        })),
      }),
      start: async () => ({ prompt: async function* () {}, close: async () => undefined }),
      close: async () => {
        if (closed) return;
        closed = true;
        closes += 1;
        pendingReject?.(new Error("binding closed"));
      },
    },
  };
});

runtimeAdapterConformance(
  "Codex",
  () => {
    let closes = 0;
    let state: "active" | "archived" | "deleted" = "deleted";
    let failArchive = false;
    let pendingReject: ((error: Error) => void) | null = null;
    const lifecycleCalls: string[] = [];
    const appServer = {
      listModels: async () =>
        pendingReject
          ? await new Promise((_, reject) => {
              pendingReject = reject;
            })
          : { data: [], nextCursor: null },
      listThreads: async (params: { archived?: boolean }) => ({
        data:
          (params.archived === true && state === "archived") || (params.archived !== true && state === "active")
            ? [
                {
                  id: "thread-1",
                  preview: "",
                  name: null,
                  createdAt: 1,
                  updatedAt: 1,
                  recencyAt: 1,
                  cwd: "/tmp",
                },
              ]
            : [],
        nextCursor: null,
      }),
      readThread: async () => ({
        thread: {
          id: "thread-1",
          preview: "",
          name: null,
          createdAt: 1,
          updatedAt: 1,
          recencyAt: 1,
          cwd: "/tmp",
          turns: [
            {
              id: "turn-1",
              status: "completed",
              items: Array.from({ length: 201 }, (_, index) => ({
                type: "agentMessage",
                id: `activity-${index}`,
                text: "same output",
              })),
            },
          ],
        },
      }),
      archiveThread: async () => {
        if (failArchive) {
          failArchive = false;
          throw new Error("native mutation is busy");
        }
        lifecycleCalls.push("archive");
        state = "archived";
      },
      unarchiveThread: async () => {
        lifecycleCalls.push("restore");
        state = "active";
        return { thread: { id: "thread-1" } };
      },
      deleteThread: async () => {
        lifecycleCalls.push("delete");
        state = "deleted";
      },
      startThread: async () => ({ thread: { id: "thread-1" } }),
      resumeThread: async () => ({ thread: { id: "thread-1" } }),
      startTurn: async () => ({ turn: { id: "turn-1", status: "completed", error: null } }),
      interruptTurn: async () => undefined,
      onNotification: () => () => undefined,
      onRequest: () => () => undefined,
      close: async () => {
        closes += 1;
        pendingReject?.(new Error("binding closed"));
      },
    };
    return {
      binding: { ...pluginBinding(), env: { CODEX_HOME: "/tmp/connect-runtime-adapter-conformance" } },
      activateThread: () => {
        state = "active";
      },
      closeCount: () => closes,
      failNextArchive: () => {
        failArchive = true;
      },
      lifecycleCalls: () => lifecycleCalls,
      startPendingOperation: async () => {
        pendingReject = () => undefined;
        return await appServer.listModels();
      },
      adapter: createCodexRuntimeAdapter({
        createAppServer: async () =>
          appServer as unknown as import("../src/runtime/codex-app-server").CodexAppServerClient,
      }),
    };
  },
  true,
);

runtimeAdapterConformance(
  "OpenCode",
  () => {
    let closes = 0;
    let state: "active" | "deleted" = "active";
    let pendingReject: ((error: Error) => void) | null = null;
    const lifecycleCalls: string[] = [];
    const messages: OpenCodeMessage[] = [
      {
        info: {
          id: "message-1",
          sessionID: "thread-1",
          role: "user",
          time: { created: 1 },
          agent: "build",
          model: { providerID: "test", modelID: "model" },
        },
        parts: Array.from({ length: 201 }, (_, index) => ({
          id: `activity-${index}`,
          sessionID: "thread-1",
          messageID: "message-1",
          type: "text" as const,
          text: "same output",
        })),
      },
    ];
    const session = {
      id: "thread-1",
      slug: "thread-1",
      projectID: "project-1",
      directory: "/repo",
      title: "Conformance",
      version: "1.18.10",
      time: { created: 1, updated: 1 },
    };
    const client: OpenCodeServerClient = {
      version: "1.18.10",
      health: async () => ({ healthy: true, version: "1.18.10" }),
      listProjects: async () => [],
      listAgents: async () =>
        pendingReject
          ? await new Promise((_, reject) => {
              pendingReject = reject;
            })
          : [],
      listCommands: async () => [],
      listProviders: async () => ({ all: [], connected: [], default: {} }),
      listSessions: async () => (state === "active" ? [session] : []),
      getSession: async () => {
        if (state !== "active") throw new Error("not found");
        return session;
      },
      createSession: async () => session,
      deleteSession: async () => {
        if (state === "deleted") return false;
        lifecycleCalls.push("delete");
        state = "deleted";
        return true;
      },
      sessionStatus: async () => ({}),
      messages: async () => messages,
      promptAsync: async () => undefined,
      runCommand: async () => undefined,
      abortSession: async () => true,
      events: (signal, onConnected) => {
        onConnected?.();
        return {
          async *[Symbol.asyncIterator]() {
            await new Promise<void>((resolve) => {
              if (signal.aborted) resolve();
              else signal.addEventListener("abort", () => resolve(), { once: true });
            });
          },
        };
      },
      replyPermission: async () => true,
      replyQuestion: async () => true,
      rejectQuestion: async () => true,
      close: async () => {
        closes += 1;
        pendingReject?.(new Error("binding closed"));
      },
    };
    return {
      binding: pluginBinding(),
      activateThread: () => {
        state = "active";
      },
      closeCount: () => closes,
      failNextArchive: () => undefined,
      lifecycleCalls: () => lifecycleCalls,
      startPendingOperation: async () => {
        pendingReject = () => undefined;
        return await client.listAgents("/repo");
      },
      adapter: createOpenCodeRuntimeAdapter({ createServer: async () => client }),
    };
  },
  true,
);

runtimeAdapterConformance(
  "WorkBuddy",
  () => {
    let closes = 0;
    let closed = false;
    let active = false;
    let pending = false;
    let pendingReject: ((error: Error) => void) | null = null;
    const activities = Array.from({ length: 201 }, (_, index) => ({
      id: `activity-${index}`,
      aliases: [`live-${index}`],
      position: `0.${index + 1}`,
      parentId: null,
      kind: "assistant" as const,
      text: "same output",
      state: "complete" as const,
      source: "history" as const,
    }));
    const source: WorkBuddyRuntimeSource = {
      listTasks: async () => (active ? [{ id: "thread-1", title: "Task", workspace: "/tmp", updatedAt: 1 }] : []),
      findTask: async () => ({ id: "thread-1", title: "Task", workspace: "/tmp", updatedAt: 1 }),
      attachTask: async () =>
        pending
          ? await new Promise((_, reject) => {
              pendingReject = reject;
            })
          : { activities, completeness: "complete", limitations: [] },
      close: async () => {
        if (closed) return;
        closed = true;
        closes += 1;
        pendingReject?.(new Error("binding closed"));
      },
    };
    return {
      binding: { ...pluginBinding(), profile: "workbuddy-ai" } as WorkBuddyRuntimeAdapterBinding,
      activateThread: () => {
        active = true;
      },
      closeCount: () => closes,
      failNextArchive: () => undefined,
      lifecycleCalls: () => [],
      startPendingOperation: async () => {
        active = true;
        pending = true;
        return await source.attachTask({ profile: "workbuddy-ai", taskId: "thread-1", workspace: "/tmp" });
      },
      adapter: createWorkBuddyRuntimeAdapter({ createSource: () => source }),
    };
  },
  true,
);
