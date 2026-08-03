import { afterEach, describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import { createServer, type Server, type Socket } from "node:net";
import type { RuntimeActivity } from "../src/runtime/types";
import {
  openWorkBuddyAiTaskEndpoint,
  verifyWorkBuddyAiEndpoint,
  verifyWorkBuddyEndpoint,
  type WorkBuddyConnectedSocketIdentity,
} from "../src/runtime/workbuddy-acp-client";
import type { WorkBuddyProfile } from "../src/runtime/workbuddy-task-discovery";

const taskId = "00000000-0000-4000-8000-000000000001";
const workspace = "/private/tmp/workbuddy-acp-client";
const applicationPath = "/Applications/WorkBuddy AI.app";
const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map(closeServer));
});

describe("WorkBuddy private ACP client", () => {
  it("uses one established socket for content-length bootstrap and fragmented chunked SSE replay", async () => {
    const serverSockets = new Set<Socket>();
    let loadReceived = false;
    const rpcMethods: string[] = [];
    const endpoint = await serve((request, socket) => {
      serverSockets.add(socket);
      if (request.path.endsWith("/connect")) {
        return jsonResponse({ connectionId: "connection-secret", sessionToken: "session-secret" }, true);
      }
      if (request.method === "DELETE") return emptyResponse();
      const rpc = JSON.parse(request.body) as { id: number; method: string };
      rpcMethods.push(rpc.method);
      if (rpc.method === "initialize") {
        return sseResponse([{ jsonrpc: "2.0", id: rpc.id, result: { protocolVersion: 1 } }], true);
      }
      loadReceived = true;
      return sseResponse(
        [
          update({ sessionUpdate: "session_info_update", _meta: { "codebuddy.ai/historyReplay": "start" } }),
          update({
            sessionUpdate: "user_message_chunk",
            messageId: "message-1",
            content: { type: "text", text: "remember " },
          }),
          update({
            sessionUpdate: "user_message_chunk",
            messageId: "message-1",
            content: { type: "text", text: "this" },
          }),
          update({
            sessionUpdate: "tool_call",
            toolCallId: "tool-1",
            title: "Inspect workspace",
            status: "completed",
          }),
          update({
            sessionUpdate: "codebuddy_vendor_event",
            updateId: "vendor-1",
            privatePayload: "must not cross the Runtime Adapter seam",
          }),
          update({
            sessionUpdate: "agent_thought_chunk",
            messageId: "message-2",
            content: { type: "text", text: "considering" },
          }),
          update({
            sessionUpdate: "agent_message_chunk",
            messageId: "message-2",
            content: { type: "text", text: "remembered" },
          }),
          update({ sessionUpdate: "session_info_update", _meta: { "codebuddy.ai/historyReplay": "end" } }),
          { jsonrpc: "2.0", id: rpc.id, result: { models: [] } },
        ],
        true,
      );
    });

    let observedSocket: WorkBuddyConnectedSocketIdentity | undefined;
    const verification = await verifyWorkBuddyAiEndpoint(
      { endpoint, taskId, workspace, acpVersion: 1 },
      1_000,
      async (identity) => {
        expect(loadReceived).toBeFalse();
        observedSocket = identity;
        return {
          pid: 120,
          parentPid: 110,
          executablePath: `${applicationPath}/Contents/MacOS/Electron`,
        };
      },
    );

    expect(observedSocket?.remotePort).toBe(Number(new URL(endpoint).port));
    expect(serverSockets.size).toBe(1);
    expect(rpcMethods).toEqual(["initialize", "session/load"]);
    expect(verification).toEqual({
      taskId,
      replayFingerprint: fingerprint(["message-1", "message-2"]),
      replayStarted: true,
      replayCompleted: true,
      activities: [
        {
          id: "workbuddy:user:message-1",
          position: "0.1",
          parentId: null,
          kind: "user",
          text: "remember this",
          state: "complete",
          source: "history",
        },
        {
          id: "workbuddy:tool:tool-1",
          position: "0.2",
          parentId: null,
          kind: "tool",
          text: "Inspect workspace",
          state: "complete",
          source: "history",
        },
        {
          id: "workbuddy:unknown:vendor-1:codebuddy_vendor_event",
          position: "0.3",
          parentId: null,
          kind: "unknown",
          text: "WorkBuddy codebuddy_vendor_event",
          state: "complete",
          source: "history",
        },
        {
          id: "workbuddy:reasoning:message-2",
          position: "0.4",
          parentId: null,
          kind: "reasoning",
          text: "considering",
          state: "complete",
          source: "history",
        },
        {
          id: "workbuddy:assistant:message-2",
          position: "0.5",
          parentId: null,
          kind: "assistant",
          text: "remembered",
          state: "complete",
          source: "history",
        },
      ],
      connectionOwner: {
        pid: 120,
        parentPid: 110,
        executablePath: `${applicationPath}/Contents/MacOS/Electron`,
      },
    });
    expect(new Set(verification.activities.map((activity) => activity.id)).size).toBe(verification.activities.length);
  });

  it("redacts connection credentials when the server rejects JSON-RPC", async () => {
    const endpoint = await serve((request) => {
      if (request.path.endsWith("/connect")) {
        return jsonResponse({ connectionId: "connection-secret", sessionToken: "session-secret" });
      }
      if (request.method === "DELETE") return emptyResponse();
      return sseResponse([
        {
          jsonrpc: "2.0",
          id: 1,
          error: { message: "connection-secret session-secret must not escape" },
        },
      ]);
    });

    const result = verifyWorkBuddyAiEndpoint({ endpoint, taskId, workspace, acpVersion: 1 }, 1_000, async () => ({
      pid: 120,
      parentPid: 110,
      executablePath: `${applicationPath}/Contents/MacOS/Electron`,
    }));
    await expect(result).rejects.toThrow("ACP JSON-RPC request failed");
    await expect(result).rejects.not.toThrow(/connection-secret|session-secret/u);
  });

  it.each(["workbuddy-ai", "workbuddy-cn"] as WorkBuddyProfile[])(
    "reports an incompatible ACP protocol with %s profile details",
    async (profile) => {
      const endpoint = await serve((request) => {
        if (request.path.endsWith("/connect")) return jsonResponse({ connectionId: "version-connection" });
        if (request.method === "DELETE") return emptyResponse();
        const rpc = JSON.parse(request.body) as { id: number };
        return sseResponse([{ jsonrpc: "2.0", id: rpc.id, result: { protocolVersion: 2 } }]);
      });

      await expect(
        verifyWorkBuddyEndpoint({ profile, endpoint, taskId, workspace, acpVersion: 1 }, 1_000, async () => null),
      ).rejects.toMatchObject({
        code: "incompatible-version",
        details: { selectedProfile: profile, detectedAcpVersion: 2, supportedAcpVersion: 1 },
      });
    },
  );

  it("reports authentication expiry distinctly from transport loss", async () => {
    const endpoint = await serve(() => jsonResponse({ error: "expired credential" }, false, 401));
    await expect(
      openWorkBuddyAiTaskEndpoint({ endpoint, taskId, workspace, acpVersion: 1 }, 1_000, async () => null),
    ).rejects.toMatchObject({ code: "authentication-failed" });
  });

  it("rejects unbounded HTTP response framing", async () => {
    const endpoint = await serve(() => ({ raw: "HTTP/1.1 200 OK\r\nConnection: keep-alive\r\n\r\n{}" }));
    await expect(
      verifyWorkBuddyAiEndpoint({ endpoint, taskId, workspace, acpVersion: 1 }, 1_000, async () => null),
    ).rejects.toThrow("omitted a bounded body framing header");
  });

  it("bounds a server that never completes a response", async () => {
    const endpoint = await serve(() => null);
    await expect(
      verifyWorkBuddyAiEndpoint({ endpoint, taskId, workspace, acpVersion: 1 }, 30, async () => null),
    ).rejects.toThrow("ACP HTTP response timed out");
  });

  it("treats active SSE heartbeats as progress while retaining an idle timeout", async () => {
    const endpoint = await serve((request, socket) => {
      if (request.path.endsWith("/connect")) return jsonResponse({ connectionId: "heartbeat-connection" });
      if (request.method === "DELETE") return emptyResponse();
      const rpc = JSON.parse(request.body) as { id: number; method: string };
      if (rpc.method === "initialize") {
        return sseResponse([{ jsonrpc: "2.0", id: rpc.id, result: { protocolVersion: 1 } }]);
      }
      writeHeartbeatSse(socket, rpc.id);
      return null;
    });

    await expect(
      verifyWorkBuddyAiEndpoint({ endpoint, taskId, workspace, acpVersion: 1 }, 25, async () => ({
        pid: 120,
        parentPid: 110,
        executablePath: `${applicationPath}/Contents/MacOS/Electron`,
      })),
    ).resolves.toMatchObject({ taskId, replayStarted: true, replayCompleted: true });
  });

  it("streams one synchronized text turn through the verified Task connection without overriding its model", async () => {
    const serverSockets = new Set<Socket>();
    const promptParams: Record<string, unknown>[] = [];
    let deleteRequests = 0;
    const endpoint = await serve((request, socket) => {
      serverSockets.add(socket);
      if (request.path.endsWith("/connect")) {
        return jsonResponse({ connectionId: "turn-connection", sessionToken: "turn-token" });
      }
      if (request.method === "DELETE") {
        deleteRequests += 1;
        return emptyResponse();
      }
      const rpc = JSON.parse(request.body) as { id: number; method: string; params: Record<string, unknown> };
      if (rpc.method === "initialize") {
        return sseResponse([{ jsonrpc: "2.0", id: rpc.id, result: { protocolVersion: 1 } }]);
      }
      if (rpc.method === "session/load") {
        return sseResponse([
          update({ sessionUpdate: "session_info_update", _meta: { "codebuddy.ai/historyReplay": "start" } }),
          update({
            sessionUpdate: "user_message_chunk",
            messageId: "prior-user",
            content: { type: "text", text: "The private answer is cobalt." },
          }),
          update({ sessionUpdate: "session_info_update", _meta: { "codebuddy.ai/historyReplay": "end" } }),
          {
            jsonrpc: "2.0",
            id: rpc.id,
            result: { models: { currentModelId: "workbuddy-current-model", availableModels: [] } },
          },
        ]);
      }
      promptParams.push(rpc.params);
      const agentMessageId = `turn-agent-${promptParams.length}`;
      writeStreamingSse(socket, [
        update({
          sessionUpdate: "agent_thought_chunk",
          messageId: agentMessageId,
          content: { type: "text", text: "Using prior context" },
        }),
        update({
          sessionUpdate: "session_info_update",
          _meta: {
            "codebuddy.ai/requestId": "native-request",
            "codebuddy.ai/agentPhase": { phase: "tool_executing", toolName: "read", startedAt: 1 },
          },
        }),
        update({ sessionUpdate: "tool_call", toolCallId: "tool-1", title: "Read native history", status: "running" }),
        update({
          sessionUpdate: "agent_message_chunk",
          messageId: agentMessageId,
          content: { type: "text", text: "The answer is " },
        }),
        update({
          sessionUpdate: "agent_message_chunk",
          messageId: agentMessageId,
          content: { type: "text", text: "cobalt." },
        }),
        update({ sessionUpdate: "tool_call_update", toolCallId: "tool-1", status: "completed" }),
        update({ sessionUpdate: "session_end", stopReason: "end_turn" }),
        { jsonrpc: "2.0", id: rpc.id, result: { stopReason: "end_turn" } },
      ]);
      return null;
    });

    const attachment = await openWorkBuddyAiTaskEndpoint(
      { endpoint, taskId, workspace, acpVersion: 1 },
      1_000,
      async () => ({
        pid: 120,
        parentPid: 110,
        executablePath: `${applicationPath}/Contents/MacOS/Electron`,
      }),
    );
    expect(attachment.verification.replayFingerprint).toBe(fingerprint(["prior-user"]));

    let accepted = 0;
    const activities: RuntimeActivity[] = [];
    for await (const activity of attachment.prompt({
      prompt: "What was the private answer?",
      turnId: "connect-turn",
      turnOrigin: "client",
      onAccepted: async () => {
        accepted += 1;
      },
      workspace: {
        projectId: null,
        workingDirectory: workspace,
        additionalDirectories: [],
        skipGitRepoCheck: false,
      },
    })) {
      activities.push(activity);
    }

    expect(promptParams[0]).toEqual({
      sessionId: taskId,
      prompt: [{ type: "text", text: "What was the private answer?" }],
      _meta: {
        messageId: "clawchat-connect-client-connect-turn",
        "codebuddy.ai": {
          userMessageId: "clawchat-connect-client-connect-turn",
          messageRequestId: "clawchat-connect-client-connect-turn",
        },
      },
    });
    expect(promptParams).not.toHaveProperty("model");
    expect(accepted).toBe(1);
    expect(serverSockets.size).toBe(1);
    expect(activities.some((activity) => activity.kind === "user" && activity.state === "complete")).toBeTrue();
    expect(activities.some((activity) => activity.kind === "reasoning")).toBeTrue();
    expect(activities.some((activity) => activity.kind === "progress")).toBeTrue();
    expect(activities.some((activity) => activity.kind === "tool")).toBeTrue();
    const finalAssistant = activities.filter(
      (activity) => activity.id === "workbuddy:assistant:turn-agent-1" && activity.state === "complete",
    );
    expect(finalAssistant).toHaveLength(1);
    expect(finalAssistant[0]?.text).toBe("The answer is cobalt.");
    expect(finalAssistant[0]?.position).toBe("1.5");

    const secondActivities: RuntimeActivity[] = [];
    for await (const activity of attachment.prompt({
      prompt: "Repeat the private answer.",
      turnId: "connect-turn-2",
      turnOrigin: "clawchat",
      workspace: {
        projectId: null,
        workingDirectory: workspace,
        additionalDirectories: [],
        skipGitRepoCheck: false,
      },
    })) {
      secondActivities.push(activity);
    }
    expect(secondActivities.find((activity) => activity.kind === "user")?.position).toBe("2.1");
    expect(
      secondActivities.find(
        (activity) => activity.id === "workbuddy:assistant:turn-agent-2" && activity.state === "complete",
      )?.position,
    ).toBe("2.5");

    await attachment.close();
    await attachment.close();
    expect(deleteRequests).toBe(1);
  });

  it("routes a native approval through the Turn Surface and confirms the response back to WorkBuddy", async () => {
    let promptSocket: Socket | undefined;
    let promptRequestId: number | undefined;
    let resolveParams: Record<string, unknown> | undefined;
    let observeInteraction: (value: unknown) => void = () => undefined;
    const interactionObserved = new Promise<unknown>((resolve) => {
      observeInteraction = resolve;
    });
    const endpoint = await serve((request, socket) => {
      if (request.path.endsWith("/connect")) return jsonResponse({ connectionId: "interaction-connection" });
      if (request.method === "DELETE") return emptyResponse();
      const rpc = JSON.parse(request.body) as { id?: number; method: string; params: Record<string, unknown> };
      if (rpc.method === "initialize") {
        return sseResponse([{ jsonrpc: "2.0", id: rpc.id, result: { protocolVersion: 1 } }]);
      }
      if (rpc.method === "session/load") {
        return sseResponse([
          update({ sessionUpdate: "session_info_update", _meta: { "codebuddy.ai/historyReplay": "start" } }),
          update({ sessionUpdate: "session_info_update", _meta: { "codebuddy.ai/historyReplay": "end" } }),
          { jsonrpc: "2.0", id: rpc.id, result: {} },
        ]);
      }
      if (rpc.method === "_codebuddy.ai/resolveInterruption") {
        resolveParams = rpc.params;
        setTimeout(() => {
          if (!promptSocket) return;
          writeSseChunk(
            promptSocket,
            update({
              sessionUpdate: "session_info_update",
              _meta: {
                "codebuddy.ai/permissionResolved": true,
                "codebuddy.ai/toolCallId": "tool-approval",
                "codebuddy.ai/decision": "allowAll",
              },
            }),
          );
          writeSseChunk(
            promptSocket,
            { jsonrpc: "2.0", id: promptRequestId, result: { stopReason: "end_turn" } },
            true,
          );
        });
        return sseResponse([{ jsonrpc: "2.0", id: rpc.id, result: {} }]);
      }
      promptRequestId = rpc.id;
      promptSocket = socket;
      startStreamingSse(socket);
      writeSseChunk(
        socket,
        update({
          sessionUpdate: "session_info_update",
          _meta: {
            "codebuddy.ai/interruptionRequest": {
              interruptionId: "ir-tool-approval",
              toolCallId: "tool-approval",
              toolName: "Bash",
              toolTitle: "Run tests",
              toolInput: { command: "bun test", cwd: workspace },
              options: ["allow", "allowAll", "deny"],
            },
          },
        }),
      );
      return null;
    });
    const attachment = await openWorkBuddyAiTaskEndpoint(
      { endpoint, taskId, workspace, acpVersion: 1 },
      1_000,
      async () => ({ pid: 120, parentPid: 110, executablePath: `${applicationPath}/Contents/MacOS/Electron` }),
    );
    let deliveryConfirmed = false;
    const result = collect(
      attachment.prompt({
        prompt: "Run the tests",
        turnId: "approval-turn",
        turnOrigin: "client",
        metadata: { sessionRef: "approval-session" },
        interactionPort: {
          request: async (request, context) => {
            observeInteraction(request);
            void context.deliveryConfirmation.then(() => {
              deliveryConfirmed = true;
            });
            expect(deliveryConfirmed).toBeFalse();
            return { kind: "approval", optionId: "approve-session" };
          },
        },
        workspace: {
          projectId: null,
          workingDirectory: workspace,
          additionalDirectories: [],
          skipGitRepoCheck: false,
        },
      }),
    );

    await expect(
      Promise.race([interactionObserved, rejectAfter(100, "native approval was not routed")]),
    ).resolves.toEqual({
      kind: "approval",
      action: "command",
      title: "Run tests",
      description: "WorkBuddy requests permission to run Bash.",
      command: "bun test",
      cwd: workspace,
      options: [
        { id: "approve-once", label: "Allow" },
        { id: "approve-session", label: "Always allow" },
        { id: "deny", label: "Deny" },
      ],
    });
    await expect(result).resolves.toBeArray();
    expect(resolveParams).toEqual({
      sessionId: taskId,
      toolCallId: "tool-approval",
      decision: "allowAll",
    });
    expect(deliveryConfirmed).toBeTrue();
    await attachment.close();
  });

  it.each(["workbuddy-ai", "workbuddy-cn"] as WorkBuddyProfile[])(
    "preserves native question details and Turn Surface scope for %s",
    async (profile) => {
      let promptSocket: Socket | undefined;
      let promptRequestId: number | undefined;
      let resolveParams: Record<string, unknown> | undefined;
      const endpoint = await serve((request, socket) => {
        if (request.path.endsWith("/connect")) return jsonResponse({ connectionId: "question-connection" });
        if (request.method === "DELETE") return emptyResponse();
        const rpc = JSON.parse(request.body) as { id?: number; method: string; params: Record<string, unknown> };
        if (rpc.method === "initialize") {
          return sseResponse([{ jsonrpc: "2.0", id: rpc.id, result: { protocolVersion: 1 } }]);
        }
        if (rpc.method === "session/load") {
          return sseResponse([
            update({ sessionUpdate: "session_info_update", _meta: { "codebuddy.ai/historyReplay": "start" } }),
            update({ sessionUpdate: "session_info_update", _meta: { "codebuddy.ai/historyReplay": "end" } }),
            { jsonrpc: "2.0", id: rpc.id, result: {} },
          ]);
        }
        if (rpc.method === "_codebuddy.ai/resolveInterruption") {
          resolveParams = rpc.params;
          setTimeout(() => {
            if (!promptSocket) return;
            writeSseChunk(
              promptSocket,
              update({
                sessionUpdate: "session_info_update",
                _meta: {
                  "codebuddy.ai/permissionResolved": true,
                  "codebuddy.ai/toolCallId": "tool-question",
                },
              }),
            );
            writeSseChunk(
              promptSocket,
              { jsonrpc: "2.0", id: promptRequestId, result: { stopReason: "end_turn" } },
              true,
            );
          });
          return sseResponse([{ jsonrpc: "2.0", id: rpc.id, result: {} }]);
        }
        promptSocket = socket;
        promptRequestId = rpc.id;
        startStreamingSse(socket);
        writeSseChunk(
          socket,
          update({
            sessionUpdate: "session_info_update",
            _meta: {
              "codebuddy.ai/interruptionRequest": {
                toolCallId: "tool-question",
                toolName: "AskUserQuestion",
                toolTitle: "Choose deployment settings",
                toolInput: {
                  questions: [
                    {
                      id: "environment",
                      header: "Environment",
                      question: "Where should this deploy?",
                      options: [
                        { id: "staging", label: "Staging", description: "Internal validation" },
                        { id: "production", label: "Production" },
                      ],
                      allowOther: false,
                    },
                    {
                      id: "token",
                      header: "Secret",
                      question: "Enter the deployment token",
                      isSecret: true,
                    },
                  ],
                },
              },
            },
          }),
        );
        return null;
      });
      const attachment = await openWorkBuddyAiTaskEndpoint(
        { profile, endpoint, taskId, workspace, acpVersion: 1 },
        1_000,
        async () => ({ pid: 120, parentPid: 110, executablePath: `${applicationPath}/Contents/MacOS/Electron` }),
      );
      let observedRequest: unknown;
      let observedContext: unknown;
      const result = collect(
        attachment.prompt({
          prompt: "Deploy",
          turnId: "question-turn",
          turnOrigin: "clawchat",
          metadata: { sessionRef: "session-ref" },
          interactionPort: {
            request: async (request, context) => {
              observedRequest = request;
              observedContext = { sessionRef: context.sessionRef, turnId: context.turnId, origin: context.origin };
              return {
                kind: "user-input",
                answers: { environment: ["staging"], token: ["top-secret"] },
              };
            },
          },
          workspace: {
            projectId: null,
            workingDirectory: workspace,
            additionalDirectories: [],
            skipGitRepoCheck: false,
          },
        }),
      );

      await expect(result).resolves.toBeArray();
      expect(observedContext).toEqual({ sessionRef: "session-ref", turnId: "question-turn", origin: "clawchat" });
      expect(observedRequest).toEqual({
        kind: "user-input",
        title: "Choose deployment settings",
        description: "WorkBuddy has 2 questions.",
        questions: [
          {
            id: "environment",
            header: "Environment",
            prompt: "Where should this deploy?",
            secret: false,
            allowOther: false,
            options: [
              { id: "staging", label: "Staging", description: "Internal validation" },
              { id: "production", label: "Production" },
            ],
          },
          {
            id: "token",
            header: "Secret",
            prompt: "Enter the deployment token",
            secret: true,
            allowOther: true,
            options: null,
          },
        ],
        autoResolutionMs: null,
      });
      expect(resolveParams).toEqual({
        sessionId: taskId,
        toolCallId: "tool-question",
        decision: "allow",
        answers: { environment: ["staging"], token: ["top-secret"] },
      });
      await attachment.close();
    },
  );

  it("lets a WorkBuddy UI response expire the Connect interaction and rejects its late answer", async () => {
    let promptSocket: Socket | undefined;
    let promptRequestId: number | undefined;
    let resolveCalls = 0;
    let releaseResponse!: () => void;
    let interactionSignal: AbortSignal | undefined;
    let interactionStarted!: () => void;
    let interactionAborted!: () => void;
    const started = new Promise<void>((resolve) => {
      interactionStarted = resolve;
    });
    const aborted = new Promise<void>((resolve) => {
      interactionAborted = resolve;
    });
    const responseGate = new Promise<void>((resolve) => {
      releaseResponse = resolve;
    });
    const endpoint = await serve((request, socket) => {
      if (request.path.endsWith("/connect")) return jsonResponse({ connectionId: "ui-resolution-connection" });
      if (request.method === "DELETE") return emptyResponse();
      const rpc = JSON.parse(request.body) as { id?: number; method: string };
      if (rpc.method === "initialize") {
        return sseResponse([{ jsonrpc: "2.0", id: rpc.id, result: { protocolVersion: 1 } }]);
      }
      if (rpc.method === "session/load") {
        return sseResponse([
          update({ sessionUpdate: "session_info_update", _meta: { "codebuddy.ai/historyReplay": "start" } }),
          update({ sessionUpdate: "session_info_update", _meta: { "codebuddy.ai/historyReplay": "end" } }),
          { jsonrpc: "2.0", id: rpc.id, result: {} },
        ]);
      }
      if (rpc.method === "_codebuddy.ai/resolveInterruption") {
        resolveCalls += 1;
        return sseResponse([{ jsonrpc: "2.0", id: rpc.id, result: {} }]);
      }
      promptSocket = socket;
      promptRequestId = rpc.id;
      startStreamingSse(socket);
      writeSseChunk(
        socket,
        update({
          sessionUpdate: "session_info_update",
          _meta: {
            "codebuddy.ai/interruptionRequest": {
              toolCallId: "ui-wins",
              toolName: "Bash",
              toolInput: { command: "bun test" },
              options: ["allow", "deny"],
            },
          },
        }),
      );
      return null;
    });
    const attachment = await openWorkBuddyAiTaskEndpoint(
      { endpoint, taskId, workspace, acpVersion: 1 },
      1_000,
      async () => ({ pid: 120, parentPid: 110, executablePath: `${applicationPath}/Contents/MacOS/Electron` }),
    );
    const result = collect(
      attachment.prompt({
        prompt: "Wait for approval",
        turnId: "ui-wins-turn",
        turnOrigin: "client",
        metadata: { sessionRef: "ui-wins-session" },
        interactionPort: {
          request: async (_request, context) => {
            interactionSignal = context.signal;
            context.signal?.addEventListener("abort", interactionAborted, { once: true });
            void context.deliveryConfirmation.catch(() => undefined);
            interactionStarted();
            await responseGate;
            return { kind: "approval", optionId: "approve-once" };
          },
        },
        workspace: {
          projectId: null,
          workingDirectory: workspace,
          additionalDirectories: [],
          skipGitRepoCheck: false,
        },
      }),
    );
    await started;
    const activePromptSocket = requireSocket(promptSocket, "UI-resolution prompt");
    writeSseChunk(
      activePromptSocket,
      update({
        sessionUpdate: "session_info_update",
        _meta: {
          "codebuddy.ai/permissionResolved": true,
          "codebuddy.ai/toolCallId": "ui-wins",
          "codebuddy.ai/decision": "deny",
        },
      }),
    );
    await expect(
      Promise.race([aborted.then(() => undefined), rejectAfter(100, "UI resolution did not expire the interaction")]),
    ).resolves.toBeUndefined();
    expect(interactionSignal?.aborted).toBeTrue();
    releaseResponse();
    writeSseChunk(
      activePromptSocket,
      { jsonrpc: "2.0", id: promptRequestId, result: { stopReason: "end_turn" } },
      true,
    );

    await expect(result).resolves.toBeArray();
    expect(resolveCalls).toBe(0);
    await attachment.close();
  });

  it("cancels the native prompt and pending interaction exactly once", async () => {
    let promptSocket: Socket | undefined;
    let promptRequestId: number | undefined;
    let cancelCalls = 0;
    let interactionSignal: AbortSignal | undefined;
    let interactionStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      interactionStarted = resolve;
    });
    const endpoint = await serve((request, socket) => {
      if (request.path.endsWith("/connect")) return jsonResponse({ connectionId: "cancel-connection" });
      if (request.method === "DELETE") return emptyResponse();
      const rpc = JSON.parse(request.body) as { id?: number; method: string };
      if (rpc.method === "initialize") {
        return sseResponse([{ jsonrpc: "2.0", id: rpc.id, result: { protocolVersion: 1 } }]);
      }
      if (rpc.method === "session/load") {
        return sseResponse([
          update({ sessionUpdate: "session_info_update", _meta: { "codebuddy.ai/historyReplay": "start" } }),
          update({ sessionUpdate: "session_info_update", _meta: { "codebuddy.ai/historyReplay": "end" } }),
          { jsonrpc: "2.0", id: rpc.id, result: {} },
        ]);
      }
      if (rpc.method === "session/cancel") {
        cancelCalls += 1;
        setTimeout(() => {
          if (!promptSocket) return;
          writeSseChunk(promptSocket, update({ sessionUpdate: "session_end", stopReason: "cancelled" }));
          writeSseChunk(
            promptSocket,
            { jsonrpc: "2.0", id: promptRequestId, result: { stopReason: "cancelled" } },
            true,
          );
        });
        return emptyResponse();
      }
      promptSocket = socket;
      promptRequestId = rpc.id;
      startStreamingSse(socket);
      writeSseChunk(
        socket,
        update({
          sessionUpdate: "agent_message_chunk",
          messageId: "cancelled-assistant",
          content: { type: "text", text: "working" },
        }),
      );
      writeSseChunk(
        socket,
        update({
          sessionUpdate: "session_info_update",
          _meta: {
            "codebuddy.ai/interruptionRequest": {
              toolCallId: "cancelled-interaction",
              toolName: "Bash",
              toolInput: { command: "sleep 10" },
              options: ["allow", "deny"],
            },
          },
        }),
      );
      return null;
    });
    const attachment = await openWorkBuddyAiTaskEndpoint(
      { endpoint, taskId, workspace, acpVersion: 1 },
      1_000,
      async () => ({ pid: 120, parentPid: 110, executablePath: `${applicationPath}/Contents/MacOS/Electron` }),
    );
    const result = collect(
      attachment.prompt({
        prompt: "Long task",
        turnId: "cancel-turn",
        turnOrigin: "client",
        metadata: { sessionRef: "cancel-session" },
        interactionPort: {
          request: async (_request, context) => {
            interactionSignal = context.signal;
            void context.deliveryConfirmation.catch(() => undefined);
            interactionStarted();
            await new Promise<void>((_resolve, reject) => {
              context.signal?.addEventListener("abort", () => reject(context.signal?.reason), { once: true });
            });
            return { kind: "approval", optionId: "approve-once" };
          },
        },
        workspace: {
          projectId: null,
          workingDirectory: workspace,
          additionalDirectories: [],
          skipGitRepoCheck: false,
        },
      }),
    );
    await started;

    await expect(attachment.cancel?.()).resolves.toBeTrue();
    await expect(attachment.cancel?.()).resolves.toBeFalse();
    expect(interactionSignal?.aborted).toBeTrue();
    const activities = await result;
    expect(cancelCalls).toBe(1);
    expect(activities.some((activity) => activity.state === "cancelled")).toBeTrue();
    await expect(attachment.cancel?.()).resolves.toBeFalse();
    await attachment.close();
  });

  it("cancels before native acceptance without accepting or retrying the prompt", async () => {
    let promptSocket: Socket | undefined;
    let promptRequestId: number | undefined;
    let promptStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      promptStarted = resolve;
    });
    let cancelCalls = 0;
    const endpoint = await serve((request, socket) => {
      if (request.path.endsWith("/connect")) return jsonResponse({ connectionId: "pre-accept-cancel" });
      if (request.method === "DELETE") return emptyResponse();
      const rpc = JSON.parse(request.body) as { id?: number; method: string };
      if (rpc.method === "initialize") {
        return sseResponse([{ jsonrpc: "2.0", id: rpc.id, result: { protocolVersion: 1 } }]);
      }
      if (rpc.method === "session/load") {
        return sseResponse([
          update({ sessionUpdate: "session_info_update", _meta: { "codebuddy.ai/historyReplay": "start" } }),
          update({ sessionUpdate: "session_info_update", _meta: { "codebuddy.ai/historyReplay": "end" } }),
          { jsonrpc: "2.0", id: rpc.id, result: {} },
        ]);
      }
      if (rpc.method === "session/cancel") {
        cancelCalls += 1;
        setTimeout(() => {
          if (!promptSocket) return;
          writeSseChunk(
            promptSocket,
            { jsonrpc: "2.0", id: promptRequestId, result: { stopReason: "cancelled" } },
            true,
          );
        });
        return emptyResponse();
      }
      promptSocket = socket;
      promptRequestId = rpc.id;
      startStreamingSse(socket);
      promptStarted();
      return null;
    });
    const attachment = await openWorkBuddyAiTaskEndpoint(
      { endpoint, taskId, workspace, acpVersion: 1 },
      1_000,
      async () => ({ pid: 120, parentPid: 110, executablePath: `${applicationPath}/Contents/MacOS/Electron` }),
    );
    let accepted = 0;
    const result = collect(
      attachment.prompt({
        prompt: "Cancel before acceptance",
        turnId: "pre-accept-cancel-turn",
        onAccepted: async () => {
          accepted += 1;
        },
        workspace: {
          projectId: null,
          workingDirectory: workspace,
          additionalDirectories: [],
          skipGitRepoCheck: false,
        },
      }),
    );
    await started;

    await expect(attachment.cancel?.()).resolves.toBeTrue();
    await expect(result).resolves.toEqual([]);
    expect(accepted).toBe(0);
    expect(cancelCalls).toBe(1);
    await expect(attachment.cancel?.()).resolves.toBeFalse();
    await attachment.close();
  });

  it("reconciles an idle WorkBuddy UI turn and rejects Connect prompts while native state is busy", async () => {
    let broadcastSocket: Socket | undefined;
    let broadcastReady!: () => void;
    const ready = new Promise<void>((resolve) => {
      broadcastReady = resolve;
    });
    const endpoint = await serve(
      (request, socket) => {
        if (request.path.endsWith("/connect")) return jsonResponse({ connectionId: "broadcast-connection" });
        if (request.method === "DELETE") return emptyResponse();
        const rpc = JSON.parse(request.body) as { id: number; method: string };
        if (rpc.method === "initialize") {
          return sseResponse([{ jsonrpc: "2.0", id: rpc.id, result: { protocolVersion: 1 } }]);
        }
        if (rpc.method === "session/load") {
          return sseResponse([
            update({ sessionUpdate: "session_info_update", _meta: { "codebuddy.ai/historyReplay": "start" } }),
            update({ sessionUpdate: "session_info_update", _meta: { "codebuddy.ai/historyReplay": "end" } }),
            { jsonrpc: "2.0", id: rpc.id, result: {} },
          ]);
        }
        writeStreamingSse(socket, [
          update({
            sessionUpdate: "user_message_chunk",
            messageId: "connect-after-ui",
            content: { type: "text", text: "Continue" },
          }),
          update({
            sessionUpdate: "agent_message_chunk",
            messageId: "connect-after-ui-answer",
            content: { type: "text", text: "Continued" },
          }),
          { jsonrpc: "2.0", id: rpc.id, result: { stopReason: "end_turn" } },
        ]);
        return null;
      },
      (_request, socket) => {
        broadcastSocket = socket;
        startStreamingSse(socket);
        broadcastReady();
        return null;
      },
    );
    const attachment = await openWorkBuddyAiTaskEndpoint(
      { endpoint, taskId, workspace, acpVersion: 1 },
      1_000,
      async () => ({ pid: 120, parentPid: 110, executablePath: `${applicationPath}/Contents/MacOS/Electron` }),
    );
    await ready;
    const uiBroadcastSocket = requireSocket(broadcastSocket, "WorkBuddy broadcast");
    const promptInput = {
      prompt: "Continue after UI",
      turnId: "after-ui",
      workspace: {
        projectId: null,
        workingDirectory: workspace,
        additionalDirectories: [],
        skipGitRepoCheck: false,
      },
    };

    writeSseChunk(
      uiBroadcastSocket,
      update({
        sessionUpdate: "session_info_update",
        _meta: { "codebuddy.ai/agentPhase": { phase: "thinking" } },
      }),
    );
    await Bun.sleep(5);
    expect(() => attachment.prompt(promptInput)).toThrow("busy in another UI");

    writeSseChunk(
      uiBroadcastSocket,
      update({
        sessionUpdate: "user_message_chunk",
        messageId: "ui-user",
        content: { type: "text", text: "UI-only question" },
      }),
    );
    writeSseChunk(
      uiBroadcastSocket,
      update({
        sessionUpdate: "agent_message_chunk",
        messageId: "ui-assistant",
        content: { type: "text", text: "UI-only answer" },
      }),
    );
    writeSseChunk(uiBroadcastSocket, update({ sessionUpdate: "session_end", stopReason: "end_turn" }));
    writeSseChunk(
      uiBroadcastSocket,
      update({
        sessionUpdate: "session_info_update",
        _meta: { "codebuddy.ai/agentPhase": { phase: "idle" } },
      }),
    );
    await Bun.sleep(5);

    const activities = await collect(attachment.prompt(promptInput));
    expect(activities.find((activity) => activity.id === "workbuddy:user:ui-user")).toMatchObject({
      text: "UI-only question",
      state: "complete",
      data: { deliveryDisposition: "projection-only" },
    });
    expect(activities.filter((activity) => activity.id === "workbuddy:assistant:ui-assistant").at(-1)).toMatchObject({
      text: "UI-only answer",
      state: "complete",
      data: { deliveryDisposition: "projection-only" },
    });
    await attachment.close();
  });

  it("keeps active prompt state independent across distinct Task Attachments", async () => {
    const secondTaskId = "00000000-0000-4000-8000-000000000002";
    const heldEndpoint = async (nativeTaskId: string) => {
      let promptSocket: Socket | undefined;
      let promptRequestId: number | undefined;
      let promptStarted!: () => void;
      const started = new Promise<void>((resolve) => {
        promptStarted = resolve;
      });
      const endpoint = await serve((request, socket) => {
        if (request.path.endsWith("/connect")) {
          return jsonResponse({ connectionId: `connection-${nativeTaskId}` });
        }
        if (request.method === "DELETE") return emptyResponse();
        const rpc = JSON.parse(request.body) as { id: number; method: string };
        if (rpc.method === "initialize") {
          return sseResponse([{ jsonrpc: "2.0", id: rpc.id, result: { protocolVersion: 1 } }]);
        }
        if (rpc.method === "session/load") {
          return sseResponse([
            updateFor(nativeTaskId, {
              sessionUpdate: "session_info_update",
              _meta: { "codebuddy.ai/historyReplay": "start" },
            }),
            updateFor(nativeTaskId, {
              sessionUpdate: "session_info_update",
              _meta: { "codebuddy.ai/historyReplay": "end" },
            }),
            { jsonrpc: "2.0", id: rpc.id, result: {} },
          ]);
        }
        promptSocket = socket;
        promptRequestId = rpc.id;
        promptStarted();
        startStreamingSse(socket);
        writeSseChunk(
          socket,
          updateFor(nativeTaskId, {
            sessionUpdate: "agent_message_chunk",
            messageId: `assistant-${nativeTaskId}`,
            content: { type: "text", text: `running-${nativeTaskId}` },
          }),
        );
        return null;
      });
      return {
        endpoint,
        started,
        finish: () => {
          const socket = requireSocket(promptSocket, `prompt ${nativeTaskId}`);
          writeSseChunk(socket, { jsonrpc: "2.0", id: promptRequestId, result: { stopReason: "end_turn" } }, true);
        },
      };
    };
    const firstFixture = await heldEndpoint(taskId);
    const secondFixture = await heldEndpoint(secondTaskId);
    const [first, second] = await Promise.all([
      openWorkBuddyAiTaskEndpoint(
        { endpoint: firstFixture.endpoint, taskId, workspace, acpVersion: 1 },
        1_000,
        async () => ({ pid: 120, parentPid: 110, executablePath: `${applicationPath}/Contents/MacOS/Electron` }),
      ),
      openWorkBuddyAiTaskEndpoint(
        { endpoint: secondFixture.endpoint, taskId: secondTaskId, workspace, acpVersion: 1 },
        1_000,
        async () => ({ pid: 121, parentPid: 110, executablePath: `${applicationPath}/Contents/MacOS/Electron` }),
      ),
    ]);
    const promptInput = (suffix: string) => ({
      prompt: `Prompt ${suffix}`,
      turnId: `turn-${suffix}`,
      workspace: {
        projectId: null,
        workingDirectory: workspace,
        additionalDirectories: [],
        skipGitRepoCheck: false,
      },
    });

    const firstResult = collect(first.prompt(promptInput("first")));
    const secondResult = collect(second.prompt(promptInput("second")));
    await Promise.all([firstFixture.started, secondFixture.started]);
    expect(() => first.prompt(promptInput("first-overlap"))).toThrow("already has an active Connect prompt");
    secondFixture.finish();
    await expect(secondResult).resolves.toBeArray();
    expect(() => first.prompt(promptInput("still-first"))).toThrow("already has an active Connect prompt");
    firstFixture.finish();
    await expect(firstResult).resolves.toBeArray();
    await Promise.all([first.close(), second.close()]);
  });

  it("marks a disconnect after prompt transmission as uncertain without recording native acceptance", async () => {
    const endpoint = await serve((request, socket) => {
      if (request.path.endsWith("/connect")) return jsonResponse({ connectionId: "uncertain-connection" });
      if (request.method === "DELETE") return emptyResponse();
      const rpc = JSON.parse(request.body) as { id: number; method: string };
      if (rpc.method === "initialize") {
        return sseResponse([{ jsonrpc: "2.0", id: rpc.id, result: { protocolVersion: 1 } }]);
      }
      if (rpc.method === "session/load") {
        return sseResponse([
          update({ sessionUpdate: "session_info_update", _meta: { "codebuddy.ai/historyReplay": "start" } }),
          update({ sessionUpdate: "session_info_update", _meta: { "codebuddy.ai/historyReplay": "end" } }),
          { jsonrpc: "2.0", id: rpc.id, result: {} },
        ]);
      }
      socket.destroy();
      return null;
    });
    const attachment = await openWorkBuddyAiTaskEndpoint(
      { endpoint, taskId, workspace, acpVersion: 1 },
      1_000,
      async () => ({
        pid: 120,
        parentPid: 110,
        executablePath: `${applicationPath}/Contents/MacOS/Electron`,
      }),
    );
    let accepted = 0;

    const result = collect(
      attachment.prompt({
        prompt: "may have reached WorkBuddy",
        turnId: "uncertain-transmission",
        onAccepted: async () => {
          accepted += 1;
        },
        workspace: {
          projectId: null,
          workingDirectory: workspace,
          additionalDirectories: [],
          skipGitRepoCheck: false,
        },
      }),
    );

    await expect(result).rejects.toMatchObject({ nativeAcceptance: "uncertain" });
    expect(accepted).toBe(0);
    await expect(attachment.cancel?.()).resolves.toBeFalse();
    await attachment.close();
  });

  it("reports authentication expiry on an attached Task without marking the prompt accepted", async () => {
    const endpoint = await serve((request) => {
      if (request.path.endsWith("/connect")) return jsonResponse({ connectionId: "expiring-connection" });
      if (request.method === "DELETE") return emptyResponse();
      const rpc = JSON.parse(request.body) as { id: number; method: string };
      if (rpc.method === "initialize") {
        return sseResponse([{ jsonrpc: "2.0", id: rpc.id, result: { protocolVersion: 1 } }]);
      }
      if (rpc.method === "session/load") {
        return sseResponse([
          update({ sessionUpdate: "session_info_update", _meta: { "codebuddy.ai/historyReplay": "start" } }),
          update({ sessionUpdate: "session_info_update", _meta: { "codebuddy.ai/historyReplay": "end" } }),
          { jsonrpc: "2.0", id: rpc.id, result: {} },
        ]);
      }
      return jsonResponse({ error: "expired" }, false, 401);
    });
    const attachment = await openWorkBuddyAiTaskEndpoint(
      { endpoint, taskId, workspace, acpVersion: 1 },
      1_000,
      async () => ({
        pid: 120,
        parentPid: 110,
        executablePath: `${applicationPath}/Contents/MacOS/Electron`,
      }),
    );
    let accepted = 0;

    const result = collect(
      attachment.prompt({
        prompt: "credential expires now",
        turnId: "expired-credential",
        onAccepted: async () => {
          accepted += 1;
        },
        workspace: {
          projectId: null,
          workingDirectory: workspace,
          additionalDirectories: [],
          skipGitRepoCheck: false,
        },
      }),
    );

    await expect(result).rejects.toMatchObject({ code: "authentication-failed" });
    expect(accepted).toBe(0);
    await attachment.close();
  });
});

