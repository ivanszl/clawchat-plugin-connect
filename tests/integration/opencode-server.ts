import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildOfficialPlugin } from "../../scripts/build-official-plugins";
import { defaultConfig, saveConfig } from "../../src/config";
import { createAgentBinding } from "../../src/plugin/binding";
import { ConnectPluginHost } from "../../src/plugin/host";
import descriptor from "../../src/plugin/official/opencode-descriptor";
import {
  OPENCODE_OFFICIAL_CAPABILITY_ID,
  OPENCODE_OFFICIAL_PLUGIN_ID,
} from "../../src/plugin/official/opencode-manifest";
import { createOpenCodeServerClient } from "../../src/runtime/opencode-server";
import { RuntimeAdapterRegistry } from "../../src/runtime/registry";

const executable = process.env.OPENCODE_EXECUTABLE || Bun.which("opencode");
if (!executable) throw new Error("Set OPENCODE_EXECUTABLE or add OpenCode to PATH");

const directory = await realpath(await mkdtemp(join(tmpdir(), "clawchat-connect-opencode-integration-")));
const client = await createOpenCodeServerClient({
  ...createAgentBinding({
    pluginId: OPENCODE_OFFICIAL_PLUGIN_ID,
    capabilityId: OPENCODE_OFFICIAL_CAPABILITY_ID,
  }),
  executablePathOverride: executable,
});
const eventsAbort = new AbortController();
let createdSessionId: string | null = null;
const seenEvents: string[] = [];
let pluginHost: ConnectPluginHost | null = null;

try {
  const eventReceived = (async (): Promise<string> => {
    for await (const event of client.events(eventsAbort.signal)) {
      seenEvents.push(`${event.directory}:${event.payload.type}`);
      if (event.directory === directory && event.payload.type === "session.created")
        return event.payload.properties.info.id;
    }
    throw new Error("OpenCode global event stream ended before session.created");
  })();
  await Bun.sleep(500);
  const [agents, providers] = await within(
    Promise.all([client.listAgents(directory), client.listProviders(directory)]),
    "capability discovery",
  );
  if (!Array.isArray(agents) || !Array.isArray(providers.all))
    throw new Error("OpenCode capability discovery returned an incompatible shape");
  if (!agents.some((agent) => !agent.hidden && (agent.mode === "primary" || agent.mode === "all")))
    throw new Error("OpenCode capability discovery returned no primary agent");
  const connectedProviders = providers.all.filter((provider) => providers.connected.includes(provider.id));
  const discoveredModels = connectedProviders.flatMap((provider) =>
    Object.values(provider.models).map((model) => ({
      id: `${provider.id}/${model.id}`,
      variants: Object.keys(model.variants ?? {}),
    })),
  );
  if (discoveredModels.length === 0)
    throw new Error("OpenCode capability discovery returned no provider-qualified model");
  if (!discoveredModels.some((model) => model.variants.length > 0))
    throw new Error("OpenCode capability discovery returned no model variant");

  const session = await within(client.createSession(directory, "ClawChat Connect integration"), "Session creation");
  createdSessionId = session.id;
  if (
    !(await within(client.listSessions(directory), "Session listing")).some((candidate) => candidate.id === session.id)
  )
    throw new Error("Created OpenCode Session was not discoverable");
  const readSession = await within(client.getSession(session.id, directory), "Session read");
  if (readSession.id !== session.id || (await realpath(readSession.directory)) !== directory)
    throw new Error("OpenCode Session read did not preserve its identity and directory");
  if ((await within(client.messages(session.id, directory), "message history")).length !== 0)
    throw new Error("New OpenCode Session unexpectedly contained messages");
  const eventSessionId = await Promise.race([
    eventReceived,
    Bun.sleep(5_000).then(() => {
      throw new Error(`Timed out waiting for OpenCode session.created; saw ${seenEvents.join(", ") || "no events"}`);
    }),
  ]);
  if (eventSessionId !== session.id) throw new Error("OpenCode global event belonged to a different Session");
  const configPath = join(directory, ".connect-integration.json");
  const bundlePath = join(directory, "opencode.connect-plugin");
  const binding = createAgentBinding({
    pluginId: OPENCODE_OFFICIAL_PLUGIN_ID,
    capabilityId: OPENCODE_OFFICIAL_CAPABILITY_ID,
    configuration: { executablePathOverride: executable },
  });
  const config = defaultConfig();
  config.agents = { opencode: binding };
  config.defaultAgent = "opencode";
  await saveConfig(config, configPath);
  const built = await buildOfficialPlugin(descriptor, { write: false });
  await writeFile(bundlePath, `${JSON.stringify(built.bundle)}\n`);
  const registry = new RuntimeAdapterRegistry([]);
  pluginHost = new ConnectPluginHost(configPath, registry, () => undefined);
  await within(pluginHost.install({ source: `local:${bundlePath}` }), "official Plugin installation");
  await within(registry.prepare(binding), "Plugin Binding preparation");
  const workspace = { projectId: "integration", workingDirectory: directory, skipGitRepoCheck: true };
  const [pluginOptions, pluginModels, pluginSkills, pluginCommands, pluginThreads] = await within(
    Promise.all([
      registry.listSessionOptions(binding, workspace),
      registry.listModels(binding),
      registry.listSkills(binding, workspace),
      registry.listCommands(binding, workspace),
      registry.discoverThreads(binding, workspace),
    ]),
    "Plugin capability discovery",
  );
  if (!pluginOptions?.some((option) => option.id === "agent"))
    throw new Error("Official OpenCode Plugin did not preserve Agent discovery");
  if (
    !pluginOptions.some((option) => option.id === "model") ||
    !pluginOptions.some((option) => option.id === "variant")
  )
    throw new Error("Official OpenCode Plugin did not preserve provider-qualified models and variants");
  if (!pluginModels?.length) throw new Error("Official OpenCode Plugin returned no models");
  if (!Array.isArray(pluginSkills) || !Array.isArray(pluginCommands))
    throw new Error("Official OpenCode Plugin did not preserve Runtime Skill and Command catalogs");
  if (!pluginThreads.some((thread) => thread.runtimeThreadId === session.id))
    throw new Error("Official OpenCode Plugin did not discover the native Session");
  const activity = await within(registry.readActivity(binding, session.id), "Plugin native Session activity");
  if (
    activity.completeness !== "partial" ||
    activity.limitations.length !== 1 ||
    activity.limitations[0] !== "correlation" ||
    activity.activities.length !== 0
  )
    throw new Error("Official OpenCode Plugin did not preserve the empty native transcript and its correlation limit");
  await within(registry.deleteThread(binding, session.id), "Plugin native Session deletion");
  if ((await within(client.listSessions(directory), "post-Plugin Session listing")).some(({ id }) => id === session.id))
    throw new Error("Official OpenCode Plugin did not delete the native Session");
  createdSessionId = null;
  await pluginHost.close();
  pluginHost = null;
  process.stdout.write(`OpenCode ${client.version} installed official Runtime Plugin integration passed\n`);
} finally {
  eventsAbort.abort();
  if (createdSessionId)
    await within(client.deleteSession(createdSessionId, directory), "cleanup Session deletion").catch(() => false);
  await pluginHost?.close().catch(() => undefined);
  await client.close();
  await rm(directory, { recursive: true, force: true });
}

async function within<T>(operation: Promise<T>, label: string, timeoutMs = 10_000): Promise<T> {
  return await Promise.race([
    operation,
    Bun.sleep(timeoutMs).then(() => {
      throw new Error(`Timed out during OpenCode ${label}`);
    }),
  ]);
}
