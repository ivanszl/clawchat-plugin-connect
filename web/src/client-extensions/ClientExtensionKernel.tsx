import * as Astryx from "@astryxdesign/core";
import * as React from "react";
import {
  Component,
  createContext,
  type ErrorInfo,
  type ReactNode,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useSyncExternalStore,
} from "react";
import {
  type BindingPreferenceView,
  CLIENT_API_PREFIX,
  type ClientExtensionGraphView,
  type ClientExtensionView,
  type UpdateBindingPreferencesRequest,
} from "../../../src/client-contract";
import {
  CONNECT_CLIENT_EXTENSION_SLOT_CATALOG,
  type ConnectPluginClientExtensionComponent,
  type ConnectPluginClientExtensionContext,
  type ConnectPluginClientExtensionEntry,
  type ConnectPluginClientExtensionSlotId,
  type ConnectPluginDisposer,
} from "../../../src/plugin/sdk";
import { clientFetch, requestId } from "../client-interface/http";

interface SlotContribution {
  readonly key: string;
  readonly priority: number;
  readonly component: ConnectPluginClientExtensionComponent;
}

interface ActiveGraph {
  readonly epoch: string;
  dispose(): Promise<void>;
}

class SlotRegistry {
  private epoch = "";
  private revision = 0;
  private readonly listeners = new Set<() => void>();
  private readonly contributions = new Map<string, SlotContribution[]>();
  private batchDepth = 0;
  private batchChanged = false;

  replace(epoch: string): void {
    this.epoch = epoch;
    this.contributions.clear();
    this.emit();
  }

  register(epoch: string, slotId: string, contribution: SlotContribution): ConnectPluginDisposer {
    if (epoch !== this.epoch) throw new Error("stale Client Extension graph epoch");
    const existing = this.contributions.get(slotId) ?? [];
    const next = [...existing.filter((candidate) => candidate.key !== contribution.key), contribution].sort(
      (left, right) => left.priority - right.priority || left.key.localeCompare(right.key),
    );
    this.contributions.set(slotId, next);
    this.changed();
    return () => {
      if (epoch !== this.epoch) return;
      const current = this.contributions.get(slotId) ?? [];
      this.contributions.set(
        slotId,
        current.filter((candidate) => candidate.key !== contribution.key),
      );
      this.changed();
    };
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  snapshot = (): number => this.revision;

  list(slotId: string): readonly SlotContribution[] {
    return this.contributions.get(slotId) ?? [];
  }

  beginBatch(): void {
    this.batchDepth += 1;
  }

  endBatch(): void {
    if (this.batchDepth === 0) throw new Error("Client Extension slot registry batch is not active");
    this.batchDepth -= 1;
    if (this.batchDepth === 0 && this.batchChanged) {
      this.batchChanged = false;
      this.emit();
    }
  }

  private changed(): void {
    if (this.batchDepth > 0) {
      this.batchChanged = true;
      return;
    }
    this.emit();
  }

  private emit(): void {
    this.revision += 1;
    for (const listener of this.listeners) listener();
  }
}

const SlotRegistryContext = createContext(new SlotRegistry());

export function ClientExtensionKernel({ graph, children }: { graph: ClientExtensionGraphView; children: ReactNode }) {
  const registry = useMemo(() => new SlotRegistry(), []);
  const activeGraph = useRef<ActiveGraph | null>(null);
  const requestedEpoch = useRef(graph.epoch);
  const replacement = useRef(Promise.resolve());
  requestedEpoch.current = graph.epoch;

  useEffect(() => {
    replacement.current = replacement.current.then(async () => {
      if (activeGraph.current?.epoch === graph.epoch) return;
      const replaced = activeGraph.current;
      if (replaced) {
        try {
          await replaced.dispose();
        } catch {
          window.location.reload();
          return;
        }
        if (activeGraph.current === replaced) activeGraph.current = null;
      }
      registry.replace(graph.epoch);
      try {
        const activated = await activateGraph(graph, registry);
        if (requestedEpoch.current !== graph.epoch) {
          await activated.dispose();
          return;
        }
        activeGraph.current = activated;
      } catch (error) {
        console.error("Client Extension graph activation failed", error);
        if (replaced) window.location.reload();
      }
    });
  }, [graph, registry]);

  useEffect(
    () => () => {
      void activeGraph.current?.dispose();
      activeGraph.current = null;
      registry.replace("");
    },
    [registry],
  );

  return (
    <SlotRegistryContext.Provider value={registry}>
      {children}
      <ClientExtensionSlot id="kernel.root.after" />
    </SlotRegistryContext.Provider>
  );
}

export function ClientExtensionSlot({
  id,
  fallback = null,
}: {
  id: ConnectPluginClientExtensionSlotId;
  fallback?: ReactNode;
}) {
  const registry = useContext(SlotRegistryContext);
  useSyncExternalStore(registry.subscribe, registry.snapshot, registry.snapshot);
  return <SlotSurvivors contributions={registry.list(id)} index={0} fallback={fallback} />;
}

function SlotSurvivors({
  contributions,
  index,
  fallback,
}: {
  contributions: readonly SlotContribution[];
  index: number;
  fallback: ReactNode;
}) {
  const contribution = contributions[index];
  if (!contribution) return fallback;
  const ExtensionComponent = contribution.component;
  return (
    <RenderBoundary
      key={contribution.key}
      fallback={<SlotSurvivors contributions={contributions} index={index + 1} fallback={fallback} />}
    >
      <ExtensionComponent />
    </RenderBoundary>
  );
}

class RenderBoundary extends Component<{ children: ReactNode; fallback: ReactNode }, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error("Client Extension slot render failed", error, info);
  }

  render(): ReactNode {
    return this.state.failed ? this.props.fallback : this.props.children;
  }
}

