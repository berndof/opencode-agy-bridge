import { describe, test, expect } from "bun:test";
import { resolveAgyModelSpec, getModelName, isKnownModel } from "../src/models";

describe("resolveAgyModelSpec", () => {
  test("cosmetic id falls back to defaultModel", () => {
    expect(resolveAgyModelSpec("antigravity", "gemini-4-argon-high")).toEqual({ model: "gemini-4-argon-high" });
  });

  test("cosmetic id falls back to built-in default", () => {
    expect(resolveAgyModelSpec("antigravity")).toEqual({ model: "gemini-3.8-flash-high" });
  });

  test("catalog ids pass through verbatim (variant is part of the id)", () => {
    expect(resolveAgyModelSpec("gemini-3.8-flash-medium")).toEqual({ model: "gemini-3.8-flash-medium" });
    expect(resolveAgyModelSpec("claude-opus-5-5-high")).toEqual({ model: "claude-opus-5-5-high" });
    expect(resolveAgyModelSpec("gpt-oss-120b-medium")).toEqual({ model: "gpt-oss-120b-medium" });
  });

  test("legacy dotted claude ids map to agy ids", () => {
    expect(resolveAgyModelSpec("claude-sonnet-5.5-high")).toEqual({ model: "claude-sonnet-5-5-high" });
  });

  test("legacy gemini-3.1-pro maps to gemini-4-argon-high", () => {
    expect(resolveAgyModelSpec("gemini-3.1-pro")).toEqual({ model: "gemini-4-argon-high" });
  });

  test("defaultModel may itself be a legacy id", () => {
    expect(resolveAgyModelSpec("antigravity", "gemini-3.6-flash-low")).toEqual({ model: "gemini-3.8-flash-low" });
  });

  test("unknown model passes through", () => {
    expect(resolveAgyModelSpec("custom-external-model")).toEqual({ model: "custom-external-model" });
  });
});

describe("model names", () => {
  test("names mirror agy models", () => {
    expect(getModelName("claude-sonnet-5-5-medium")).toBe("Claude Sonnet 5.5 (Medium)");
    expect(getModelName("claude-opus-5.5-low")).toBe("Claude Opus 5.5 (Low)");
    expect(isKnownModel("gemini-3.1-pro")).toBe(true);
    expect(isKnownModel("nope")).toBe(false);
  });
});