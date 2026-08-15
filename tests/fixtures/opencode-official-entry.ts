import { createOpenCodeOfficialPluginEntry } from "../../src/plugin/official/opencode-entry";
import type { OpenCodeMessage, OpenCodeServerClient } from "../../src/runtime/opencode-server";
import { OPENCODE_SDK_VERSION } from "../../src/runtime/opencode-version";

interface ConformanceState {
  active: boolean;
  closes: number;
  lifecycleCalls: string[];
  pending: boolean;
  pendingReject: ((error: Error) => void) | null;
}

const stateByInstance = (Reflect.get(globalThis, "__connectOpenCodeOfficialConformance") ?? {}) as Record<
  string,
  ConformanceState
>;
Reflect.set(globalThis, "__connectOpenCodeOfficialConformance", stateByInstance);

const entry = createOpenCodeOfficialPluginEntry({
  requireExecutable: () => ({ path: "/opt/opencode", version: OPENCODE_SDK_VERSION }),
  runtimeAdapter: {
    createServer: async (binding) => {
      const instance = binding.env?.CONFORMANCE_INSTANCE;
      if (!instance) throw new Error("OpenCode conformance instance is required");
      const state: ConformanceState = {
        active: true,
        closes: 0,
        lifecycleCalls: [],
        pending: false,
        pendingReject: null,
      };
      stateByInstance[instance] = state;
      return clientFor(state);
    },
  },
});

function clientFor(state: ConformanceState): OpenCodeServerClient {
  const session = {
    id: "thread-1",
    slug: "thread-1",
    projectID: "project-1",
    directory: "/repo",
    title: "Conformance",
    version: OPENCODE_SDK_VERSION,
    time: { created: 1, updated: 1 },
  };
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
  return {
    version: OPENCODE_SDK_VERSION,
    health: async () => ({ healthy: true, version: OPENCODE_SDK_VERSION }),
    listProjects: async () => [],
    listAgents: async () => {
      if (!state.pending) return [];
      const pending = Promise.withResolvers<never[]>();
      state.pendingReject = pending.reject;
      return await pending.promise;
    },
    listCommands: async () => [],
    listProviders: async () => ({ all: [], connected: [], default: {} }),
    listSessions: async (directory) => (!state.active || (directory && directory !== "/repo") ? [] : [session]),
    getSession: async () => {
      if (!state.active) throw new Error("not found");
      return session;
    },
    createSession: async () => session,
    deleteSession: async () => {
      if (!state.active) return false;
      state.lifecycleCalls.push("delete");
      state.active = false;
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
          const aborted = Promise.withResolvers<void>();
          if (signal.aborted) aborted.resolve();
          else signal.addEventListener("abort", () => aborted.resolve(), { once: true });
          await aborted.promise;
        },
      };
    },
    replyPermission: async () => true,
    replyQuestion: async () => true,
    rejectQuestion: async () => true,
    close: async () => {
      state.closes += 1;
      state.pendingReject?.(new Error("binding closed"));
    },
  };
}

export default entry;
