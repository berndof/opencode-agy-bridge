import { createAgyProvider } from "./provider.js";
import type { ProviderV3 } from "@ai-sdk/provider";
import type { AgyProviderOptions } from "./provider.js";

export { createAgyProvider } from "./provider.js";

export default function unified(input?: any): any {
  if (input && typeof input === "object" && "client" in input) {
    return {
      config: async () => {},
      "chat.headers": async (incoming: any, output: any) => {
        if (incoming?.model?.providerID !== "agy") return;
        if (!output?.headers) return;
        output.headers["x-agy-session-id"] = incoming.sessionID;
      },
    };
  }

  return createAgyProvider(input as AgyProviderOptions) as ProviderV3;
}
