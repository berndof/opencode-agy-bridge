import type { Plugin } from "@opencode-ai/plugin";

const plugin: Plugin = async () => ({
  config: async () => {},
  "chat.headers": async (incoming, output) => {
    if (incoming?.model?.providerID !== "agy") return;
    if (!output?.headers) return;
    output.headers["x-agy-session-id"] = incoming.sessionID;
    if (incoming.agent) output.headers["x-agy-agent"] = String(incoming.agent);
  },
});

export default plugin;
