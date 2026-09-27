import { describe, test, expect } from "bun:test";
import { runAgy } from "../src/agy-runner";
import { writeFile, chmod, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

const JSON_REPLY = JSON.stringify({
  conversation_id: "conv-abc",
  status: "SUCCESS",
  response: "Hello from mock agy",
  usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
});

describe("agy-runner", () => {
  test("passes prompt as -p argv with --output-format json (no stdin)", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "agy-bridge-test-"));
    const mockBinary = join(tmp, "mock-agy");

    await writeFile(
      mockBinary,
      `#!/usr/bin/env bash
echo "$@"
echo "---stdin-eof---"
cat -
echo '${JSON_REPLY}'
exit 0
`,
    );
    await chmod(mockBinary, 0o755);

    try {
      const result = await runAgy({
        binary: mockBinary,
        prompt: "test prompt",
        cwd: tmp,
        timeoutMs: 5000,
      });

      expect(result.exitCode).toBe(0);
      // prompt travels as argv, not stdin
      expect(result.stdout).toContain("test prompt");
      expect(result.stdout).toContain("--output-format");
      expect(result.stdout).toContain("json");
      expect(result.text).toBe("Hello from mock agy");
      expect(result.conversationId).toBe("conv-abc");
      expect(result.usage).toEqual({ inputTokens: 10, outputTokens: 5, totalTokens: 15 });
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  test("passes --model and --conversation when provided", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "agy-bridge-test-"));
    const mockBinary = join(tmp, "mock-agy");

    await writeFile(
      mockBinary,
      `#!/usr/bin/env bash
echo "$@"
echo '${JSON_REPLY}'
exit 0
`,
    );
    await chmod(mockBinary, 0o755);

    try {
      const result = await runAgy({
        binary: mockBinary,
        prompt: "hello",
        cwd: tmp,
        model: "gemini-3.6-flash-low",
        conversationId: "conv-123",
        timeoutMs: 5000,
      });

      expect(result.stdout).toContain("--model");
      expect(result.stdout).toContain("gemini-3.6-flash-low");
      expect(result.stdout).toContain("--conversation");
      expect(result.stdout).toContain("conv-123");
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  test("falls back to raw stdout when output is not JSON", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "agy-bridge-test-"));
    const mockBinary = join(tmp, "mock-agy");

    await writeFile(
      mockBinary,
      `#!/usr/bin/env bash
echo "plain text reply"
exit 0
`,
    );
    await chmod(mockBinary, 0o755);

    try {
      const result = await runAgy({
        binary: mockBinary,
        prompt: "hi",
        cwd: tmp,
        timeoutMs: 5000,
      });

      expect(result.text).toContain("plain text reply");
      expect(result.conversationId).toBeNull();
      expect(result.usage).toBeNull();
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  test("rejects on non-zero exit with empty stdout", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "agy-bridge-test-"));
    const mockBinary = join(tmp, "mock-agy");

    await writeFile(
      mockBinary,
      `#!/usr/bin/env bash
echo "error message" >&2
exit 1
`,
    );
    await chmod(mockBinary, 0o755);

    try {
      await expect(
        runAgy({
          binary: mockBinary,
          prompt: "x",
          cwd: tmp,
          timeoutMs: 5000,
        }),
      ).rejects.toThrow("error message");
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  test("includes extra args", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "agy-bridge-test-"));
    const mockBinary = join(tmp, "mock-agy");

    await writeFile(
      mockBinary,
      `#!/usr/bin/env bash
echo "$@"
echo '${JSON_REPLY}'
exit 0
`,
    );
    await chmod(mockBinary, 0o755);

    try {
      const result = await runAgy({
        binary: mockBinary,
        prompt: "hi",
        cwd: tmp,
        extraArgs: ["--effort", "low"],
        timeoutMs: 5000,
      });

      expect(result.stdout).toContain("--effort");
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });
});
