import { spawn } from "node:child_process";
import { StringDecoder } from "node:string_decoder";

export interface RunAgyInput {
  prompt: string;
  cwd: string;
  conversationId?: string;
  model?: string;
  binary?: string;
  extraArgs?: string[];
  timeoutMs?: number;
  onTextDelta?: (delta: string) => void;
  abortSignal?: AbortSignal;
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
  /** Parsed response text when stream-json output succeeds, else raw stdout. */
  text: string;
  /** True when text comes from per-turn JSON result (no delta extraction needed). */
  parsedJson: boolean;
  /** Authoritative conversation id from JSON output, or null when unavailable. */
  conversationId: string | null;
  usage: AgyUsage | null;
}

interface AgyJsonOutput {
  conversation_id?: string;
  status?: string;
  response?: string;
  error?: string;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    total_tokens?: number;
  };
}

function toResult(parsed: AgyJsonOutput): {
  text: string;
  conversationId: string | null;
  usage: AgyUsage | null;
} {
  return {
    text: parsed.response ?? "",
    conversationId: typeof parsed.conversation_id === "string" ? parsed.conversation_id : null,
    usage: parsed.usage
      ? {
        inputTokens: parsed.usage.input_tokens ?? 0,
        outputTokens: parsed.usage.output_tokens ?? 0,
        totalTokens: parsed.usage.total_tokens ?? 0,
      }
      : null,
  };
}

/**
 * agy emits line-delimited NDJSON in stream-json mode: an init banner (tool
 * list), `step_update` events with text deltas, and a final
 * `{"event":"result","result":{...}}` carrying the same fields as
 * `--output-format json`. Be tolerant: prefer the result event, then fall
 * back to any standalone JSON object with a string `response`.
 */
function parseAgyStdout(stdout: string): (ReturnType<typeof toResult> & { error: string | null }) | null {
  const lines = stdout.split("\n");

  // 1) Authoritative: the stream-json result event.
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (!line.startsWith("{")) continue;
    try {
      const parsed = JSON.parse(line) as { event?: string; result?: AgyJsonOutput };
      if (parsed.event !== "result" || !parsed.result) continue;
      if (typeof parsed.result.response !== "string") continue;
      return {
        ...toResult(parsed.result),
        error: typeof parsed.result.error === "string" ? parsed.result.error : null,
      };
    } catch {
      continue;
    }
  }

  // 2) Fallback: whole stdout as one JSON object, then per-line objects.
  const candidates: string[] = [stdout.trim()];
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (line.startsWith("{") && line.endsWith("}")) candidates.push(line);
  }
  for (const candidate of candidates) {
    if (!candidate.startsWith("{")) continue;
    try {
      const parsed = JSON.parse(candidate) as AgyJsonOutput;
      if (typeof parsed.response !== "string") continue;
      return { ...toResult(parsed), error: typeof parsed.error === "string" ? parsed.error : null };
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

  // The prompt travels over stdin as an NDJSON stream-json message instead of
  // argv: Linux caps a single argument at 128 KiB (MAX_ARG_STRLEN) and raises
  // E2BIG for larger prompts, which long sessions hit routinely.
  const args: string[] = [
    "--add-dir",
    input.cwd,
    ...extraArgs,
  ];

  if (input.model) {
    args.push("--model", input.model);
  }

  args.push("--input-format", "stream-json", "--output-format", "stream-json");

  if (input.conversationId) {
    args.push("--conversation", input.conversationId);
  }

  const stdinMessage = JSON.stringify({
    event: "user",
    message: { role: "user", content: [{ type: "text", text: input.prompt }] },
  });

  return new Promise((resolve, reject) => {
    if (input.abortSignal?.aborted) {
      reject(new Error("agy execution aborted"));
      return;
    }

    const child = spawn(binary, args, {
      cwd: input.cwd,
      stdio: ["pipe", "pipe", "pipe"],
    });

    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    const decoder = new StringDecoder("utf-8");
    let stdoutBuffer = "";
    let isSettled = false;

    function processStreamLine(line: string) {
      if (!line.startsWith("{")) return;
      try {
        const parsed = JSON.parse(line) as {
          event?: string;
          step_update?: {
            step_type?: string;
            text_delta?: string;
          };
        };
        if (
          parsed.event === "step_update" &&
          (parsed.step_update?.step_type === "agent_response" || !parsed.step_update?.step_type) &&
          typeof parsed.step_update?.text_delta === "string" &&
          parsed.step_update.text_delta.length > 0
        ) {
          input.onTextDelta?.(parsed.step_update.text_delta);
        }
      } catch {
        // Line might be incomplete or non-JSON; full tolerant parsing occurs on close.
      }
    }

    child.stdout.on("data", (chunk: Buffer) => {
      stdoutChunks.push(chunk);
      if (input.onTextDelta) {
        stdoutBuffer += decoder.write(chunk);
        let newlineIdx: number;
        while ((newlineIdx = stdoutBuffer.indexOf("\n")) !== -1) {
          const line = stdoutBuffer.slice(0, newlineIdx).trim();
          stdoutBuffer = stdoutBuffer.slice(newlineIdx + 1);
          if (line) {
            processStreamLine(line);
          }
        }
      }
    });

    child.stderr.on("data", (chunk: Buffer) => stderrChunks.push(chunk));

    let cleanupAbort: (() => void) | null = null;
    if (input.abortSignal) {
      const onAbort = () => {
        if (isSettled) return;
        isSettled = true;
        clearTimeout(timer);
        child.kill("SIGKILL");
        reject(new Error("agy execution aborted"));
      };
      input.abortSignal.addEventListener("abort", onAbort, { once: true });
      cleanupAbort = () => {
        input.abortSignal?.removeEventListener("abort", onAbort);
      };
    }

    const timer = setTimeout(() => {
      if (isSettled) return;
      isSettled = true;
      child.kill("SIGKILL");
      reject(new Error("agy timed out"));
    }, timeoutMs);

    // agy can exit before reading stdin (bad flags, immediate crash); don't
    // let the write reject the promise twice.
    child.stdin.on("error", () => { /* surfaced via close/exitCode below */ });
    child.stdin.end(stdinMessage + "\n");

    child.on("close", (code) => {
      clearTimeout(timer);
      if (cleanupAbort) cleanupAbort();
      if (isSettled) return;
      isSettled = true;

      if (input.onTextDelta) {
        stdoutBuffer += decoder.end();
        if (stdoutBuffer.trim()) {
          processStreamLine(stdoutBuffer.trim());
        }
      }

      const stdout = Buffer.concat(stdoutChunks).toString("utf-8");
      const stderr = Buffer.concat(stderrChunks).toString("utf-8");
      const exitCode = code ?? 1;

      if (exitCode !== 0 && !stdout.trim()) {
        const msg = stderr.trim() || `agy exited with status ${exitCode}`;
        reject(new Error(msg));
        return;
      }

      const parsed = parseAgyStdout(stdout);

      if (parsed && parsed.error && !parsed.text.trim()) {
        reject(new Error(parsed.error || stderr.trim() || `agy exited with status ${exitCode}`));
        return;
      }

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
      if (cleanupAbort) cleanupAbort();
      if (isSettled) return;
      isSettled = true;

      const errno = err as NodeJS.ErrnoException;
      if (errno.code === "E2BIG") {
        reject(
          new Error(
            `failed to spawn agy: E2BIG (argument list too long) — prompt is ${Buffer.byteLength(input.prompt)} bytes; the prompt should travel via stdin`,
          ),
        );
        return;
      }
      reject(new Error(`failed to spawn agy: ${err.message}`));
    });
  });
}
