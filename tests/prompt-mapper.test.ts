import { describe, test, expect } from "bun:test";
import { flattenPrompt, flattenPromptDetailed } from "../src/prompt-mapper";

describe("flattenPrompt", () => {
  test("preserves system messages at the top", () => {
    const result = flattenPrompt([
      { role: "system", content: "You are a helpful assistant." },
      {
        role: "user",
        content: [{ type: "text", text: "hi" }],
      },
    ]);
    expect(result).toContain("System: You are a helpful assistant.");
    expect(result).toContain("hi");
  });

  test("single user message: raw text, no role prefix", () => {
    const result = flattenPrompt([
      {
        role: "user",
        content: [{ type: "text", text: "Hello, how are you?" }],
      },
    ]);
    expect(result).toBe("Hello, how are you?");
  });

  test("single assistant message: raw text, no role prefix", () => {
    const result = flattenPrompt([
      {
        role: "assistant",
        content: [{ type: "text", text: "I am fine, thanks." }],
      },
    ]);
    expect(result).toBe("I am fine, thanks.");
  });

  test("multi-message: wraps history in context block + current at end", () => {
    const result = flattenPrompt([
      {
        role: "user",
        content: [{ type: "text", text: "hello" }],
      },
      {
        role: "assistant",
        content: [{ type: "text", text: "hi there" }],
      },
      {
        role: "user",
        content: [{ type: "text", text: "how are you?" }],
      },
    ]);
    expect(result).toContain("[Previous conversation context]");
    expect(result).toContain("[End of context]");
    expect(result).toContain("Current request:");
    expect(result).toContain("how are you?");
    expect(result).toContain("User: hello");
    expect(result).toContain("Assistant: hi there");
  });

  test("counts omitted file parts", () => {
    const result = flattenPromptDetailed([
      {
        role: "user",
        content: [
          { type: "text", text: "Look at this:" },
          { type: "file", data: new Uint8Array(), mediaType: "image/png" },
        ],
      },
    ]);
    expect(result.text).toBe("Look at this:");
    expect(result.skippedFileParts).toBe(1);
  });

  test("handles user message with multiple text parts", () => {
    const result = flattenPrompt([
      {
        role: "user",
        content: [
          { type: "text", text: "First part." },
          { type: "text", text: "Second part." },
        ],
      },
    ]);
    expect(result).toBe("First part.\nSecond part.");
  });

  test("system-only prompt returns system block, not empty", () => {
    const result = flattenPrompt([
      { role: "system", content: "You are an agent." },
      { role: "system", content: "Use tools carefully." },
    ]);
    expect(result).toContain("System:");
    expect(result).toContain("You are an agent.");
  });

  test("counts tool-call parts in multi-message context", () => {
    const result = flattenPromptDetailed([
      {
        role: "assistant",
        content: [
          {
            type: "tool-call",
            toolCallId: "call-1",
            toolName: "read_file",
            input: { path: "/foo" },
          },
        ],
      },
      {
        role: "user",
        content: [{ type: "text", text: "next" }],
      },
    ]);
    expect(result.text).toContain("next");
    expect(result.skippedToolParts).toBe(1);
  });
});
