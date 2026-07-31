// PROTOTYPE — answer one question:
// Can two private Liveware Exposures safely share one Connect installation by
// terminating at separate Binding-scoped HTTP gateways?

import { createServer } from "node:net";
import { createInterface } from "node:readline/promises";
import {
  assessLivewareGateways,
  authorizeScopedSession,
  type PrototypeBinding,
  type PrototypeSession,
  scopedSnapshot,
} from "./multi-account-liveware.logic.prototype";

const bindings: PrototypeBinding[] = [
  { bindingId: "personal", ownerUserId: "owner-personal" },
  { bindingId: "work", ownerUserId: "owner-work" },
];
const projects = ["shared-project", "second-project"];
const sessions: PrototypeSession[] = [
  { bindingId: "personal", sessionRef: "SAME-REF", name: "Personal Session" },
  { bindingId: "work", sessionRef: "SAME-REF", name: "Work Session" },
];

async function runScenario() {
  const ports = await Promise.all(bindings.map(async () => await availablePort()));
  const servers = bindings.map((binding, index) => {
    const port = ports[index];
    if (!port) throw new Error(`Missing gateway port for ${binding.bindingId}`);
    return Bun.serve({
      hostname: "127.0.0.1",
      port,
      fetch(request) {
        const url = new URL(request.url);
        if (url.pathname === "/client/v1/bootstrap") {
          return Response.json(scopedSnapshot(binding.bindingId, bindings, projects, sessions));
        }
        const match = url.pathname.match(/^\/client\/v1\/sessions\/([^/]+)$/u);
        if (match) {
          const requestedBinding = url.searchParams.get("binding");
          const session = sessions.find(
            (candidate) =>
              candidate.bindingId === requestedBinding && candidate.sessionRef === decodeURIComponent(match[1] ?? ""),
          );
          return authorizeScopedSession(binding.bindingId, session)
            ? Response.json(session)
            : Response.json({ code: "session-not-found" }, { status: 404 });
        }
        return Response.json({ code: "not-found" }, { status: 404 });
      },
    });
  });

  try {
    const snapshots = await Promise.all(
      servers.map(async (server) => {
        const response = await fetch(`http://127.0.0.1:${server.port}/client/v1/bootstrap`);
        return (await response.json()) as ReturnType<typeof scopedSnapshot>;
      }),
    );
    const crossBindingStatuses = await Promise.all([
      fetch(`http://127.0.0.1:${servers[0]?.port}/client/v1/sessions/SAME-REF?binding=work`).then(
        (response) => response.status,
      ),
      fetch(`http://127.0.0.1:${servers[1]?.port}/client/v1/sessions/SAME-REF?binding=personal`).then(
        (response) => response.status,
      ),
    ]);
    return assessLivewareGateways({
      snapshots,
      crossBindingStatuses,
      exposurePorts: ports,
    });
  } finally {
    await Promise.all(servers.map(async (server) => await server.stop(true)));
  }
}

async function availablePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close();
        reject(new Error("Operating system did not allocate a TCP port"));
        return;
      }
      const port = address.port;
      server.close((error) => (error ? reject(error) : resolve(port)));
    });
  });
}

function render(result: Awaited<ReturnType<typeof runScenario>>): void {
  console.clear();
  console.log("Multi-account Liveware isolation prototype\n");
  console.log(`Verdict: ${result.feasible ? "FEASIBLE" : "NOT PROVEN"}\n`);
  for (const check of result.checks) {
    console.log(`${check.passed ? "✓" : "✗"} ${check.name}`);
  }
  console.log("\nExposure gateways:");
  for (const [index, snapshot] of result.snapshots.entries()) {
    console.log(
      `- ${snapshot.bindingId}: port ${result.exposurePorts[index]}, bindings [${snapshot.bindings
        .map((binding) => binding.bindingId)
        .join(", ")}], sessions [${snapshot.sessions.map((session) => session.name).join(", ")}]`,
    );
  }
}

const result = await runScenario();
render(result);
if (process.argv.includes("--check")) {
  process.exitCode = result.feasible ? 0 : 1;
} else {
  console.log("\nPress r to rerun, q to quit.");
  const terminal = createInterface({ input: process.stdin, output: process.stdout });
  while (true) {
    const answer = (await terminal.question("> ")).trim().toLowerCase();
    if (answer === "q") break;
    if (answer === "r") render(await runScenario());
  }
  terminal.close();
}
