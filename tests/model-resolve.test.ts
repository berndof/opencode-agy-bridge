import { describe, test, expect } from "bun:test";
import { resolveAgyModel } from "../src/provider";

describe("resolveAgyModel", () => {
  test("cosmetic id falls back to defaultModel", () => {
    expect(resolveAgyModel("antigravity", { defaultModel: "gemini-3.7-flash-low" })).toBe(
      "gemini-3.7-flash-low",
    );
  });

  test("cosmetic id falls back to built-in default", () => {
    expect(resolveAgyModel("antigravity", {})).toBe("gemini-3.6-flash-low");
  });

  test("real model id passes through", () => {
    expect(resolveAgyModel("gemini-3.8-flash-high", { defaultModel: "gemini-3.6-flash-low" })).toBe(
      "gemini-3.8-flash-high",
    );
  });
});