interface FakeRequest {
  method: string;
  path: string;
  body: string;
}

type FakeResponse =
  | { raw: string }
  | { body: string; contentType: string; chunked?: boolean; fragmented?: boolean; statusCode?: number };

async function serve(
  respond: (request: FakeRequest, socket: Socket) => FakeResponse | null,
  broadcast?: (request: FakeRequest, socket: Socket) => FakeResponse | null,
): Promise<string> {
  const sockets = new Set<Socket>();
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    let buffer = Buffer.alloc(0);
    socket.on("data", (chunk) => {
      buffer = Buffer.concat([buffer, Buffer.from(chunk)]);
      while (true) {
        const parsed = parseRequest(buffer);
        if (!parsed) break;
        buffer = buffer.subarray(parsed.consumedBytes);
        const response =
          parsed.request.method === "GET"
            ? (broadcast?.(parsed.request, socket) ?? null)
            : respond(parsed.request, socket);
        if (response) writeResponse(socket, response);
      }
    });
  });
  server.on("close", () => {
    for (const socket of sockets) socket.destroy();
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  servers.push(server);
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("fixture server did not expose a TCP port");
  return `http://127.0.0.1:${address.port}/api/v1/acp`;
}

function parseRequest(buffer: Buffer): { request: FakeRequest; consumedBytes: number } | null {
  const headerEnd = buffer.indexOf("\r\n\r\n");
  if (headerEnd < 0) return null;
  const lines = buffer.subarray(0, headerEnd).toString("utf8").split("\r\n");
  const [method = "", path = ""] = (lines.shift() ?? "").split(" ");
  const contentLengthLine = lines.find((line) => line.toLowerCase().startsWith("content-length:"));
  const contentLength = Number(contentLengthLine?.split(":", 2)[1]?.trim() ?? "0");
  const bodyOffset = headerEnd + 4;
  if (buffer.byteLength < bodyOffset + contentLength) return null;
  return {
    request: { method, path, body: buffer.subarray(bodyOffset, bodyOffset + contentLength).toString("utf8") },
    consumedBytes: bodyOffset + contentLength,
  };
}

function writeResponse(socket: Socket, response: FakeResponse): void {
  if ("raw" in response) {
    socket.write(response.raw);
    return;
  }
  const body = response.chunked ? chunk(response.body) : response.body;
  const framing = response.chunked
    ? "Transfer-Encoding: chunked"
    : `Content-Length: ${Buffer.byteLength(response.body)}`;
  const statusCode = response.statusCode ?? 200;
  const value = `HTTP/1.1 ${statusCode} ${statusCode === 200 ? "OK" : "Rejected"}\r\nContent-Type: ${response.contentType}\r\n${framing}\r\nConnection: keep-alive\r\n\r\n${body}`;
  if (!response.fragmented) {
    socket.write(value);
    return;
  }
  const midpoint = Math.floor(value.length / 2);
  socket.write(value.slice(0, midpoint));
  setTimeout(() => socket.write(value.slice(midpoint)), 1);
}

function writeStreamingSse(socket: Socket, values: unknown[]): void {
  startStreamingSse(socket);
  values.forEach((value, index) => {
    setTimeout(() => {
      writeSseChunk(socket, value, index === values.length - 1);
    }, index * 2);
  });
}

function startStreamingSse(socket: Socket): void {
  socket.write(
    "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nTransfer-Encoding: chunked\r\nConnection: keep-alive\r\n\r\n",
  );
}

function writeSseChunk(socket: Socket, value: unknown, end = false): void {
  const payload = `data: ${JSON.stringify(value)}\n\n`;
  socket.write(`${Buffer.byteLength(payload).toString(16)}\r\n${payload}\r\n`);
  if (end) socket.write("0\r\n\r\n");
}

function writeHeartbeatSse(socket: Socket, requestId: number): void {
  socket.write(
    "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nTransfer-Encoding: chunked\r\nConnection: keep-alive\r\n\r\n",
  );
  for (const delay of [10, 20, 30, 40]) {
    setTimeout(() => {
      const heartbeat = ": heartbeat\n\n";
      socket.write(`${Buffer.byteLength(heartbeat).toString(16)}\r\n${heartbeat}\r\n`);
    }, delay);
  }
  setTimeout(() => {
    const values = [
      update({ sessionUpdate: "session_info_update", _meta: { "codebuddy.ai/historyReplay": "start" } }),
      update({ sessionUpdate: "session_info_update", _meta: { "codebuddy.ai/historyReplay": "end" } }),
      { jsonrpc: "2.0", id: requestId, result: { models: [] } },
    ];
    const payload = values.map((value) => `data: ${JSON.stringify(value)}\n\n`).join("");
    socket.write(`${Buffer.byteLength(payload).toString(16)}\r\n${payload}\r\n0\r\n\r\n`);
  }, 50);
}

function jsonResponse(value: unknown, fragmented = false, statusCode = 200): FakeResponse {
  return { body: JSON.stringify(value), contentType: "application/json", fragmented, statusCode };
}

function sseResponse(values: unknown[], fragmented = false): FakeResponse {
  return {
    body: values.map((value) => `data: ${JSON.stringify(value)}\n\n`).join(""),
    contentType: "text/event-stream",
    chunked: true,
    fragmented,
  };
}

function emptyResponse(): FakeResponse {
  return { body: "", contentType: "application/json" };
}

function chunk(value: string): string {
  return `${Buffer.byteLength(value).toString(16)}\r\n${value}\r\n0\r\n\r\n`;
}

function update(value: Record<string, unknown>): Record<string, unknown> {
  return updateFor(taskId, value);
}

function updateFor(sessionId: string, value: Record<string, unknown>): Record<string, unknown> {
  return { jsonrpc: "2.0", method: "session/update", params: { sessionId, update: value } };
}

function requireSocket(socket: Socket | undefined, label: string): Socket {
  if (!socket) throw new Error(`${label} socket was not established`);
  return socket;
}

function fingerprint(messageIds: string[]): string {
  return createHash("sha256").update(JSON.stringify(messageIds)).digest("hex");
}

async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

async function collect(activities: AsyncIterable<RuntimeActivity>): Promise<RuntimeActivity[]> {
  const result: RuntimeActivity[] = [];
  for await (const activity of activities) result.push(activity);
  return result;
}

async function rejectAfter(timeoutMs: number, message: string): Promise<never> {
  await Bun.sleep(timeoutMs);
  throw new Error(message);
}
