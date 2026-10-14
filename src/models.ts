/**
 * Model catalog for the agy CLI.
 *
 * IDs and names mirror `agy models` exactly, and the ID is passed verbatim to
 * `agy --model` (the effort variant is part of the ID). Keep this list in sync
 * with `agy models` when the CLI adds/removes models.
 */

export interface KnownModel {
  /** Model ID exposed to OpenCode — identical to the `agy models` ID. */
  id: string;
  /** Display name — identical to the `agy models` name. */
  name: string;
  /** Model family for grouping in UI */
  family: string;
}

export const KNOWN_AGY_MODELS: readonly KnownModel[] = [
  { id: "gemini-4-argon-high", name: "Gemini 4 Argon (High)", family: "gemini-4" },
  { id: "gemini-4-argon-medium", name: "Gemini 4 Argon (Medium)", family: "gemini-4" },
  { id: "gemini-4-argon-low", name: "Gemini 4 Argon (Low)", family: "gemini-4" },
  { id: "gemini-3.8-flash-high", name: "Gemini 3.8 Flash (High)", family: "gemini-3.8" },
  { id: "gemini-3.8-flash-medium", name: "Gemini 3.8 Flash (Medium)", family: "gemini-3.8" },
  { id: "gemini-3.8-flash-low", name: "Gemini 3.8 Flash (Low)", family: "gemini-3.8" },
  { id: "claude-opus-5-5-high", name: "Claude Opus 5.5 (High)", family: "claude-5.5" },
  { id: "claude-opus-5-5-medium", name: "Claude Opus 5.5 (Medium)", family: "claude-5.5" },
  { id: "claude-opus-5-5-low", name: "Claude Opus 5.5 (Low)", family: "claude-5.5" },
  { id: "claude-sonnet-5-5-high", name: "Claude Sonnet 5.5 (High)", family: "claude-5.5" },
  { id: "claude-sonnet-5-5-medium", name: "Claude Sonnet 5.5 (Medium)", family: "claude-5.5" },
  { id: "claude-sonnet-5-5-low", name: "Claude Sonnet 5.5 (Low)", family: "claude-5.5" },
  { id: "gpt-oss-120b-medium", name: "GPT-OSS 120B (Medium)", family: "gpt-oss" },
];

/**
 * Hidden legacy IDs (old OpenCode configs/sessions) -> current agy ID.
 * Not listed in the UI; only resolved so existing sessions keep working.
 */
export const LEGACY_MODEL_ALIASES: Readonly<Record<string, string>> = {
  "claude-sonnet-5.5-high": "claude-sonnet-5-5-high",
  "claude-sonnet-5.5-low": "claude-sonnet-5-5-low",
  "claude-opus-5.5-high": "claude-opus-5-5-high",
  "claude-opus-5.5-low": "claude-opus-5-5-low",
  "gemini-3.1-pro": "gemini-4-argon-high",
  "gemini-3.1-pro-high": "gemini-4-argon-high",
  "gemini-3.1-pro-low": "gemini-4-argon-low",
  "gemini-3.6-pro-high": "gemini-4-argon-high",
  "gemini-3.6-pro-low": "gemini-4-argon-low",
  "gemini-3.6-flash-high": "gemini-3.8-flash-high",
  "gemini-3.6-flash-low": "gemini-3.8-flash-low",
};

/** All known model IDs for quick lookup */
export const KNOWN_MODEL_IDS = new Set(KNOWN_AGY_MODELS.map((m) => m.id));

/** Model IDs that resolve to the configured defaultModel */
export const COSMETIC_MODEL_IDS = new Set(["antigravity"]);

/** Default model when cosmetic alias "antigravity" is used */
export const DEFAULT_AGY_MODEL = "gemini-3.8-flash-high";

export interface ResolvedAgyModelSpec {
  model: string;
  effort?: string;
}

/**
 * Resolve an OpenCode model ID to the agy CLI arguments. Catalog IDs pass through
 * verbatim (no separate --effort: the variant is part of the ID).
 */
export function resolveAgyModelSpec(modelId: string, defaultModel?: string): ResolvedAgyModelSpec {
  let id = COSMETIC_MODEL_IDS.has(modelId) ? (defaultModel ?? DEFAULT_AGY_MODEL) : modelId;
  id = LEGACY_MODEL_ALIASES[id] ?? id;
  return { model: id };
}

/** Legacy helper */
export function resolveAgyModel(modelId: string, opts: { defaultModel?: string }): string {
  return resolveAgyModelSpec(modelId, opts.defaultModel).model;
}

export function isKnownModel(modelId: string): boolean {
  return KNOWN_MODEL_IDS.has(LEGACY_MODEL_ALIASES[modelId] ?? modelId);
}

export function getModelName(modelId: string): string {
  const id = LEGACY_MODEL_ALIASES[modelId] ?? modelId;
  return KNOWN_AGY_MODELS.find((m) => m.id === id)?.name ?? modelId;
}

export function getModelsByFamily(): Record<string, KnownModel[]> {
  const groups: Record<string, KnownModel[]> = {};
  for (const model of KNOWN_AGY_MODELS) {
    (groups[model.family] ??= []).push(model);
  }
  return groups;
}
