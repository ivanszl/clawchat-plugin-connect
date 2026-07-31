// PROTOTYPE — answer one question:
// Can one Connect Service isolate two ClawChat owners by assigning each owner one
// same-kind Agent Binding with its own Binding Runtime Instance?

import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";
import { activateConnect } from "../activation";
import type { BindingRuntimeHandle } from "../binding-runtime";
import { getAgentBinding, normalizeConfig } from "../config";
import { startConnectService } from "../connect-service";
import { RuntimeAdapterRegistry } from "../runtime/registry";
import { createStateStore } from "../state";
import {
  assessMultiAccountSnapshot,
  type MultiAccountSnapshot,
  type PrototypeAssessment,
} from "./multi-account-bindings.logic.prototype";

const bindings = ["personal", "work"] as const;

async function runScenario(): Promise<PrototypeAssessment> {
  const directory = await mkdtemp(join(tmpdir(), "clawchat-connect-multi-account-prototype-"));
  const config = normalizeConfig({
    defaultAgent: "personal",
    stateDbPath: join(directory, "state.sqlite"),
    livewareAccessPolicy: "off",
    agents: {
      personal: { kind: "codex" },
      work: { kind: "codex" },
    },
  });
  const store = createStateStore({ dbPath: config.stateDbPath });
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    if (url.endsWith("/v1/agents/connect")) {
      const body = JSON.parse(String(init?.body)) as { code: string };
      const bindingId = body.code === "PERSONAL-CODE" ? "personal" : "work";
      return jsonResponse({
        code: 0,
        data: {
          access_token: `token-${bindingId}`,
          agent: {
            id: `agent-${bindingId}`,
            user_id: `user-${bindingId}`,
            owner_id: `owner-${bindingId}`,
          },
          conversation: { id: `direct-${bindingId}` },
        },
      });
    }
    return jsonResponse({ code: 0, data: { nickname: "updated" } });
  }) as unknown as typeof fetch;

  await activateConnect({
    agentId: "personal",
    code: "PERSONAL-CODE",
    config,
    store,
    fetchImpl,
  });
  await activateConnect({
    agentId: "work",
    code: "WORK-CODE",
    config,
    store,
    fetchImpl,
  });

  for (const bindingId of bindings) {
    await store.upsertRuntimeSession({
      chatId: "same-chat-id",
      sessionId: "same-session-id",
      agentId: bindingId,
      runtimeSessionId: `thread-${bindingId}`,
      name: `${bindingId} Session`,
      hasMessages: true,
    });
    await store.upsertInboundMessage({
      agentId: bindingId,
      direction: "inbound",
      kind: "message",
      eventType: "message.created",
      chatId: "same-chat-id",
      messageId: "same-message-id",
      text: `message for ${bindingId}`,
      raw: { bindingId },
    });
    await store.setRuntimeConnectionStatus(bindingId, bindingId === "personal", null);
    await store.submitToolRequest({
      requestId: `request-${bindingId}`,
      bindingId,
      toolName: "clawchat_get_my_profile",
      normalizedInput: {},
      timeoutMs: 60_000,
    });
  }
  await store.markInboundMessageHandled("personal", "same-message-id", { bindingId: "personal" });

  const activations = await store.listActivations();
  const sessions = await Promise.all(
    bindings.map(async (bindingId) => ({
      bindingId,
      visibleNames: (await store.listRuntimeSessions("same-chat-id", bindingId)).map(
        (session) => session.name ?? "(unnamed)",
      ),
    })),
  );
  const messageHandling = await Promise.all(
    bindings.map(async (bindingId) => ({
      bindingId,
      handled: await store.hasHandledInboundMessage(bindingId, "same-message-id", { bindingId }),
    })),
  );
  const toolRequests = await Promise.all(
    bindings.map(async (bindingId) => ({
      bindingId,
      claimedBindingId: (await store.claimNextToolRequest(bindingId))?.bindingId ?? null,
    })),
  );
  const runtimeStatuses = await Promise.all(
    bindings.map(async (bindingId) => ({
      bindingId,
      connected: (await store.getRuntimeStatus(bindingId))?.websocketConnected ?? null,
    })),
  );

  const runtimeOwnerIds: string[] = [];
  let runtimeInstanceCount = 0;
  const createRuntimeAdapterRegistry = () =>
    new RuntimeAdapterRegistry([
      {
        kind: "codex",
        create: () => {
          runtimeInstanceCount += 1;
          return {
            kind: "codex",
            modes: ["read-only"],
            prepare: async () => undefined,
            start: async () => {
              throw new Error("prototype does not start a real Codex process");
            },
          };
        },
      },
    ]);
  const result = await startConnectService(
    {
      config,
      stateStore: store,
      waitUntilShutdown: async () => undefined,
      writeOutput: () => undefined,
      writeError: () => undefined,
    },
    {
      verifyInstalledSkills: async () => undefined,
      createRuntimeAdapterRegistry,
      startBindingRuntime: async (options): Promise<BindingRuntimeHandle> => {
        await options.runtimeAdapters.prepare(getAgentBinding(options.config, options.agentId));
        runtimeOwnerIds.push(options.activation.ownerUserId);
        return {
          agentId: options.agentId,
          websocketUrl: config.websocketUrl,
          deviceId: "shared-device-id",
          close: async () => undefined,
        };
      },
      startClientInterface: async () => ({
        origin: "http://127.0.0.1:47823",
        stop: async () => undefined,
      }),
    },
  );

  const snapshot: MultiAccountSnapshot = {
    activations: activations.map((activation) => ({
      bindingId: activation.localAgentId,
      ownerUserId: activation.ownerUserId,
      accessToken: activation.accessToken,
    })),
    sessions,
    messageHandling,
    toolRequests,
    runtimeStatuses,
    service: {
      startedBindingIds: result.startedAgentIds,
      runtimeOwnerIds,
      runtimeInstanceCount,
    },
  };
  return assessMultiAccountSnapshot(snapshot);
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function render(assessment: PrototypeAssessment | null): void {
  console.clear();
  console.log("\u001b[1mMulti-account Agent Binding prototype\u001b[0m");
  console.log("\u001b[2mOne Connect Service; two ClawChat owners; two Codex Binding Runtime Instances.\u001b[0m\n");
  if (!assessment) {
    console.log("No scenario has run yet.");
  } else {
    console.log(JSON.stringify(assessment, null, 2));
  }
  console.log("\n\u001b[1m[r]\u001b[0m rerun scenario  \u001b[1m[q]\u001b[0m quit");
}

if (process.argv.includes("--check")) {
  const assessment = await runScenario();
  console.log(JSON.stringify(assessment, null, 2));
  process.exitCode = assessment.feasible ? 0 : 1;
} else {
  const terminal = createInterface({ input: process.stdin, output: process.stdout });
  let assessment: PrototypeAssessment | null = await runScenario();
  for (;;) {
    render(assessment);
    const action = (await terminal.question("> ")).trim().toLowerCase();
    if (action === "q") break;
    if (action === "r") assessment = await runScenario();
  }
  terminal.close();
}
