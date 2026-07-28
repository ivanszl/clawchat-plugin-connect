import { createCodexRuntimeAdapter } from "../../src/runtime/codex-adapter";
import { SUPPORTED_CODEX_VERSION } from "../../src/runtime/codex-app-server";
import type { ConnectRuntimePrompt } from "../../src/runtime/types";

const executable = process.env.CODEX_INTEGRATION_PATH?.trim();
const binding = {
  kind: "codex",
  ...(executable ? { codexPathOverride: executable } : {}),
} as const;
const adapter = createCodexRuntimeAdapter();
try {
  const models = await adapter.listModels?.(binding);
  if (!models || models.length === 0) throw new Error("Codex app-server advertised no visible models");
  const selected = models.find((model) => model.isDefault) ?? models[0];
  if (!selected) throw new Error("Codex app-server advertised no default model");
  let runtimeThreadId: string | null = null;
  const session = await adapter.start(binding, {
    agentId: "integration",
    chatId: "integration-model-catalog",
    sessionId: crypto.randomUUID(),
    runtimeSessionId: null,
    configPath: "/tmp/clawchat-connect-integration-config.json",
    stateDbPath: "/tmp/clawchat-connect-integration-state.sqlite",
    onRuntimeSessionId: async (value) => {
      if (runtimeThreadId && runtimeThreadId !== value)
        throw new Error("Codex model switch replaced the Runtime Thread");
      runtimeThreadId = value;
    },
  });
  const prompt = async (input: ConnectRuntimePrompt) => {
    const events = [];
    for await (const event of session.prompt(input)) events.push(event);
    const failure = events.find((event) => event.kind === "error" && event.text.startsWith("Codex execution failed:"));
    if (failure) throw new Error(failure.text);
  };
  const inputFor = (model: typeof selected): ConnectRuntimePrompt => ({
    prompt: "Reply with OK only.",
    workspace: {
      projectId: null,
      workingDirectory: process.cwd(),
      additionalDirectories: [],
      skipGitRepoCheck: true,
    },
    mode: "read-only",
    model: model.id,
    reasoningEffort: model.defaultReasoningEffort,
    outputPolicy: { mode: "client-full", allowedKinds: ["final"] },
  });
  await prompt(inputFor(selected));
  if (!runtimeThreadId) throw new Error("Codex did not return a Runtime Thread ID");
  const originalThreadId = runtimeThreadId;
  const alternate = models.find((model) => model.id !== selected.id);
  if (alternate) {
    await prompt(inputFor(alternate));
    if (runtimeThreadId !== originalThreadId)
      throw new Error("Codex model switch did not resume the same Runtime Thread");
    process.stdout.write(
      `Verified ${SUPPORTED_CODEX_VERSION} model catalog and ${selected.id} → ${alternate.id} on one Runtime Thread.\n`,
    );
  } else {
    process.stdout.write(
      `Verified ${SUPPORTED_CODEX_VERSION} model catalog and ${selected.id}; model switch skipped because only one model is advertised.\n`,
    );
  }
  await session.close();
} finally {
  await adapter.close?.();
}
