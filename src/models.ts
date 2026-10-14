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
 * Base model families (without effort suffix) for OpenCode configs that use `variants` (ctrl+t).
 * Maps family ID -> default catalog model ID when no variant/defaultEffort is selected.
 */
export const BASE_FAMILY_DEFAULTS: Readonly<Record<string, string>> = {
  "gemini-4-argon": "gemini-4-argon-high",
  "gemini-3.8-flash": "gemini-3.8-flash-high",
  "claude-opus-5-5": "claude-opus-5-5-high",
  "claude-sonnet-5-5": "claude-sonnet-5-5-high",
  "gpt-oss-120b": "gpt-oss-120b-medium",
};

export const BASE_FAMILY_NAMES: Readonly<Record<string, string>> = {
  "gemini-4-argon": "Gemini 4 Argon",
  "gemini-3.8-flash": "Gemini 3.8 Flash",
  "claude-opus-5-5": "Claude Opus 5.5",
  "claude-sonnet-5-5": "Claude Sonnet 5.5",
  "gpt-oss-120b": "GPT-OSS 120B",
};

export const LEGACY_FAMILY_ALIASES: Readonly<Record<string, string>> = {
  "claude-sonnet-5.5": "claude-sonnet-5-5",
  "claude-opus-5.5": "claude-opus-5-5",
  "gemini-3.6-pro": "gemini-4-argon",
  "gemini-3.6-flash": "gemini-3.8-flash",
};

/**
 * Hidden legacy IDs (old OpenCode configs/sessions) -> current agy ID.
 * Not listed in the UI; only resolved so existing sessions keep working.
 */
export const LEGACY_MODEL_ALIASES: Readonly<Record<string, string>> = {
  "claude-sonnet-5.5-high": "claude-sonnet-5-5-high",
  "claude-sonnet-5.5-medium": "claude-sonnet-5-5-medium",
  "claude-sonnet-5.5-low": "claude-sonnet-5-5-low",
  "claude-opus-5.5-high": "claude-opus-5-5-high",
  "claude-opus-5.5-medium": "claude-opus-5-5-medium",
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

export interface ResolveAgyModelOptions {
  defaultModel?: string;
  /** Per-call variant effort selected in OpenCode (ctrl+t / providerOptions.agy.effort). */
  effort?: string;
  /** Fallback effort when modelId is a base family id without an explicit suffix. */
  defaultEffort?: string;
}

/**
 * Resolve an OpenCode model ID (and optional variant effort from ctrl+t) to agy CLI arguments.
 *
 * - Full catalog IDs (`gemini-4-argon-high`) pass through verbatim.
 * - Base family IDs (`gemini-4-argon`) combine with `effort` or `defaultEffort` when a matching
 *   catalog ID exists (`gemini-4-argon-low`), or fall back to `BASE_FAMILY_DEFAULTS`.
 * - Explicit per-call `effort` (from OpenCode variants / ctrl+t) also switches the variant of an
 *   already-suffixed model ID, or passes `--effort <effort>` for non-catalog levels (`xhigh`, `max`).
 */
export function resolveAgyModelSpec(
  modelId: string,
  defaultModelOrOpts?: string | ResolveAgyModelOptions,
  effortArg?: string,
): ResolvedAgyModelSpec {
  const opts: ResolveAgyModelOptions =
    typeof defaultModelOrOpts === "string"
      ? { defaultModel: defaultModelOrOpts, effort: effortArg }
      : (defaultModelOrOpts ?? {});

  let id = COSMETIC_MODEL_IDS.has(modelId) ? (opts.defaultModel ?? DEFAULT_AGY_MODEL) : modelId;
  id = LEGACY_FAMILY_ALIASES[id] ?? LEGACY_MODEL_ALIASES[id] ?? id;

  const normEffort = opts.effort?.trim().toLowerCase() || undefined;
  const normDefaultEffort = opts.defaultEffort?.trim().toLowerCase() || undefined;
  const baseFamily = id.replace(/-(low|medium|high)$/, "");
  const isBaseFamily = id in BASE_FAMILY_DEFAULTS;

  if (normEffort) {
    const candidate = `${baseFamily}-${normEffort}`;
    if (KNOWN_MODEL_IDS.has(candidate)) {
      return { model: candidate };
    }
    const fallbackModel = BASE_FAMILY_DEFAULTS[id] ?? id;
    return { model: fallbackModel, effort: normEffort };
  }

  if (isBaseFamily) {
    if (normDefaultEffort) {
      const candidate = `${baseFamily}-${normDefaultEffort}`;
      if (KNOWN_MODEL_IDS.has(candidate)) {
        return { model: candidate };
      }
      return { model: BASE_FAMILY_DEFAULTS[id], effort: normDefaultEffort };
    }
    return { model: BASE_FAMILY_DEFAULTS[id] };
  }

  return { model: id };
}

/** Legacy helper */
export function resolveAgyModel(
  modelId: string,
  opts: { defaultModel?: string; effort?: string; defaultEffort?: string },
): string {
  return resolveAgyModelSpec(modelId, opts).model;
}

export function isKnownModel(modelId: string): boolean {
  const resolved = LEGACY_FAMILY_ALIASES[modelId] ?? LEGACY_MODEL_ALIASES[modelId] ?? modelId;
  return KNOWN_MODEL_IDS.has(resolved) || resolved in BASE_FAMILY_DEFAULTS;
}

export function getModelName(modelId: string): string {
  const id = LEGACY_FAMILY_ALIASES[modelId] ?? LEGACY_MODEL_ALIASES[modelId] ?? modelId;
  if (id in BASE_FAMILY_NAMES) return BASE_FAMILY_NAMES[id];
  return KNOWN_AGY_MODELS.find((m) => m.id === id)?.name ?? modelId;
}

export function getModelsByFamily(): Record<string, KnownModel[]> {
  const groups: Record<string, KnownModel[]> = {};
  for (const model of KNOWN_AGY_MODELS) {
    (groups[model.family] ??= []).push(model);
  }
  return groups;
}
