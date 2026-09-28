import { describe, test, expect } from "bun:test";
import { runAgy } from "../src/agy-runner";
import { writeFile, chmod, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

const JSON_RESULT_EVENT = JSON.stringify({
  event: "result",
  result: {
    conversation_id: "conv-abc",
    status: "SUCCESS",
    response: "Hello from mock agy",
    usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
  },
});

/** Mock agy: prints argv + the exact stdin payload it received, then a stream-json result event. */
const MOCK_STREAM_BIN = `#!/usr/bin/env bash
echo "$@"
echo "---stdin-eof---"
cat -
echo '${JSON_RESULT_EVENT}'
exit 0
`;

async function withMock(binBody: string, fn: (dir: string, bin: string) => Promise<void>) {
  const tmp = await mkdtemp(join(tmpdir(), "agy-bridge-test-"));
  const mockBinary = join(tmp, "mock-agy");
  await writeFile(mockBinary, binBody);
  await chmod(mockBinary, 0o755);
  try {
    await fn(tmp, mockBinary);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
}

describe("agy-runner", () => {
  test("sends prompt via stdin NDJSON, never as argv", async () => {
    await withMock(MOCK_STREAM_BIN, async (dir, bin) => {
      const result = await runAgy({
        binary: bin,
        prompt: "test prompt",
        cwd: dir,
        timeoutMs: 5000,
      });

      expect(result.exitCode).toBe(0);
      // argv carries the stream-json flags but not the prompt
      expect(result.stdout).toContain("--input-format");
      expect(result.stdout).toContain("stream-json");
      expect(result.stdout).toContain("--output-format");
      const argvSection = result.stdout.split("---stdin-eof---")[0];
      expect(argvSection).not.toContain("test prompt");
      // stdin carries the NDJSON user message
      expect(result.stdout).toContain('"event":"user"');
      expect(result.stdout).toContain('"text":"test prompt"');
      // parsed result event
      expect(result.text).toBe("Hello from mock agy");
      expect(result.conversationId).toBe("conv-abc");
      expect(result.usage).toEqual({ inputTokens: 10, outputTokens: 5, totalTokens: 15 });
    });
  });

  test("passes --model and --conversation when provided", async () => {
    await withMock(MOCK_STREAM_BIN, async (dir, bin) => {
      const result = await runAgy({
        binary: bin,
        prompt: "hello",
        cwd: dir,
        model: "gemini-3.6-flash-low",
        conversationId: "conv-123",
        timeoutMs: 5000,
      });

      expect(result.stdout).toContain("--model");
      expect(result.stdout).toContain("gemini-3.6-flash-low");
      expect(result.stdout).toContain("--conversation");
      expect(result.stdout).toContain("conv-123");
      // -p must NOT be used: agy rejects it alongside stream-json input
      const argvSection = result.stdout.split("---stdin-eof---")[0];
      expect(/(?:^|\s)-p(?:\s|$)/.test(argvSection)).toBe(false);
      expect(/(?:^|\s)--prompt(?:\s|$)/.test(argvSection)).toBe(false);
    });
  });

  test("handles prompts larger than the 128KiB argv limit without E2BIG", async () => {
    await withMock(MOCK_STREAM_BIN, async (dir, bin) => {
      // 512 KiB — impossible to pass as a single Linux argv entry.
      const hugePrompt = `PREAMBLE-${"x".repeat(512 * 1024)}-END "quotes" and\nnewlines`;
      const result = await runAgy({
        binary: bin,
        prompt: hugePrompt,
        cwd: dir,
        timeoutMs: 10000,
      });

      expect(result.exitCode).toBe(0);
      expect(result.text).toBe("Hello from mock agy");
      expect(result.conversationId).toBe("conv-abc");
    });
  });

  test("parses step_update lines before the final result event", async () => {
    const bin = `#!/usr/bin/env bash
cat - > /dev/null
echo '${JSON.stringify({ event: "step_update", step_update: { text_delta: "partial", state: "ACTIVE" } })}'
echo '${JSON.stringify({ event: "result", result: { conversation_id: "c1", status: "SUCCESS", response: "final text" } })}'
exit 0
`;
    await withMock(bin, async (dir, b) => {
      const result = await runAgy({ binary: b, prompt: "hi", cwd: dir, timeoutMs: 5000 });
      expect(result.text).toBe("final text");
      expect(result.conversationId).toBe("c1");
      expect(result.parsedJson).toBe(true);
    });
  });

  test("rejects on result event with ERROR status", async () => {
    const bin = `#!/usr/bin/env bash
cat - > /dev/null
echo '${JSON.stringify({ event: "result", result: { conversation_id: "", status: "ERROR", response: "", error: "empty prompt" } })}'
exit 1
`;
    await withMock(bin, async (dir, b) => {
      await expect(
        runAgy({ binary: b, prompt: "x", cwd: dir, timeoutMs: 5000 }),
      ).rejects.toThrow("empty prompt");
    });
  });

  test("falls back to raw stdout when output is not JSON", async () => {
    const bin = `#!/usr/bin/env bash
cat - > /dev/null
echo "plain text reply"
exit 0
`;
    await withMock(bin, async (dir, b) => {
      const result = await runAgy({ binary: b, prompt: "hi", cwd: dir, timeoutMs: 5000 });
      expect(result.text).toContain("plain text reply");
      expect(result.conversationId).toBeNull();
      expect(result.usage).toBeNull();
    });
  });

  test("rejects on non-zero exit with empty stdout", async () => {
    const bin = `#!/usr/bin/env bash
cat - > /dev/null
echo "error message" >&2
exit 1
`;
    await withMock(bin, async (dir, b) => {
      await expect(
        runAgy({ binary: b, prompt: "x", cwd: dir, timeoutMs: 5000 }),
      ).rejects.toThrow("error message");
    });
  });

  test("includes extra args", async () => {
    await withMock(MOCK_STREAM_BIN, async (dir, bin) => {
      const result = await runAgy({
        binary: bin,
        prompt: "hi",
        cwd: dir,
        extraArgs: ["--effort", "low"],
        timeoutMs: 5000,
      });
      expect(result.stdout).toContain("--effort");
      expect(result.stdout).toContain("low");
    });
  });
});
