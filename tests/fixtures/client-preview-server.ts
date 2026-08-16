import { mkdir, mkdtemp, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startClientInterface } from "../../src/client-interface/server";
import { TranscriptProjection } from "../../src/client-interface/transcript-projection";
import { defaultConfig } from "../../src/config";
import { createStateStore } from "../../src/persistence/state";
import type { OfficialPluginDiscovery } from "../../src/plugin/catalog";
import type { ConnectPluginHost, ManagePluginOptions } from "../../src/plugin/host";
import type { InstalledPluginLockEntry } from "../../src/plugin/store";
import { RuntimeAdapterRegistry } from "../../src/runtime/registry";
import { RuntimeInteractionCoordinator } from "../../src/runtime/runtime-interaction-coordinator";
import type { RuntimeActivity, RuntimeTranscriptEntry } from "../../src/runtime/types";
import { fixedRuntimeAdapter, pluginBinding } from "../runtime-adapter-fixture";

const directory = await mkdtemp(join(tmpdir(), "connect-client-preview-"));
const repositoryRoot = process.cwd();
const projectDirectory = join(directory, "clawchat-plugin-connect");
const discoveredWorkspace = join(directory, "discovered-workspace");
const archivedDiscoveredWorkspace = join(directory, "archived", "discovered-workspace");
await mkdir(projectDirectory);
await mkdir(discoveredWorkspace);
await mkdir(archivedDiscoveredWorkspace, { recursive: true });
const projectRoot = await realpath(projectDirectory);
const artifactSpecPath = join(projectRoot, "artifact-preview.md");
await Bun.write(artifactSpecPath, "# Mobile Artifact preview\n\n[Open TypeScript](./artifact-preview.ts)\n");
await Bun.write(join(projectRoot, "artifact-preview.ts"), 'export const mobileArtifact = "ready";\n');
const refs = ["ABCDEFGH", "JKLMNPQR", "STUVWXYZ", "23456789", "BCDEFGHJ", "CDEFGHJK", "DEFGHJKM", "EFGHJKMN"];
const stateStore = createStateStore({
  dbPath: join(directory, "state.sqlite"),
  sessionRefFactory: () => {
    const ref = refs.shift();
    if (!ref) throw new Error("Preview fixture exhausted Session Refs");
    return ref;
  },
});
await stateStore.upsertActivation({
  localAgentId: "codex",
  accessToken: "preview-token",
  refreshToken: null,
  serverAgentId: "preview-agent",
  userId: "usr_connect_preview",
  ownerUserId: "usr_preview_owner",
  conversationId: "preview-conversation",
});
await stateStore.insertProject({ projectId: "connect", name: "connect-qa", rootPath: projectRoot });
await stateStore.upsertRuntimeSession({
  chatId: "chat-project",
  sessionId: "session-project",
  agentId: "codex",
  runtimeSessionId: "thread-project",
  projectId: "connect",
  name: "App Server 与 Web Client",
  hasMessages: true,
  isCurrent: true,
});
await stateStore.upsertRuntimeSession({
  chatId: "chat-local",
  sessionId: "session-local",
  agentId: "codex",
  runtimeSessionId: "thread-local",
  name: "Non-Project scratch",
  model: "gpt-removed",
  reasoningEffort: "high",
  hasMessages: true,
  isCurrent: true,
});
await stateStore.setRuntimeConnectionStatus("codex", true, null);

