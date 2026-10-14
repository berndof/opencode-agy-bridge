import { describe, test, expect } from "bun:test";
import { toV3Usage } from "../src/provider";

describe("toV3Usage", () => {
  test("maps agy thinking/cache tokens into V3 usage", () => {
    // Real agy numbers: output_tokens already includes thinking_tokens.
    const u = toV3Usage({
      inputTokens: 11841,
      outputTokens: 595,
      totalTokens: 12436,
      thinkingTokens: 476,
      cacheReadTokens: 2000,
    });
    expect(u.inputTokens).toEqual({ total: 11841, noCache: 9841, cacheRead: 2000, cacheWrite: undefined });
    expect(u.outputTokens).toEqual({ total: 595, text: 119, reasoning: 476 });
    expect(u.raw?.thinking_tokens).toBe(476);
  });

  test("null usage yields all-undefined V3 usage", () => {
    const u = toV3Usage(null);
    expect(u.inputTokens.total).toBeUndefined();
    expect(u.outputTokens.reasoning).toBeUndefined();
  });
});
