import { expect, it } from "bun:test";
import { RuntimeInteractionSettlement } from "../src/runtime/runtime-interaction-settlement";

it("allows only the first valid Runtime Interaction response to claim native delivery", async () => {
  let releaseDelivery: () => void = () => {};
  const delivered: string[] = [];
  const settlement = new RuntimeInteractionSettlement<string>({
    validate: (candidate) => {
      if (!candidate.startsWith("valid:")) throw new Error("invalid");
      return candidate.slice("valid:".length);
    },
  });

  await expect(settlement.claim("invalid", async () => {})).rejects.toThrow("invalid");
  const first = settlement.claim("valid:first", async (response) => {
    delivered.push(response);
    await new Promise<void>((resolve) => {
      releaseDelivery = resolve;
    });
  });
  const second = settlement.claim("valid:second", async (response) => {
    delivered.push(response);
  });

  await expect(second).resolves.toBe(false);
  expect(settlement.expire()).toBe(false);
  releaseDelivery();
  await expect(first).resolves.toBe(true);
  expect(delivered).toEqual(["first"]);
  expect(settlement.terminalState()).toBe("resolved");
});

it("ends a claimed Runtime Interaction as failed when native delivery rejects", async () => {
  const settlement = new RuntimeInteractionSettlement<string>({ validate: (candidate) => candidate });

  await expect(
    settlement.claim("answer", async () => {
      throw new Error("native delivery failed");
    }),
  ).rejects.toThrow("native delivery failed");

  expect(settlement.terminalState()).toBe("failed");
  await expect(settlement.claim("retry", async () => {})).resolves.toBe(false);
});