async function activateGraph(graph: ClientExtensionGraphView, registry: SlotRegistry): Promise<ActiveGraph> {
  const graphDisposers: ConnectPluginDisposer[] = [];
  registry.beginBatch();
  try {
    for (const extension of graph.extensions) {
      graphDisposers.push(await activateExtension(graph.epoch, extension, registry));
    }
  } catch (error) {
    try {
      await disposeReverse(graphDisposers);
    } finally {
      registry.endBatch();
    }
    throw error;
  }
  registry.endBatch();
  return {
    epoch: graph.epoch,
    dispose: async () => await disposeReverse(graphDisposers),
  };
}

async function activateExtension(
  epoch: string,
  extension: ClientExtensionView,
  registry: SlotRegistry,
): Promise<ConnectPluginDisposer> {
  const disposers: ConnectPluginDisposer[] = [];
  const declaredSlots = new Map(extension.slots.map((slot) => [slot.id, slot]));
  const context: ConnectPluginClientExtensionContext = Object.freeze({
    epoch,
    configuration: Object.freeze(structuredClone(extension.configuration)),
    Astryx,
    React,
    slots: Object.freeze({
      register: (slotId: ConnectPluginClientExtensionSlotId, component: ConnectPluginClientExtensionComponent) => {
        if (!Object.hasOwn(CONNECT_CLIENT_EXTENSION_SLOT_CATALOG, slotId)) {
          throw new Error(`${extension.pluginId}/${extension.capabilityId} registered unsupported slot ${slotId}`);
        }
        const slot = declaredSlots.get(slotId);
        if (!slot)
          throw new Error(`${extension.pluginId}/${extension.capabilityId} registered undeclared slot ${slotId}`);
        const dispose = registry.register(epoch, slotId, {
          key: `${extension.pluginId}/${extension.capabilityId}`,
          priority: slot.priority,
          component,
        });
        disposers.push(dispose);
        return dispose;
      },
    }),
    effects: createEffectScope(disposers),
    client: Object.freeze({
      bindingPreferences: Object.freeze({
        update: async (
          bindingId: string,
          updates: Omit<UpdateBindingPreferencesRequest, "requestId" | "clientExtensionEpoch">,
        ) =>
          await clientFetch<BindingPreferenceView>(
            `${CLIENT_API_PREFIX}/bindings/${encodeURIComponent(bindingId)}/preferences`,
            {
              method: "PATCH",
              body: JSON.stringify({
                requestId: requestId(),
                clientExtensionEpoch: epoch,
                ...updates,
              }),
            },
          ),
      }),
    }),
  });

  try {
    for (const style of extension.styles) {
      const css = await fetchIntegrityCheckedText(style.href, style.integrity);
      const element = document.createElement("style");
      element.dataset.clientExtension = `${extension.pluginId}/${extension.capabilityId}`;
      element.textContent = css;
      document.head.append(element);
      disposers.push(() => element.remove());
    }
    const source = await fetchIntegrityCheckedText(extension.entry, extension.integrity);
    const moduleUrl = URL.createObjectURL(new Blob([source], { type: "text/javascript" }));
    let module: Partial<ConnectPluginClientExtensionEntry>;
    try {
      // Import the bytes Core just verified. A second network import would reopen a time-of-check/time-of-use gap.
      module = (await import(/* @vite-ignore */ moduleUrl)) as Partial<ConnectPluginClientExtensionEntry>;
    } finally {
      URL.revokeObjectURL(moduleUrl);
    }
    if (typeof module.activate !== "function") {
      throw new Error(`${extension.pluginId}/${extension.capabilityId} browser artifact must export activate()`);
    }
    const pluginDisposer = await module.activate(context);
    if (pluginDisposer) disposers.push(pluginDisposer);
    return async () => await disposeReverse(disposers);
  } catch (error) {
    await disposeReverse(disposers);
    throw error;
  }
}

function createEffectScope(disposers: ConnectPluginDisposer[]): ConnectPluginClientExtensionContext["effects"] {
  return Object.freeze({
    add: (disposer: ConnectPluginDisposer) => {
      disposers.push(disposer);
      return disposer;
    },
    setTimeout: (callback: () => void, delay: number) => {
      const timer = window.setTimeout(callback, delay);
      const dispose = () => window.clearTimeout(timer);
      disposers.push(dispose);
      return dispose;
    },
    setInterval: (callback: () => void, delay: number) => {
      const timer = window.setInterval(callback, delay);
      const dispose = () => window.clearInterval(timer);
      disposers.push(dispose);
      return dispose;
    },
  });
}

async function fetchIntegrityCheckedText(url: string, expectedIntegrity: string): Promise<string> {
  const response = await fetch(url, { credentials: "same-origin", cache: "no-store" });
  if (!response.ok) throw new Error(`Client Extension artifact ${url} returned HTTP ${response.status}`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  const actual = `sha256-${arrayBufferToBase64(await crypto.subtle.digest("SHA-256", bytes))}`;
  if (actual !== expectedIntegrity) throw new Error(`Client Extension artifact ${url} failed integrity verification`);
  return new TextDecoder().decode(bytes);
}

function arrayBufferToBase64(bytes: ArrayBuffer): string {
  let binary = "";
  for (const byte of new Uint8Array(bytes)) binary += String.fromCharCode(byte);
  return btoa(binary);
}

async function disposeReverse(disposers: readonly ConnectPluginDisposer[]): Promise<void> {
  const errors: unknown[] = [];
  for (const dispose of [...disposers].reverse()) {
    try {
      await dispose();
    } catch (error) {
      errors.push(error);
    }
  }
  if (errors.length > 0) throw new AggregateError(errors, "Client Extension graph disposal failed");
}
