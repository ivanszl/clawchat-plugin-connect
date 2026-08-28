import { describe, expect, it } from "bun:test";
import { registerQuestionProviderWhenProfileReady } from "../src/plugin/official/deepseek-harness-question-provider.mjs";

class QuestionService {
  provider;

  registerProvider(provider) {
    if (this.provider) {
      const error = new Error("a user-questions provider is already registered");
      error.code = "DUPLICATE_PROVIDER";
      throw error;
    }
    this.provider = provider;
    return () => {
      if (this.provider === provider) this.provider = undefined;
    };
  }
}

function profileContext(service) {
  let activate;
  let cleanup;
  return {
    ctx: {
      root: { get: (name) => (name === "userQuestions" ? service : undefined) },
      inject(dependencies, callback) {
        expect(dependencies).toEqual({ loader: { await: true } });
        activate = async () => {
          cleanup = await callback(this);
        };
        return {
          async dispose() {
            await cleanup?.();
          },
        };
      },
    },
    async settleProfile() {
      await activate?.();
    },
  };
}

describe("DeepSeek Harness question provider arbitration", () => {
  it("leaves a native provider authoritative when it registers during Profile loading", async () => {
    const service = new QuestionService();
    const profile = profileContext(service);
    const connectProvider = { ask: async () => ({ answers: [] }) };
    const registration = registerQuestionProviderWhenProfileReady(profile.ctx, connectProvider);
    const nativeProvider = { ask: async () => ({ answers: [] }) };

    const offNative = service.registerProvider(nativeProvider);
    await profile.settleProfile();

    await expect(registration.ready).resolves.toBe(false);
    expect(service.provider).toBe(nativeProvider);
    await registration.dispose();
    expect(service.provider).toBe(nativeProvider);
    offNative();
  });

  it("registers Connect only after a Profile settles with a free slot", async () => {
    const service = new QuestionService();
    const profile = profileContext(service);
    const connectProvider = { ask: async () => ({ answers: [] }) };
    const registration = registerQuestionProviderWhenProfileReady(profile.ctx, connectProvider);

    expect(service.provider).toBeUndefined();
    await profile.settleProfile();

    await expect(registration.ready).resolves.toBe(true);
    expect(service.provider).toBe(connectProvider);
    await registration.dispose();
    expect(service.provider).toBeUndefined();
  });
});
