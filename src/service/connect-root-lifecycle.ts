import { Context } from "cordis";
import type { ConnectStateStore } from "../persistence/state";
import { mountMandatoryPluginHost } from "../plugin/host";
import type { RuntimeAdapterRegistry } from "../runtime/registry";
import type { ConnectConfig } from "../types";
import { mountMandatoryDurableModules } from "./connect-durable-modules";
import { mountMandatoryExecutionModules } from "./connect-execution-modules";
import {
  type ConnectSurfaceDependencies,
  type ConnectSurfaceOptions,
  type ConnectSurfaceResult,
  mountMandatorySurfaceModules,
} from "./connect-surface-modules";

interface ConnectRootLifecycleOptions {
  stateStore: ConnectStateStore;
  config: ConnectConfig;
  configPath: string;
  surfaceOptions: Omit<ConnectSurfaceOptions, "config" | "configPath">;
  surfaceDependencies: ConnectSurfaceDependencies;
  createRuntimeAdapterRegistry(): RuntimeAdapterRegistry;
  waitUntilShutdown(): Promise<void>;
  reportPluginFailure(pluginId: string, error: unknown): void;
  reportDisposalFailure(error: unknown): void;
}

/**
 * Owns the one private Cordis root and every mandatory Connect module in the
 * service process. Root-owned surface fibers are disposed before their
 * execution and durable dependencies.
 */
export async function runConnectRootLifecycle(options: ConnectRootLifecycleOptions): Promise<ConnectSurfaceResult> {
  const root = new Context();
  let disposeSurfaces: (() => Promise<void>) | undefined;

  try {
    await mountMandatoryDurableModules(root, options.stateStore, options.reportDisposalFailure);
    await mountMandatoryExecutionModules(
      root,
      options.config,
      options.createRuntimeAdapterRegistry,
      options.reportDisposalFailure,
    );
    await mountMandatoryPluginHost(root, options.configPath, options.config, options.reportPluginFailure);
    const surfaces = await mountMandatorySurfaceModules(
      root,
      {
        ...options.surfaceOptions,
        config: options.config,
        configPath: options.configPath,
      },
      options.surfaceDependencies,
      options.reportDisposalFailure,
    );
    disposeSurfaces = surfaces.dispose;
    await options.waitUntilShutdown();
    return surfaces.result;
  } finally {
    try {
      await disposeSurfaces?.();
    } catch (error) {
      options.reportDisposalFailure(error);
    }
    try {
      await root.fiber.dispose();
    } catch (error) {
      options.reportDisposalFailure(error);
    }
  }
}
