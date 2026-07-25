import { describe, expect, it } from "bun:test";
import { transcriptQueryOptions } from "../web/src/client-interface/query-options";

describe("Connect Client event fallback", () => {
  it("polls the visible transcript when EventSource is unavailable through an exposure", () => {
    expect(transcriptQueryOptions("NKEP79B8").refetchInterval).toBe(2_000);
  });
});