const transcripts = new Map<string, RuntimeTranscriptEntry[]>([
  [
    "thread-project",
    [
      {
        id: "u1",
        kind: "user",
        text: "ClawChat direct message from Colin:\n实现 app-server 后再构建 Web。",
        state: "complete",
        source: "history",
      },
      {
        id: "r1",
        kind: "reasoning",
        text: "先固定协议边界，再把浏览器限制在 Connect Client Interface。",
        state: "complete",
        source: "history",
      },
      {
        id: "p1",
        kind: "plan",
        text: "1. 迁移 app-server\n2. 建立 Client Contract\n3. 构建 React SPA\n4. 联调与验证",
        state: "complete",
        source: "history",
      },
      {
        id: "c1",
        kind: "command",
        text: "94 tests passed",
        state: "complete",
        source: "history",
        data: { command: "bun test", status: "completed", exitCode: 0 },
      },
      {
        id: "f1",
        kind: "file-change",
        text: "Web files created",
        state: "complete",
        source: "history",
        data: {
          status: "completed",
          changes: [{ path: "web/src/main.tsx", kind: "add", diff: "+ createRoot(root).render(<ConnectClient />);" }],
        },
      },
      {
        id: "x1",
        kind: "unknown",
        text: "imageGeneration",
        state: "complete",
        source: "history",
        data: { itemType: "imageGeneration" },
      },
      {
        id: "a1",
        kind: "assistant",
        text: "App Server 已成为 Codex 的唯一生产协议；Web 只连接 Connect，并可从原生 thread 重建完整消息。",
        state: "complete",
        source: "history",
      },
      {
        id: "a-artifact",
        kind: "assistant",
        text: `[打开 Artifact 移动端测试](${artifactSpecPath})`,
        state: "complete",
        source: "history",
      },
    ],
  ],
  [
    "thread-local",
    [
      {
        id: "u2",
        kind: "user",
        text: "检查一个 Non-Project Session。",
        state: "complete",
        source: "history",
      },
      {
        id: "a2",
        kind: "assistant",
        text: "这个 Session 会直接显示在导航中，不套 Project 节点。",
        state: "complete",
        source: "history",
      },
    ],
  ],
  [
    "thread-unmanaged",
    [
      {
        id: "u3",
        kind: "user",
        text: "来自 Codex TUI 的现有 thread。",
        state: "complete",
        source: "history",
      },
      {
        id: "a3",
        kind: "assistant",
        text: "网页可以发现并打开它，首次发送时由 Connect 采用。",
        state: "complete",
        source: "history",
      },
    ],
  ],
]);
let projectThreadUpdatedAt = Date.now();
function appendExternalTuiTurn() {
  transcripts.get("thread-project")?.push(
    {
      id: "tui-external-user",
      kind: "user",
      text: "来自 Codex TUI 的外部消息。",
      state: "complete",
      source: "history",
    },
    {
      id: "tui-external-assistant",
      kind: "assistant",
      text: "这条回复应在刷新 Session 后同步到 Web。",
      state: "complete",
      source: "history",
    },
  );
  projectThreadUpdatedAt += 1_000;
}

const runtimeAdapters = new RuntimeAdapterRegistry([
  fixedRuntimeAdapter({
    kind: "codex",
    modes: ["read-only", "workspace-write", "danger-full-access"],
    listModels: async () => [
      {
        id: "gpt-default",
        displayName: "Default model",
        description: "Runtime default",
        isDefault: true,
        defaultReasoningEffort: "medium",
        supportedReasoningEfforts: ["low", "medium", "high"],
        inputModalities: ["text", "image"],
      },
      {
        id: "gpt-deep",
        displayName: "Deep model",
        description: "Long-running coding work",
        isDefault: false,
        defaultReasoningEffort: "high",
        supportedReasoningEfforts: ["high", "xhigh"],
        inputModalities: ["text", "image"],
      },
    ],
    listSkills: async () => [
      {
        id: "codex:grill-with-docs",
        name: "grill-with-docs",
        description: "结合官方文档追问并检验方案",
      },
      { id: "codex:research", name: "research", description: "调查可靠的一手资料" },
    ],
    listCommands: async () => [
      { id: "preview-command:compact", name: "compact", description: "Compact the Session context" },
    ],
    discoverAllThreads: async () => [
      {
        runtimeThreadId: "thread-project",
        name: "App Server 与 Web Client",
        updatedAt: projectThreadUpdatedAt,
        workingDirectory: projectRoot,
      },
      { runtimeThreadId: "thread-local", name: "Non-Project scratch", updatedAt: Date.now() - 1_000 },
      {
        runtimeThreadId: "thread-unmanaged",
        name: "Codex TUI existing thread",
        updatedAt: Date.now() - 2_000,
        workingDirectory: discoveredWorkspace,
      },
      {
        runtimeThreadId: "thread-unmanaged-archived",
        name: "Archived Codex TUI thread",
        updatedAt: Date.now() - 3_000,
        workingDirectory: archivedDiscoveredWorkspace,
        isArchived: true,
      },
    ],
    readActivity: async (_binding, runtimeThreadId) => ({
      activities: (transcripts.get(runtimeThreadId) ?? []).map((entry, index) => previewActivity(entry, `${index}`)),
      completeness: "complete",
      limitations: [],
    }),
    start: async () => ({ prompt: async function* () {}, close: async () => undefined }),
  }),
]);

function previewActivity(
  entry: RuntimeTranscriptEntry,
  position: string,
  parentId: string | null = null,
): RuntimeActivity {
  return {
    ...entry,
    position,
    parentId,
    children: entry.children?.map((child, index) => previewActivity(child, `${position}.${index}`, entry.id)),
  };
}

