import { describe, expect, it } from "bun:test";
import { continueInClawChatHref, isClawChatLivewareContext } from "../web/src/liveware/clawchat-deep-link";

describe("ClawChat Liveware continuation", () => {
  it("recognizes both the Liveware exposure host and ClawChat container user agent", () => {
    expect(isClawChatLivewareContext("app-connect.apps.clawling.io", "Mozilla/5.0")).toBe(true);
    expect(isClawChatLivewareContext("127.0.0.1", "Mozilla/5.0 clawchat")).toBe(true);
    expect(isClawChatLivewareContext("apps.clawling.io", "Mozilla/5.0")).toBe(false);
    expect(isClawChatLivewareContext("connect.example", "Mozilla/5.0")).toBe(false);
  });

  it("builds the routed ClawChat deep link with a prefilled switch command", () => {
    expect(continueInClawChatHref("usr_agent/connect", "nkep79b8")).toBe(
      "clawchat://u/usr_agent%2Fconnect?chat=1&draft=%2Fswitch%20NKEP79B8",
    );
    expect(continueInClawChatHref(null, "NKEP79B8")).toBeNull();
  });
});
