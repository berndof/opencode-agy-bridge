/**
 * Known Antigravity/Gemini and Claude models supported by the agy CLI.
 * Verified dynamically against the running agy CLI binary.
 */

export interface KnownModel {
  /** The model ID exposed to OpenCode (e.g. "gemini-3.8-flash-high") */
  id: string;
  /** Friendly display name in OpenCode */
  name: string;
  /** The actual --model argument passed to the agy CLI */
  agyModel: string;
  /** The optional --effort argument passed to the agy CLI ("low" | "medium" | "high") */
  agyEffort?: string;
  /** Model family for grouping in UI */
  family?: string;
}

export const KNOWN_AGY_MODELS: readonly KnownModel[] = [
  // Gemini 3.8 Flash series
  {
    id: "gemini-3.8-flash-high",
    name: "Gemini 3.8 Flash (High)",
    agyModel: "gemini-3.8-flash",
    agyEffort: "high",
    family: "gemini-3.8",
  },
  {
    id: "gemini-3.8-flash-low",
    name: "Gemini 3.8 Flash (Low)",
    agyModel: "gemini-3.8-flash",
    agyEffort: "low",
    family: "gemini-3.8",
  },

  // Gemini 4 Argon series (Latest Deep Reasoning)
  {
    id: "gemini-4-argon-high",
    name: "Gemini 4 Argon (High)",
    agyModel: "gemini-4-argon",
    agyEffort: "high",
    family: "gemini-4",
  },
  {
    id: "gemini-4-argon-low",
    name: "Gemini 4 Argon (Low)",
    agyModel: "gemini-4-argon",
    agyEffort: "low",
    family: "gemini-4",
  },

  // Claude 5.5 Sonnet series
  {
    id: "claude-sonnet-5.5-high",
    name: "Claude Sonnet 5.5 (High)",
    agyModel: "Claude Sonnet 5.5 (High)",
    family: "claude-5.5",
  },
  {
    id: "claude-sonnet-5.5-low",
    name: "Claude Sonnet 5.5 (Low)",
    agyModel: "Claude Sonnet 5.5 (Low)",
    family: "claude-5.5",
  },

  // Claude 5.5 Opus series
  {
    id: "claude-opus-5.5-high",
    name: "Claude Opus 5.5 (High)",
    agyModel: "Claude Opus 5.5 (High)",
    family: "claude-5.5",
  },
  {
    id: "claude-opus-5.5-low",
    name: "Claude Opus 5.5 (Low)",
    agyModel: "Claude Opus 5.5 (Low)",
    family: "claude-5.5",
  },

  // Compatibility aliases for older Gemini versions (mapped to modern equivalents)
  {
    id: "gemini-3.1-pro",
    name: "Gemini 3.1 Pro (→ Gemini 4 Argon High)",
    agyModel: "gemini-4-argon",
    agyEffort: "high",
    family: "gemini-4",
  },
  {
    id: "gemini-3.1-pro-high",
    name: "Gemini 3.1 Pro High (→ Gemini 4 Argon High)",
    agyModel: "gemini-4-argon",
    agyEffort: "high",
    family: "gemini-4",
  },
  {
    id: "gemini-3.1-pro-low",
    name: "Gemini 3.1 Pro Low (→ Gemini 4 Argon Low)",
    agyModel: "gemini-4-argon",
    agyEffort: "low",
    family: "gemini-4",
  },
  {
    id: "gemini-3.6-flash-high",
    name: "Gemini 3.6 Flash High (→ Gemini 3.8 Flash High)",
    agyModel: "gemini-3.8-flash",
    agyEffort: "high",
    family: "gemini-3.8",
  },
  {
    id: "gemini-3.6-flash-low",
    name: "Gemini 3.6 Flash Low (→ Gemini 3.8 Flash Low)",
    agyModel: "gemini-3.8-flash",
    agyEffort: "low",
    family: "gemini-3.8",
  },
  {
    id: "gemini-3.6-pro-high",
    name: "Gemini 3.6 Pro High (→ Gemini 4 Argon High)",
    agyModel: "gemini-4-argon",
    agyEffort: "high",
    family: "gemini-4",
  },
  {
    id: "gemini-3.6-pro-low",
    name: "Gemini 3.6 Pro Low (→ Gemini 4 Argon Low)",
    agyModel: "gemini-4-argon",
    agyEffort: "low",
    family: "gemini-4",
  },

  // Cosmetic alias
  {
    id: "antigravity",
    name: "Antigravity (Default)",
    agyModel: "gemini-3.8-flash",
    agyEffort: "high",
    family: "alias",
  },
];

/** All known model IDs for quick lookup */
export const KNOWN_MODEL_IDS = new Set(KNOWN_AGY_MODELS.map((m) => m.id));

/** Model IDs that are cosmetic aliases */
export const COSMETIC_MODEL_IDS = new Set(["antigravity"]);

/** Default model when cosmetic alias "antigravity" is used */
export const DEFAULT_AGY_MODEL = "gemini-3.8-flash-high";

export interface ResolvedAgyModelSpec {
  model: string;
  effort?: string;
}

/**
 * Resolve a model ID to the CLI model arguments (--model and optional --effort).
 */
export function resolveAgyModelSpec(modelId: string, defaultModel?: string): ResolvedAgyModelSpec {
  const targetId = COSMETIC_MODEL_IDS.has(modelId) ? (defaultModel ?? DEFAULT_AGY_MODEL) : modelId;
  const known = KNOWN_AGY_MODELS.find((m) => m.id === targetId);
  if (known) {
    return { model: known.agyModel, effort: known.agyEffort };
  }
  // Unknown model: pass as-is to agy
  return { model: targetId };
}

/** Legacy helper */
export function resolveAgyModel(modelId: string, opts: { defaultModel?: string }): string {
  return resolveAgyModelSpec(modelId, opts.defaultModel).model;
}

export function isKnownModel(modelId: string): boolean {
  return KNOWN_MODEL_IDS.has(modelId);
}

export function getModelName(modelId: string): string {
  const known = KNOWN_AGY_MODELS.find((m) => m.id === modelId);
  return known?.name ?? modelId;
}

export function getModelsByFamily(): Record<string, KnownModel[]> {
  const groups: Record<string, KnownModel[]> = {};
  for (const model of KNOWN_AGY_MODELS) {
    const family = model.family ?? "other";
    (groups[family] ??= []).push(model);
  }
  return groups;
}
