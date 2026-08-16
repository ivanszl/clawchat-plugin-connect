export type BindingRuntimeRetirement = (bindingIds: readonly string[]) => Promise<void>;
export interface BindingRuntimeRetirementSurface {
  retireBindings(bindingIds: readonly string[]): Promise<void>;
}

export async function retireBindingRuntimeSurfaces(
  bindingIds: readonly string[],
  surfaces: readonly BindingRuntimeRetirementSurface[],
): Promise<void> {
  const uniqueBindingIds = [...new Set(bindingIds)].sort();
  for (const surface of surfaces) {
    await surface.retireBindings(uniqueBindingIds);
  }
}

export interface BindingRuntimeLifecycle {
  retireBindings(bindingIds: readonly string[]): Promise<void>;
  attachRetirement(retirement: BindingRuntimeRetirement): () => void;
}

export function createBindingRuntimeLifecycle(): BindingRuntimeLifecycle {
  let activeRetirement: BindingRuntimeRetirement | undefined;

  return {
    retireBindings: async (bindingIds) => {
      if (bindingIds.length === 0) return;
      if (!activeRetirement) {
        throw new Error("Agent Binding transport retirement is unavailable");
      }
      await activeRetirement(bindingIds);
    },
    attachRetirement: (retirement) => {
      if (activeRetirement) throw new Error("Agent Binding transport retirement is already attached");
      activeRetirement = retirement;
      let attached = true;
      return () => {
        if (!attached) return;
        attached = false;
        if (activeRetirement === retirement) activeRetirement = undefined;
      };
    },
  };
}
