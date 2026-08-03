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
      catalog: {
        models: [],
        currentModelId: null,
        modes: [],
        currentModeId: null,
        configOptions: [],
        currentConfig: {},
        commands: [],
        skills: [],
      },
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

  it("derives Task capabilities from load updates and applies only an explicit supported model selection", async () => {
    const rpcMethods: string[] = [];
    const promptParams: Record<string, unknown>[] = [];
    const endpoint = await serve((request) => {
      if (request.path.endsWith("/connect")) return jsonResponse({ connectionId: "catalog-connection" });
      if (request.method === "DELETE") return emptyResponse();
      const rpc = JSON.parse(request.body) as { id: number; method: string; params: Record<string, unknown> };
      rpcMethods.push(rpc.method);
      if (rpc.method === "initialize") {
        return sseResponse([
          {
            jsonrpc: "2.0",
            id: rpc.id,
            result: {
              protocolVersion: 1,
              agentCapabilities: { promptCapabilities: { image: true, embeddedContext: true } },
            },
          },
        ]);
      }
      if (rpc.method === "session/load") {
        return sseResponse([
          update({ sessionUpdate: "session_info_update", _meta: { "codebuddy.ai/historyReplay": "start" } }),
          update({
            sessionUpdate: "available_commands_update",
            availableCommands: [
              { name: "review", description: "Review the current changes" },
              { name: "product-research", description: "Use WorkBuddy research", _meta: { type: "skill" } },
            ],
          }),
          update({ sessionUpdate: "session_info_update", _meta: { "codebuddy.ai/historyReplay": "end" } }),
          {
            jsonrpc: "2.0",
            id: rpc.id,
            result: {
              models: {
                currentModelId: "workbuddy-fast",
                availableModels: [
                  { modelId: "workbuddy-fast", name: "WorkBuddy AI Fast", description: "Product alias" },
                  { modelId: "workbuddy-deep", name: "WorkBuddy AI Deep" },
                ],
              },
              modes: {
                currentModeId: "plan",
                availableModes: [
                  { id: "plan", name: "Plan", description: "Read-only planning" },
                  { id: "work", name: "Work", description: "Product work mode" },
                ],
              },
              configOptions: [
                {
                  type: "select",
                  id: "thought_level",
                  name: "Deep Thinking",
                  category: "thought_level",
                  currentValue: "high",
                  options: [
                    { value: "low", name: "Low" },
                    { value: "high", name: "High" },
                  ],
                },
              ],
            },
          },
        ]);
      }
      if (rpc.method === "session/set_model") {
        expect(rpc.params).toEqual({ sessionId: taskId, modelId: "workbuddy-deep" });
        return sseResponse([{ jsonrpc: "2.0", id: rpc.id, result: { modelId: "workbuddy-deep" } }]);
      }
      if (rpc.method === "session/set_mode") {
        expect(rpc.params).toEqual({ sessionId: taskId, modeId: "work" });
        return sseResponse([
          update({ sessionUpdate: "current_mode_update", currentModeId: "work" }),
          { jsonrpc: "2.0", id: rpc.id, result: {} },
        ]);
      }
      if (rpc.method === "session/set_config_option") {
        expect(rpc.params).toEqual({ sessionId: taskId, configId: "thought_level", value: "low" });
        return sseResponse([
          {
            jsonrpc: "2.0",
            id: rpc.id,
            result: {
              configOptions: [
                {
                  type: "select",
                  id: "thought_level",
                  name: "Deep Thinking",
                  category: "thought_level",
                  currentValue: "low",
                  options: [
                    { value: "low", name: "Low" },
                    { value: "high", name: "High" },
                  ],
                },
              ],
            },
          },
        ]);
      }
      promptParams.push(rpc.params);
      return sseResponse([
        update({ sessionUpdate: "session_info_update", _meta: { "codebuddy.ai/agentPhase": { phase: "idle" } } }),
        { jsonrpc: "2.0", id: rpc.id, result: { stopReason: "end_turn" } },
      ]);
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

    expect(attachment.catalog?.currentModelId).toBe("workbuddy-fast");
    expect(attachment.catalog?.models).toEqual([
      {
        id: "workbuddy-fast",
        displayName: "WorkBuddy AI Fast",
        description: "Product alias",
        isDefault: true,
        defaultReasoningEffort: "default",
        supportedReasoningEfforts: ["default"],
        inputModalities: ["text"],
        turnSubmissionCapability: {
          prompt: { allowed: true, required: true, maxCharacters: 64_000 },
          attachments: { allowedKinds: [], allowedMediaTypes: [], maxCount: 0 },
        },
      },
      expect.objectContaining({ id: "workbuddy-deep", isDefault: false, inputModalities: ["text"] }),
    ]);
    expect(attachment.catalog?.modes).toEqual([
      { id: "plan", name: "Plan", description: "Read-only planning" },
      { id: "work", name: "Work", description: "Product work mode" },
    ]);
    expect(attachment.catalog?.currentModeId).toBe("plan");
    expect(attachment.catalog?.configOptions).toHaveLength(1);
    expect(attachment.catalog?.commands).toEqual([
      expect.objectContaining({ name: "review", nativeName: "review", kind: "command" }),
    ]);
    expect(attachment.catalog?.skills).toEqual([
      expect.objectContaining({ name: "product-research", nativeName: "product-research", kind: "skill" }),
    ]);

    await collect(
      attachment.prompt({
        prompt: "use the selected model",
        model: "workbuddy-deep",
        workspace: {
          projectId: null,
          workingDirectory: workspace,
          additionalDirectories: [],
          skipGitRepoCheck: false,
        },
      }),
    );
    expect(rpcMethods).toEqual(["initialize", "session/load", "session/set_model", "session/prompt"]);
    expect(attachment.catalog?.currentModelId).toBe("workbuddy-deep");

    const skillActivities = await collect(
      attachment.prompt({
        prompt: "/product-research compare sources",
        skill: { id: "workbuddy-skill:product-research", name: "product-research" },
        workspace: {
          projectId: null,
          workingDirectory: workspace,
          additionalDirectories: [],
          skipGitRepoCheck: false,
        },
      }),
    );
    expect(promptParams.at(-1)?.prompt).toEqual([{ type: "text", text: "/product-research compare sources" }]);
    expect(skillActivities.find((activity) => activity.kind === "user")?.data).toMatchObject({
      runtimeSlashSelection: {
        kind: "skill",
        id: "workbuddy-skill:product-research",
        name: "product-research",
      },
    });

    await collect(
      attachment.prompt({
        prompt: "apply native Task configuration",
        mode: "work",
        sessionOptions: { thought_level: "low" },
        workspace: {
          projectId: null,
          workingDirectory: workspace,
          additionalDirectories: [],
          skipGitRepoCheck: false,
        },
      }),
    );
    expect(attachment.catalog).toMatchObject({
      currentModeId: "work",
      currentConfig: { thought_level: "low" },
    });

    const acceptedBeforeRejection = rpcMethods.length;
    await expect(
      collect(
        attachment.prompt({
          prompt: "/removed-skill run",
          skill: { id: "workbuddy-skill:removed-skill", name: "removed-skill" },
          workspace: {
            projectId: null,
            workingDirectory: workspace,
            additionalDirectories: [],
            skipGitRepoCheck: false,
          },
        }),
      ),
    ).rejects.toThrow("WorkBuddy Skill is no longer available: removed-skill");
    await expect(
      collect(
        attachment.prompt({
          prompt: "inspect image",
          media: [{ kind: "image", url: "file:///private/tmp/unsupported.png", size: 1 }],
          workspace: {
            projectId: null,
            workingDirectory: workspace,
            additionalDirectories: [],
            skipGitRepoCheck: false,
          },
        }),
      ),
    ).rejects.toThrow("support text turns only");
    expect(rpcMethods).toHaveLength(acceptedBeforeRejection);
    await attachment.close();
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

async function serve(respond: (request: FakeRequest, socket: Socket) => FakeResponse | null): Promise<string> {
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
        const response = respond(parsed.request, socket);
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
  socket.write(
    "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nTransfer-Encoding: chunked\r\nConnection: keep-alive\r\n\r\n",
  );
  values.forEach((value, index) => {
    setTimeout(() => {
      const payload = `data: ${JSON.stringify(value)}\n\n`;
      socket.write(`${Buffer.byteLength(payload).toString(16)}\r\n${payload}\r\n`);
      if (index === values.length - 1) socket.write("0\r\n\r\n");
    }, index * 2);
  });
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
  return { jsonrpc: "2.0", method: "session/update", params: { sessionId: taskId, update: value } };
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
