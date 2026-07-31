import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createOpenCodeServerClient } from "../../src/runtime/opencode-server";

const executable = process.env.OPENCODE_EXECUTABLE || Bun.which("opencode");
if (!executable) throw new Error("Set OPENCODE_EXECUTABLE or add OpenCode to PATH");

const directory = await realpath(await mkdtemp(join(tmpdir(), "clawchat-connect-opencode-integration-")));
const client = await createOpenCodeServerClient({ kind: "opencode", executablePathOverride: executable });
const eventsAbort = new AbortController();
let createdSessionId: string | null = null;
const seenEvents: string[] = [];

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
  if (!(await within(client.deleteSession(session.id, directory), "Session deletion")))
    throw new Error("OpenCode Session deletion failed");
  createdSessionId = null;
  process.stdout.write(`OpenCode ${client.version} installed-runtime integration passed\n`);
} finally {
  eventsAbort.abort();
  if (createdSessionId)
    await within(client.deleteSession(createdSessionId, directory), "cleanup Session deletion").catch(() => false);
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