const config = defaultConfig();
config.clientPort = Number(process.env.CONNECT_CLIENT_PREVIEW_PORT ?? 47_893);
config.stateDbPath = stateStore.dbPath;
config.defaultAgent = "codex";
config.agents = { codex: pluginBinding({}, { displayName: "Codex · Local" }) };
const transcriptProjection = new TranscriptProjection({ stateStore, config, runtimeAdapters });
const runtimeInteractions = new RuntimeInteractionCoordinator(transcriptProjection);
const activityBySessionRef = new Map<string, "running" | "queued" | "idle">();
const previewApproval = runtimeInteractions.request(
  {
    kind: "approval",
    action: "command",
    title: "允许 Codex 更新本地 Connect？",
    description: "该命令会替换本机安装的 Connect 并重启服务。",
    command: "install dist/clawchat-connect ~/.local/bin/clawchat-connect",
    cwd: projectRoot,
    options: [
      { id: "approve-once", label: "仅此次允许" },
      { id: "approve-session", label: "本 Session 允许" },
      { id: "deny", label: "拒绝" },
    ],
  },
  { sessionRef: "ABCDEFGH", turnId: "preview-approval", origin: "client" },
);
void previewApproval.catch(() => undefined);
while ((await stateStore.listPendingRuntimeInteractions("ABCDEFGH")).length === 0) await Bun.sleep(0);
const runtime = {
  agentId: "codex",
  websocketUrl: config.websocketUrl,
  deviceId: "preview",
  close: async () => undefined,
  enqueueClientTurn: async (sessionRef: string, prompt: string) => {
    const turnId = crypto.randomUUID();
    activityBySessionRef.set(sessionRef, "running");
    void (async () => {
      await transcriptProjection.appendUserMessage({ sessionRef, text: prompt, origin: "client", author: "You" });
      await Bun.sleep(250);
      await transcriptProjection.upsertRuntimeActivity(sessionRef, {
        id: `preview:${turnId}`,
        position: `preview:${turnId}`,
        parentId: null,
        kind: "assistant",
        text: "这是 Preview Runtime 的本地回复；它不会发送到 ClawChat。",
        state: "complete",
        source: "live",
        data: { outputKind: "final" },
      });
      activityBySessionRef.set(sessionRef, "idle");
    })();
    return { sessionRef, turnId };
  },
  cancelClientTurn: async () => true,
  sessionActivity: async (sessionRef: string) => activityBySessionRef.get(sessionRef) ?? "idle",
};
const previewIntegrity = "sha256-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";
function previewPlugin(pluginId: string, status: InstalledPluginLockEntry["status"], error: string | null) {
  const manifest: InstalledPluginLockEntry["manifest"] = {
    manifestVersion: 1,
    interfaceVersion: "1",
    pluginId,
    version: "1.0.0",
    dependencies: [{ type: "host", id: "runtime-provider", interfaceVersion: "1" }],
    installationConfigurationSchema: {
      type: "object",
      properties: {
        channel: { type: "string", title: "Release channel", enum: ["stable", "preview"] },
        telemetry: { type: "boolean", title: "Share local diagnostics", default: false },
      },
      required: ["channel"],
      additionalProperties: false,
    },
    capabilities: [
      {
        id: "runtime",
        type: "runtime",
        interfaceVersion: "1",
        family: "preview",
        configurationSchema: {
          type: "object",
          properties: { workspace: { type: "string", title: "Workspace policy" } },
          required: ["workspace"],
          additionalProperties: false,
        },
      },
    ],
    artifacts: [{ target: "preview-target", entry: "entry.mjs", integrity: previewIntegrity }],
  };
  const version = {
    source: { type: "local" as const, path: `/preview/${pluginId}.connect-plugin` },
    version: "1.0.0",
    target: "preview-target",
    integrity: previewIntegrity,
    activeArtifact: `/preview/${pluginId}/entry.mjs`,
    manifestPath: `/preview/${pluginId}/connect-plugin.json`,
    manifest,
    installationConfiguration: { channel: "stable", telemetry: false },
    exposureConfigurations: {},
  };
  return {
    pluginId,
    ...version,
    status,
    error,
    retainedVersions: [{ ...version, version: "0.9.0", manifest: { ...manifest, version: "0.9.0" } }],
  } satisfies InstalledPluginLockEntry;
}
const previewPlugins: InstalledPluginLockEntry[] = [
  previewPlugin("preview.healthy", "active", null),
  previewPlugin("preview.failed", "error", "provider registration failed in preview fixture"),
];
const previewOfficial: OfficialPluginDiscovery = {
  catalogOrigin: "cache",
  diagnostics: ["Preview fixture uses an authenticated cached Catalog"],
  candidates: [
    {
      pluginId: "preview.official",
      name: "Official Preview Runtime",
      source: "npm:@clawchat/preview-runtime@1.0.0",
      resolvedSource: {
        type: "npm",
        package: "@clawchat/preview-runtime",
        registry: "https://registry.example.test",
        version: "1.0.0",
        tarball: "https://registry.example.test/preview-runtime.tgz",
      },
      version: "1.0.0",
      target: "preview-target",
      integrity: previewIntegrity,
      detected: true,
      compatible: true,
      selected: true,
      selectable: true,
      probe: { detected: true, compatible: true, version: "preview" },
      diagnostic: null,
      manifest: previewPlugin("preview.official", "active", null).manifest,
      installationConfiguration: { channel: "stable", telemetry: false },
      exposureConfigurations: {},
    },
  ],
};
function requirePreviewPlugin(pluginId: string) {
  const plugin = previewPlugins.find((entry) => entry.pluginId === pluginId);
  if (!plugin) throw new Error(`Preview Plugin ${pluginId} is not installed`);
  return plugin;
}

