import { describe, test, expect } from "bun:test";
import { createAgyProvider } from "../src/provider";
import { writeFile, chmod, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { LanguageModelV3StreamPart } from "@ai-sdk/provider";

async function withMock(binBody: string, fn: (dir: string, bin: string, stateFile: string) => Promise<void>) {
  const tmp = await mkdtemp(join(tmpdir(), "agy-provider-test-"));
  const mockBinary = join(tmp, "mock-agy");
  const stateFile = join(tmp, "sessions.json");
  await writeFile(mockBinary, binBody);
  await chmod(mockBinary, 0o755);
  try {
    await fn(tmp, mockBinary, stateFile);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
}

async function readAllStreamParts(stream: ReadableStream<LanguageModelV3StreamPart>): Promise<LanguageModelV3StreamPart[]> {
  const reader = stream.getReader();
  const parts: LanguageModelV3StreamPart[] = [];
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) parts.push(value);
  }
  return parts;
}

describe("provider / doStream", () => {
  test("streams text-start, text-delta for each chunk, and finish", async () => {
    const bin = `#!/usr/bin/env bash
cat - > /dev/null
echo '${JSON.stringify({ event: "step_update", step_update: { step_type: "agent_response", text_delta: "Hello ", state: "ACTIVE" } })}'
echo '${JSON.stringify({ event: "step_update", step_update: { step_type: "agent_response", text_delta: "streaming ", state: "ACTIVE" } })}'
echo '${JSON.stringify({ event: "step_update", step_update: { step_type: "agent_response", text_delta: "world!", state: "DONE" } })}'
echo '${JSON.stringify({ event: "result", result: { conversation_id: "conv-stream-1", status: "SUCCESS", response: "Hello streaming world!", usage: { input_tokens: 20, output_tokens: 6, total_tokens: 26 } } })}'
exit 0
`;
    await withMock(bin, async (dir, mockBin, stateFile) => {
      const provider = createAgyProvider({
        binary: mockBin,
        stateFile,
        conversationsDir: dir,
      });

      const model = provider("gemini-3.7-flash-high");
      const { stream } = await model.doStream({
        prompt: [{ role: "user", content: [{ type: "text", text: "Hi" }] }],
        inputFormat: "messages",
        mode: { type: "regular" },
      });

      const parts = await readAllStreamParts(stream);

      // Verify stream part sequence
      expect(parts.some((p) => p.type === "stream-start")).toBe(true);
      expect(parts.some((p) => p.type === "text-start")).toBe(true);

      const deltas = parts.filter((p) => p.type === "text-delta").map((p) => (p as { delta: string }).delta);
      expect(deltas).toEqual(["Hello ", "streaming ", "world!"]);

      expect(parts.some((p) => p.type === "text-end")).toBe(true);
      expect(parts.some((p) => p.type === "response-metadata")).toBe(true);

      const finishPart = parts.find((p) => p.type === "finish") as {
        type: "finish";
        usage: { inputTokens: { total?: number }; outputTokens: { total?: number } };
        finishReason: { unified: string };
      };
      expect(finishPart).toBeDefined();
      expect(finishPart.finishReason.unified).toBe("stop");
      expect(finishPart.usage.inputTokens.total).toBe(20);
      expect(finishPart.usage.outputTokens.total).toBe(6);
    });
  });

  test("falls back to full text-delta when agy outputs non-streaming text", async () => {
    const bin = `#!/usr/bin/env bash
cat - > /dev/null
echo "plain non-json response"
exit 0
`;
    await withMock(bin, async (dir, mockBin, stateFile) => {
      const provider = createAgyProvider({
        binary: mockBin,
        stateFile,
        conversationsDir: dir,
      });

      const model = provider("gemini-3.7-flash-high");
      const { stream } = await model.doStream({
        prompt: [{ role: "user", content: [{ type: "text", text: "Hi" }] }],
        inputFormat: "messages",
        mode: { type: "regular" },
      });

      const parts = await readAllStreamParts(stream);
      const deltas = parts.filter((p) => p.type === "text-delta").map((p) => (p as { delta: string }).delta);
      expect(deltas).toEqual(["plain non-json response\n"]);
    });
  });

  test("doGenerate returns complete response and usage", async () => {
    const bin = `#!/usr/bin/env bash
cat - > /dev/null
echo '${JSON.stringify({ event: "result", result: { conversation_id: "conv-gen-1", status: "SUCCESS", response: "Generated output", usage: { input_tokens: 15, output_tokens: 4, total_tokens: 19 } } })}'
exit 0
`;
    await withMock(bin, async (dir, mockBin, stateFile) => {
      const provider = createAgyProvider({
        binary: mockBin,
        stateFile,
        conversationsDir: dir,
      });

      const model = provider("gemini-3.7-flash-high");
      const result = await model.doGenerate({
        prompt: [{ role: "user", content: [{ type: "text", text: "Hello" }] }],
        inputFormat: "messages",
        mode: { type: "regular" },
      });

      expect(result.content).toEqual([{ type: "text", text: "Generated output" }]);
      expect(result.finishReason.unified).toBe("stop");
      expect(result.usage.inputTokens.total).toBe(15);
      expect(result.usage.outputTokens.total).toBe(4);
    });
  });
});
