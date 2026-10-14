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

  test("base family ids resolve to default catalog variant", () => {
    expect(resolveAgyModelSpec("gemini-4-argon")).toEqual({ model: "gemini-4-argon-high" });
    expect(resolveAgyModelSpec("gemini-3.8-flash")).toEqual({ model: "gemini-3.8-flash-high" });
    expect(resolveAgyModelSpec("claude-opus-5-5")).toEqual({ model: "claude-opus-5-5-high" });
    expect(resolveAgyModelSpec("claude-sonnet-5-5")).toEqual({ model: "claude-sonnet-5-5-high" });
    expect(resolveAgyModelSpec("gpt-oss-120b")).toEqual({ model: "gpt-oss-120b-medium" });
  });

  test("base family ids combine with per-call effort variant (ctrl+t)", () => {
    expect(resolveAgyModelSpec("gemini-4-argon", { effort: "low" })).toEqual({ model: "gemini-4-argon-low" });
    expect(resolveAgyModelSpec("gemini-4-argon", { effort: "medium" })).toEqual({ model: "gemini-4-argon-medium" });
    expect(resolveAgyModelSpec("claude-sonnet-5.5", { effort: "low" })).toEqual({ model: "claude-sonnet-5-5-low" });
  });

  test("per-call effort switches variant even when modelId already has a suffix", () => {
    expect(resolveAgyModelSpec("gemini-4-argon-high", { effort: "low" })).toEqual({ model: "gemini-4-argon-low" });
    expect(resolveAgyModelSpec("claude-opus-5-5-low", { effort: "medium" })).toEqual({ model: "claude-opus-5-5-medium" });
  });

  test("defaultEffort applies to base family ids without overriding explicit suffix", () => {
    expect(resolveAgyModelSpec("gemini-4-argon", { defaultEffort: "medium" })).toEqual({ model: "gemini-4-argon-medium" });
    expect(resolveAgyModelSpec("gemini-4-argon-low", { defaultEffort: "high" })).toEqual({ model: "gemini-4-argon-low" });
  });

  test("non-catalog effort levels (e.g. max/xhigh) pass through as --effort", () => {
    expect(resolveAgyModelSpec("gemini-4-argon", { effort: "max" })).toEqual({
      model: "gemini-4-argon-high",
      effort: "max",
    });
  });
});

describe("model names", () => {
  test("names mirror agy models and base families", () => {
    expect(getModelName("claude-sonnet-5-5-medium")).toBe("Claude Sonnet 5.5 (Medium)");
    expect(getModelName("claude-opus-5.5-low")).toBe("Claude Opus 5.5 (Low)");
    expect(getModelName("gemini-4-argon")).toBe("Gemini 4 Argon");
    expect(getModelName("claude-sonnet-5.5")).toBe("Claude Sonnet 5.5");
    expect(isKnownModel("gemini-3.1-pro")).toBe(true);
    expect(isKnownModel("gemini-4-argon")).toBe(true);
    expect(isKnownModel("nope")).toBe(false);
  });
});