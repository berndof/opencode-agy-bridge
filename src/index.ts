import { createAgyProvider } from "./provider.js";
import type { ProviderV3 } from "@ai-sdk/provider";
import type { AgyProviderOptions } from "./provider.js";

// Re-export model utilities for OpenCode plugin configuration
export {
  KNOWN_AGY_MODELS,
  KNOWN_MODEL_IDS,
  COSMETIC_MODEL_IDS,
  isKnownModel,
  getModelName,
  getModelsByFamily,
  DEFAULT_AGY_MODEL,
  resolveAgyModelSpec,
} from "./models.js";

export { createAgyProvider } from "./provider.js";
export type { AgyProviderOptions } from "./provider.js";
export { extractDelta } from "./provider.js";

export default function unified(input?: any): any {
  if (input && typeof input === "object" && "client" in input) {
    return {
      config: async () => {},
      "chat.headers": async (incoming: any, output: any) => {
        if (incoming?.model?.providerID !== "agy") return;
        if (!output?.headers) return;
        output.headers["x-agy-session-id"] = incoming.sessionID;
        if (incoming.agent) output.headers["x-agy-agent"] = String(incoming.agent);
      },
    };
  }

  return createAgyProvider(input as AgyProviderOptions) as ProviderV3;
}