const previewPluginManager = {
  list: async () => structuredClone(previewPlugins),
  checkUpdates: async () => ({
    "preview.healthy": {
      status: "available" as const,
      version: "2.0.0",
      integrity: previewIntegrity,
      diagnostic: null,
    },
    "preview.failed": {
      status: "check-failed" as const,
      version: null,
      integrity: null,
      diagnostic: "Preview registry is intentionally unavailable",
    },
  }),
  discoverOfficial: async () => structuredClone(previewOfficial),
  install: async (options: ManagePluginOptions) => {
    const plugin = previewPlugin(`preview.direct.${previewPlugins.length}`, "active", null);
    plugin.source = { type: "local", path: options.source };
    previewPlugins.push(plugin);
    return structuredClone(plugin);
  },
  installUpload: async () => {
    const plugin = previewPlugin(`preview.upload.${previewPlugins.length}`, "active", null);
    previewPlugins.push(plugin);
    return structuredClone(plugin);
  },
  installOfficial: async () => {
    const plugin = previewPlugin("preview.official", "active", null);
    if (!previewPlugins.some((entry) => entry.pluginId === plugin.pluginId)) previewPlugins.push(plugin);
    return [structuredClone(plugin)];
  },
  update: async (pluginId: string) => {
    const plugin = requirePreviewPlugin(pluginId);
    plugin.version = "2.0.0";
    return structuredClone(plugin);
  },
  reinstall: async (pluginId: string) => structuredClone(requirePreviewPlugin(pluginId)),
  enable: async (pluginId: string) => {
    const plugin = requirePreviewPlugin(pluginId);
    plugin.status = "active";
    return structuredClone(plugin);
  },
  disable: async (pluginId: string) => {
    const plugin = requirePreviewPlugin(pluginId);
    plugin.status = "disabled";
    return structuredClone(plugin);
  },
  select: async (pluginId: string, version: string) => {
    const plugin = requirePreviewPlugin(pluginId);
    plugin.version = version;
    return structuredClone(plugin);
  },
  configure: async (pluginId: string, options: { installationConfiguration: Record<string, unknown> }) => {
    const plugin = requirePreviewPlugin(pluginId);
    plugin.installationConfiguration = structuredClone(options.installationConfiguration);
    return structuredClone(plugin);
  },
  remove: async (pluginId: string) => {
    const plugin = requirePreviewPlugin(pluginId);
    previewPlugins.splice(previewPlugins.indexOf(plugin), 1);
    return structuredClone(plugin);
  },
} as unknown as ConnectPluginHost;
const clientInterface = await startClientInterface({
  config,
  configPath: join(directory, "config.json"),
  stateStore,
  runtimeAdapters,
  transcriptProjection,
  runtimeInteractions,
  runtimes: [runtime],
  pluginManager: previewPluginManager,
  assetsPath: join(repositoryRoot, "dist/client"),
  serverFactory: (options) =>
    Bun.serve({
      ...options,
      fetch: async (request) => {
        if (new URL(request.url).pathname === "/__preview/external-tui-turn") {
          appendExternalTuiTurn();
          return new Response(null, { status: 204 });
        }
        return await options.fetch(request);
      },
    }),
});
process.stdout.write(`${clientInterface.origin}/\n`);

await new Promise<void>((resolve) => {
  process.once("SIGINT", resolve);
  process.once("SIGTERM", resolve);
});
await clientInterface.stop();
await runtimeInteractions.close();
await previewApproval.catch(() => undefined);
await stateStore.close();
