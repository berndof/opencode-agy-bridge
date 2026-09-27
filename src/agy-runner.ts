import type { SpawnOptions } from "node:child_process";
import { spawn } from "node:child_process";

export interface RunAgyInput {
  prompt: string;
  cwd: string;
  conversationId?: string;
  model?: string;
  binary?: string;
  extraArgs?: string[];
  timeoutMs?: number;
}

export interface AgyUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
}

export interface RunAgyResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  /** Parsed response text when --output-format json succeeds, else raw stdout. */
  text: string;
  /** True when text comes from per-turn JSON response (no delta extraction needed). */
  parsedJson: boolean;
  /** Authoritative conversation id from JSON output, or null when unavailable. */
  conversationId: string | null;
  usage: AgyUsage | null;
}

interface AgyJsonOutput {
  conversation_id?: string;
  status?: string;
  response?: string;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    total_tokens?: number;
  };
}

function parseAgyJson(stdout: string): { text: string; conversationId: string | null; usage: AgyUsage | null } | null {
  // Real agy prints pure JSON, but be tolerant: scan lines from the end for
  // the last JSON object (mocks/wrappers may echo argv first).
  const candidates: string[] = [stdout.trim()];
  const lines = stdout.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (line.startsWith("{") && line.endsWith("}")) candidates.push(line);
  }
  for (const candidate of candidates) {
    if (!candidate.startsWith("{")) continue;
    try {
      const parsed = JSON.parse(candidate) as AgyJsonOutput;
      if (typeof parsed.response !== "string") continue;
      return {
        text: parsed.response,
        conversationId: typeof parsed.conversation_id === "string" ? parsed.conversation_id : null,
        usage: parsed.usage
          ? {
            inputTokens: parsed.usage.input_tokens ?? 0,
            outputTokens: parsed.usage.output_tokens ?? 0,
            totalTokens: parsed.usage.total_tokens ?? 0,
          }
          : null,
      };
    } catch {
      continue;
    }
  }
  return null;
}

export async function runAgy(input: RunAgyInput): Promise<RunAgyResult> {
  const binary = input.binary ?? "agy";
  const timeoutMs = input.timeoutMs ?? 300_000;
  const extraArgs = input.extraArgs ?? [];

  const args: string[] = [
    "--add-dir",
    input.cwd,
    ...extraArgs,
  ];

  if (input.model) {
    args.push("--model", input.model);
  }

  // NOTE: `-p -` does NOT read stdin on current agy builds — the literal
  // "-" is treated as the prompt. Pass the prompt as argv instead (spawn
  // uses argv directly, no shell, so no quoting risk).
  args.push("--output-format", "json");

  if (input.conversationId) {
    args.push("--conversation", input.conversationId);
  }

  args.push("-p", input.prompt);

  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, {
      cwd: input.cwd,
      stdio: ["ignore", "pipe", "pipe"],
    });

    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];

    child.stdout.on("data", (chunk: Buffer) => stdoutChunks.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderrChunks.push(chunk));

    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error("agy timed out"));
    }, timeoutMs);

    child.on("close", (code) => {
      clearTimeout(timer);

      const stdout = Buffer.concat(stdoutChunks).toString("utf-8");
      const stderr = Buffer.concat(stderrChunks).toString("utf-8");
      const exitCode = code ?? 1;

      if (stderr.trim()) {
      }

      if (exitCode !== 0 && !stdout.trim()) {
        const msg = stderr.trim() || `agy exited with status ${exitCode}`;
        reject(new Error(msg));
        return;
      }

      const parsed = parseAgyJson(stdout);
      resolve({
        stdout,
        stderr,
        exitCode,
        text: parsed?.text ?? stdout,
        parsedJson: parsed !== null,
        conversationId: parsed?.conversationId ?? null,
        usage: parsed?.usage ?? null,
      });
    });

    child.on("error", (err) => {
      clearTimeout(timer);
      reject(new Error(`failed to spawn agy: ${err.message}`));
    });
  });
}
