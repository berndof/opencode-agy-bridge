import { describe, test, expect } from "bun:test";
import { resolveAgyModelSpec, DEFAULT_AGY_MODEL } from "../src/models";

describe("resolveAgyModelSpec", () => {
  test("cosmetic id falls back to defaultModel", () => {
    expect(resolveAgyModelSpec("antigravity", "gemini-4-argon-high")).toEqual({
      model: "gemini-4-argon",
      effort: "high",
    });
  });

  test("cosmetic id falls back to built-in default", () => {
    expect(resolveAgyModelSpec("antigravity")).toEqual({
      model: "gemini-3.8-flash",
      effort: "high",
    });
  });

  test("gemini-3.8-flash-high maps to gemini-3.8-flash with effort high", () => {
    expect(resolveAgyModelSpec("gemini-3.8-flash-high")).toEqual({
      model: "gemini-3.8-flash",
      effort: "high",
    });
  });

  test("gemini-4-argon-high maps to gemini-4-argon with effort high", () => {
    expect(resolveAgyModelSpec("gemini-4-argon-high")).toEqual({
      model: "gemini-4-argon",
      effort: "high",
    });
  });

  test("claude-sonnet-5.5-high maps to Claude Sonnet 5.5 (High)", () => {
    expect(resolveAgyModelSpec("claude-sonnet-5.5-high")).toEqual({
      model: "Claude Sonnet 5.5 (High)",
      effort: undefined,
    });
  });

  test("legacy gemini-3.1-pro maps to gemini-4-argon with effort high", () => {
    expect(resolveAgyModelSpec("gemini-3.1-pro")).toEqual({
      model: "gemini-4-argon",
      effort: "high",
    });
  });

  test("unknown model passes through without effort", () => {
    expect(resolveAgyModelSpec("custom-external-model")).toEqual({
      model: "custom-external-model",
      effort: undefined,
    });
  });
});