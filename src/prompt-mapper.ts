import type { LanguageModelV3Prompt, LanguageModelV3Message } from "@ai-sdk/provider";

export interface FlattenedPrompt {
  text: string;
  skippedFileParts: number;
  skippedToolParts: number;
}

export function flattenPromptDetailed(prompt: LanguageModelV3Prompt): FlattenedPrompt {
  let skippedFileParts = 0;
  let skippedToolParts = 0;

  const systemTexts: string[] = [];
  const dialog: Array<{ role: string; text: string }> = [];

  for (const msg of prompt) {
    const { text, files, tools } = extractTextCounted(msg);
    skippedFileParts += files;
    skippedToolParts += tools;
    if (!text.trim()) continue;
    if (msg.role === "system") {
      systemTexts.push(text.trim());
    } else {
      const label =
        msg.role === "user" ? "User" : msg.role === "assistant" ? "Assistant" : msg.role;
      dialog.push({ role: label, text: text.trim() });
    }
  }

  const parts: string[] = [];
  if (systemTexts.length > 0) {
    parts.push(`System: ${systemTexts.join("\n")}`);
  }

  if (dialog.length === 0) {
    return { text: parts.join("\n"), skippedFileParts, skippedToolParts };
  }

  if (dialog.length === 1 && parts.length === 0) {
    return { text: dialog[0].text, skippedFileParts, skippedToolParts };
  }

  if (dialog.length > 1) {
    parts.push("[Previous conversation context]");
    const history = dialog.slice(0, -1);
    for (const msg of history) {
      parts.push(`${msg.role}: ${msg.text}`);
    }
    parts.push("[End of context]");
    parts.push("");
    parts.push("Current request:");
  } else if (parts.length > 0) {
    parts.push("");
  }

  parts.push(dialog[dialog.length - 1].text);

  return { text: parts.join("\n"), skippedFileParts, skippedToolParts };
}

export function flattenPrompt(prompt: LanguageModelV3Prompt): string {
  return flattenPromptDetailed(prompt).text;
}

function extractTextCounted(msg: LanguageModelV3Message): { text: string; files: number; tools: number } {
  if (msg.role === "system") {
    return { text: msg.content, files: 0, tools: 0 };
  }

  const texts: string[] = [];
  let files = 0;
  let tools = 0;
  for (const part of msg.content) {
    switch (part.type) {
      case "text":
      case "reasoning":
        texts.push(part.text);
        break;
      case "file":
        files += 1;
        break;
      case "tool-call":
      case "tool-result":
      case "tool-approval-response":
        tools += 1;
        break;
      default:
        break;
    }
  }
  return { text: texts.join("\n"), files, tools };
}
