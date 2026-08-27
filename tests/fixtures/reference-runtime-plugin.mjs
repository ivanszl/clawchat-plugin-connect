class ReferenceRuntimeAdapter {
  modes = ["trace"];
  activities = new Map();
  closed = false;
  nextThread = 1;

  constructor(instance, contextKeys) {
    this.instance = instance;
    this.contextKeys = contextKeys;
  }

  async start(startContext) {
    if (this.closed) throw new Error(`Reference Runtime ${this.instance} is closed`);
    const runtimeThreadId =
      startContext.runtimeThreadId ?? `${this.instance}-${startContext.bindingId}-thread-${this.nextThread++}`;
    if (!startContext.runtimeThreadId) await startContext.onRuntimeThreadId(runtimeThreadId);
    return {
      prompt: async function* (input) {
        await input.onAccepted?.();
        const activity = {
          id: `${runtimeThreadId}:assistant:0`,
          position: "0.0",
          parentId: null,
          kind: "assistant",
          text: `${this.instance}:${input.prompt}`,
          state: "complete",
          source: "live",
          data: { contextKeys: this.contextKeys, instance: this.instance },
        };
        this.activities.set(runtimeThreadId, [activity]);
        yield activity;
      }.bind(this),
      async close() {},
    };
  }

  async readActivity(runtimeThreadId) {
    return {
      activities: this.activities.get(runtimeThreadId) ?? [],
      completeness: "complete",
      limitations: [],
    };
  }

  async discoverAllThreads() {
    return {
      status: "complete",
      threads: [...this.activities.keys()].map((runtimeThreadId) => ({
        runtimeThreadId,
        name: `${this.instance} thread`,
        updatedAt: 1,
        adoption: { status: "available" },
      })),
      limitations: [],
    };
  }

  async close() {
    await Promise.resolve();
    this.closed = true;
  }
}

class ReferenceRuntimeProvider {
  capabilityId = "reference-runtime";
  family = "reference";

  constructor(contextKeys) {
    this.contextKeys = contextKeys;
  }

  create(configuration) {
    return new ReferenceRuntimeAdapter(String(configuration.instance ?? "reference"), this.contextKeys);
  }
}

class ReferenceExposureProvider {
  capabilityId = "reference-exposure";
  defaultChannel = "private";

  async activate(activation) {
    const { configuration } = activation;
    const effects = (globalThis.__connectReferenceExposureEffects ??= []);
    effects.push(`activate:${String(configuration.channel ?? this.defaultChannel)}`);
    globalThis.__connectReferenceExposure = Object.freeze({
      activationKeys: Object.keys(activation).sort(),
      activationFrozen: Object.isFrozen(activation),
      configurationFrozen: Object.isFrozen(configuration),
    });
    return () => {
      effects.push("dispose");
      Reflect.deleteProperty(globalThis, "__connectReferenceExposure");
    };
  }
}

class ReferencePlugin {
  async activate(context) {
    const contextKeys = Object.keys(context).sort();
    context.hostCapabilities.get("runtime-provider").register(new ReferenceRuntimeProvider(contextKeys));
    context.hostCapabilities.get("exposure-provider").register(new ReferenceExposureProvider());
  }
}

export default new ReferencePlugin();
