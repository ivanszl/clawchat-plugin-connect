export default {
  async activate(context) {
    const contextKeys = Object.keys(context).sort();
    const runtimeProviders = context.hostCapabilities.get("runtime-provider");
    const exposureProviders = context.hostCapabilities.get("exposure-provider");
    runtimeProviders.register({
      capabilityId: "reference-runtime",
      family: "reference",
      create(configuration) {
        const instance = String(configuration.instance ?? "reference");
        const activities = new Map();
        let closed = false;
        let nextThread = 1;
        return {
          modes: ["trace"],
          async start(startContext) {
            if (closed) throw new Error(`Reference Runtime ${instance} is closed`);
            const runtimeThreadId =
              startContext.runtimeThreadId ?? `${instance}-${startContext.agentId}-thread-${nextThread++}`;
            if (!startContext.runtimeThreadId) await startContext.onRuntimeThreadId(runtimeThreadId);
            return {
              async *prompt(input) {
                await input.onAccepted?.();
                const activity = {
                  id: `${runtimeThreadId}:assistant:0`,
                  position: "0.0",
                  parentId: null,
                  kind: "assistant",
                  text: `${instance}:${input.prompt}`,
                  state: "complete",
                  source: "live",
                  data: { contextKeys, instance },
                };
                activities.set(runtimeThreadId, [activity]);
                yield activity;
              },
              async close() {},
            };
          },
          async readActivity(runtimeThreadId) {
            return {
              activities: activities.get(runtimeThreadId) ?? [],
              completeness: "complete",
              limitations: [],
            };
          },
          async discoverAllThreads() {
            return [...activities.keys()].map((runtimeThreadId) => ({
              runtimeThreadId,
              name: `${instance} thread`,
              updatedAt: 1,
            }));
          },
          async close() {
            await Promise.resolve();
            closed = true;
          },
        };
      },
    });
    exposureProviders.register({
      capabilityId: "reference-exposure",
      async activate(configuration) {
        const effects = (globalThis.__connectReferenceExposureEffects ??= []);
        effects.push(`activate:${String(configuration.channel ?? "private")}`);
        return () => effects.push("dispose");
      },
    });
  },
};
