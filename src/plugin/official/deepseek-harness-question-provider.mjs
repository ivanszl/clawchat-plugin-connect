export function registerQuestionProviderWhenProfileReady(ctx, provider) {
  let resolveReady;
  let rejectReady;
  let settled = false;
  let disposed = false;
  const ready = new Promise((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });
  const settle = (available) => {
    if (settled) return;
    settled = true;
    resolveReady(available);
  };
  const registration = ctx.inject({ loader: { await: true } }, () => {
    if (disposed) {
      settle(false);
      return undefined;
    }
    try {
      const off = registerQuestionProvider(ctx.root.get("userQuestions"), provider);
      settle(Boolean(off));
      return off;
    } catch (error) {
      if (!settled) {
        settled = true;
        rejectReady(error);
      }
      throw error;
    }
  });
  return {
    ready,
    async dispose() {
      disposed = true;
      try {
        await registration.dispose();
      } finally {
        settle(false);
      }
    },
  };
}

function registerQuestionProvider(service, provider) {
  if (!service) return undefined;
  try {
    return service.registerProvider(provider);
  } catch (error) {
    if (error?.code === "DUPLICATE_PROVIDER") return undefined;
    throw error;
  }
}
