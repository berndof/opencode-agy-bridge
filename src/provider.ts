import type {
  ProviderV3,
  LanguageModelV3,
  LanguageModelV3CallOptions,
  LanguageModelV3StreamPart,
  SharedV3Warning,
  EmbeddingModelV3,
  ImageModelV3,
  LanguageModelV3Prompt,
  LanguageModelV3Message,
  LanguageModelV3Usage,
  LanguageModelV3FinishReason,
} from "@ai-sdk/provider";
import { runAgy } from "./agy-runner.js";
import type { AgyUsage, AgyToolStep } from "./agy-runner.js";
import { snapshot, findNewConversation, defaultConversationsDir } from "./conversation-tracker.js";
import { SessionStore } from "./session-store.js";
import { flattenPromptDetailed } from "./prompt-mapper.js";
import { randomUUID, createHash } from "node:crypto";
import { appendFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import {
  KNOWN_AGY_MODELS,
  KNOWN_MODEL_IDS,
  COSMETIC_MODEL_IDS,
  isKnownModel,
  getModelName,
  getModelsByFamily,
  DEFAULT_AGY_MODEL,
  resolveAgyModel,
  resolveAgyModelSpec,
} from "./models.js";

export interface AgyProviderOptions {
  binary?: string;
  conversationsDir?: string;
  stateFile?: string;
  extraArgs?: string[];
  timeoutMs?: number;
  /** Real agy model used when the OpenCode model id is the cosmetic "antigravity". */
  defaultModel?: string;
  /** Enable tool-call to text conversion (default: true). When enabled, tool calls are formatted as instructions for agy. */
  enableToolConversion?: boolean;
}

/** Result of preparing a call to agy */
interface PreparedAgyCall {
  sessionId: string;
  conversationId: string | null;
  before: Set<string> | null;
  prompt: string;
  warnings: SharedV3Warning[];
  entry: Awaited<ReturnType<SessionStore["getEntry"]>>;
  /** One-shot helper call (title/summary/compaction): no session binding. */
  ephemeral: boolean;
  /** Early conversation binding write triggered by agy's init event. */
  pendingBind: Promise<void> | null;
  newMessageCount: number;
}

/** In-memory cache of previous outputs for delta calculation */
const prevOutputs = new Map<string, string>();

/**
 * Convert tool calls and tool results into human-readable text instructions for agy.
 * Since agy CLI doesn't support structured tool calls, we embed them as text in the prompt.
 * For the user message (which is the only message we send to agy per call), we use raw text
 * without role labels since agy receives the role via NDJSON structure.
 */
function formatToolPartsForAgy(
  prompt: LanguageModelV3Prompt,
  fmt: { includeSystem?: boolean; labelUser?: boolean } = {},
): { text: string; warnings: SharedV3Warning[] } {
  const includeSystem = fmt.includeSystem ?? true;
  const labelUser = fmt.labelUser ?? false;
  const warnings: SharedV3Warning[] = [];
  const parts: string[] = [];

  for (const msg of prompt) {
    if (msg.role === "system") {
      // System instructions are prepended as context
      if (includeSystem) parts.push(msg.content);
      continue;
    }

    const roleLabel = msg.role === "user" ? "User" : msg.role === "assistant" ? "Assistant" : msg.role;

    for (const part of msg.content) {
      switch (part.type) {
        case "text":
        case "reasoning":
          // For user message (the one we actually send to agy), use raw text without role label.
          // agy receives the role via NDJSON structure.
          // For assistant messages (history), we include the role label for context.
          // Strip surrounding quotes if the entire message is wrapped in them (OpenCode sometimes wraps prompts in quotes).
          let text = part.text;
          if (msg.role === "user") {
            const trimmed = text.trim();
            if ((trimmed.startsWith('"') && trimmed.endsWith('"')) ||
                (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
              text = trimmed.slice(1, -1);
            }
            parts.push(labelUser ? `[${roleLabel}]: ${text}` : text);
          } else {
            parts.push(`[${roleLabel}]: ${text}`);
          }
          break;
        case "tool-call": {
          const input = JSON.stringify((part as any).input, null, 2);
          parts.push(
            `[${roleLabel} - Tool Call: ${part.toolName}]\n` +
            `Arguments:\n${input}\n` +
            `[End Tool Call]`
          );
          warnings.push({
            type: "compatibility",
            feature: "tool calling",
            details: `Tool call "${part.toolName}" converted to text instruction for agy (agy CLI does not support structured tool calls)`,
          });
          break;
        }
        case "tool-result": {
          const toolResult = (part as any).output;
          let resultText: string;
          if (toolResult && typeof toolResult === "object" && "value" in toolResult) {
            resultText = String(toolResult.value);
          } else {
            resultText = JSON.stringify(toolResult, null, 2);
          }
          parts.push(
            `[${roleLabel} - Tool Result: ${part.toolName}]\n` +
            `${resultText}\n` +
            `[End Tool Result]`
          );
          warnings.push({
            type: "compatibility",
            feature: "tool calling",
            details: `Tool result for "${part.toolName}" converted to text for agy`,
          });
          break;
        }
        case "tool-approval-response": {
          parts.push(`[${roleLabel} - Tool Approval]: ${part.approved ? "Approved" : "Denied"}`);
          warnings.push({
            type: "compatibility",
            feature: "tool calling",
            details: `Tool approval response converted to text for agy`,
          });
          break;
        }
        case "file":
          warnings.push({
            type: "unsupported",
            feature: "file content parts",
            details: `agy bridge omitted file part — agy CLI does not accept images/files`,
          });
          break;
        default:
          break;
      }
    }
  }

  return { text: parts.join("\n\n"), warnings };
}

/**
 * Simplified, robust delta extraction.
 * Strategy:
 * 1. If we have structured JSON response (parsedJson), the full text IS the delta for this turn.
 * 2. If raw stdout fallback, use prefix matching with the previous output.
 * 3. As fallback, find prevOutput anywhere in fullText and return what's after it.
 * 4. Always update the cache with the full text after extraction.
 */
export function extractDelta(
  prevOutput: string,
  fullText: string,
  isJsonResponse: boolean,
): string {
  // For JSON responses, each turn is complete — the new text is the delta
  if (isJsonResponse) {
    return fullText;
  }

  // Raw stdout fallback: extract only the new portion
  if (!prevOutput) {
    return fullText;
  }

  const normalize = (str: string) => str.replace(/\r\n/g, "\n");
  const normPrev = normalize(prevOutput);
  const normFull = normalize(fullText);

  // 1. Simple prefix match (most common case)
  if (normFull.startsWith(normPrev)) {
    return normFull.slice(normPrev.length).replace(/^\n+/, "");
  }

  // 2. Try trimmed prefix
  const normPrevTrimmed = normPrev.trimEnd();
  if (normFull.startsWith(normPrevTrimmed)) {
    return normFull.slice(normPrevTrimmed.length).replace(/^\s+/, "");
  }

  // 3. Find prevOutput anywhere in fullText (handles prepended noise)
  const idx = normFull.indexOf(normPrevTrimmed);
  if (idx !== -1) {
    return normFull.slice(idx + normPrevTrimmed.length).replace(/^\s+/, "");
  }

  // 4. Last resort: suffix match on last 200 chars of prevOutput
  const tail = normPrevTrimmed.length > 200 ? normPrevTrimmed.slice(-200) : normPrevTrimmed;
  if (tail.length >= 30) {
    const tailIdx = normFull.lastIndexOf(tail);
    if (tailIdx !== -1) {
      return normFull.slice(tailIdx + tail.length).replace(/^\s+/, "");
    }
  }

  // 5. Context truncation: last line of prevOutput matches somewhere in fullText
  const lines = normPrevTrimmed.split("\n").filter((l) => l.trim());
  if (lines.length > 0) {
    const lastLine = lines[lines.length - 1].trim();
    if (lastLine.length >= 10) {
      const lastLineIdx = normFull.indexOf(lastLine);
      if (lastLineIdx !== -1) {
        return normFull.slice(lastLineIdx + lastLine.length).replace(/^\s+/, "");
      }
    }
  }

  // Could not determine delta — return full text
  return fullText;
}

/**
 * OpenCode helper agents that run one-shot prompts (session title, summary, compaction).
 * They must not share — or pollute — the main agy conversation of the session, and they
 * need the full prompt (including OpenCode's system instructions) in a single shot.
 */
const EPHEMERAL_AGENTS = new Set(["title", "summary", "compaction"]);

/**
 * OpenCode 2.x does not tell providers which agent is calling, so helper calls are
 * recognised by their system prompt.
 */
const HELPER_SYSTEM_PREFIXES = ["You are a title generator"];

const DEBUG = !!process.env.AGY_BRIDGE_DEBUG;
const DEBUG_LOG = join(homedir(), ".opencode-agy-bridge", "debug.log");

/** Append a timing/diagnostic line to ~/.opencode-agy-bridge/debug.log when AGY_BRIDGE_DEBUG is set. */
function dbg(msg: string, data?: Record<string, unknown>): void {
  if (!DEBUG) return;
  try {
    mkdirSync(dirname(DEBUG_LOG), { recursive: true });
    appendFileSync(DEBUG_LOG, `${new Date().toISOString()} ${msg}${data ? " " + JSON.stringify(data) : ""}\n`);
  } catch {
    // diagnostics must never break a call
  }
}

/**
 * Map agy usage to LanguageModelV3Usage.
 * agy reports `output_tokens` INCLUDING `thinking_tokens` (input + output === total),
 * which matches the V3 contract where `outputTokens.total` = text + reasoning.
 */
export function toV3Usage(u: AgyUsage | null): LanguageModelV3Usage {
  if (!u) {
    return {
      inputTokens: { total: undefined, noCache: undefined, cacheRead: undefined, cacheWrite: undefined },
      outputTokens: { total: undefined, text: undefined, reasoning: undefined },
    };
  }
  const cacheRead = u.cacheReadTokens ?? 0;
  const reasoning = u.thinkingTokens ?? 0;
  return {
    inputTokens: {
      total: u.inputTokens,
      noCache: Math.max(0, u.inputTokens - cacheRead),
      cacheRead,
      cacheWrite: undefined,
    },
    outputTokens: {
      total: u.outputTokens,
      text: Math.max(0, u.outputTokens - reasoning),
      reasoning,
    },
    raw: {
      input_tokens: u.inputTokens,
      output_tokens: u.outputTokens,
      thinking_tokens: u.thinkingTokens,
      cache_read_tokens: u.cacheReadTokens,
      total_tokens: u.totalTokens,
    },
  };
}

type StreamHandlers = {
  onTextDelta?: (delta: string) => void;
  onToolStep?: (step: AgyToolStep) => void;
};

/** One-line label for an agy tool step, e.g. `run_command: git status`. */
export function describeToolStep(step: AgyToolStep): string {
  const p = step.parameters ?? {};
  const preferred = ["CommandLine", "AbsolutePath", "TargetFile", "SearchPath", "Query", "query", "Url"];
  const main =
    preferred.map((k) => p[k]).find((v) => typeof v === "string") ??
    Object.values(p).find((v) => typeof v === "string");
  if (typeof main !== "string" || !main) return step.name;
  const oneLine = main.replace(/\s+/g, " ").trim();
  return `${step.name}: ${oneLine.length > 200 ? oneLine.slice(0, 200) + "…" : oneLine}`;
}

/**
 * agy reports some empty turns only on stderr — notably tools auto-denied in headless
 * mode ("a tool required the \"command\" permission …"). Surface that instead of an
 * empty reply.
 */
export function emptyResponseNotice(stderr: string): string {
  const lines = stderr.split("\n").map((l) => l.trim()).filter(Boolean);
  const detail = lines.slice(-3).join("\n").slice(0, 800);
  return `⚠️ agy finished the turn without a response.${detail ? "\n\n" + detail : ""}`;
}

/**
 * Stable session key when OpenCode does not send x-agy-session-id: hash of the first
 * user message, so follow-up turns of the same OpenCode session resume the same agy
 * conversation instead of starting a fresh one every turn.
 */
function fallbackSessionId(prompt: LanguageModelV3Prompt): string {
  const firstUser = prompt.find((m) => m.role === "user");
  const text =
    firstUser && Array.isArray(firstUser.content)
      ? firstUser.content.map((p) => (p.type === "text" ? p.text : "")).join("")
      : "";
  if (!text) return randomUUID();
  return "fp-" + createHash("sha256").update(text).digest("hex").slice(0, 32);
}

function buildLanguageModel(
  modelId: string,
  opts: AgyProviderOptions,
): LanguageModelV3 {
  const store = new SessionStore(opts.stateFile);
  const conversationsDir = opts.conversationsDir ?? defaultConversationsDir();
  const enableToolConversion = opts.enableToolConversion ?? true;

  const prepareAgyCall = async (callOpts: LanguageModelV3CallOptions): Promise<PreparedAgyCall> => {
    const headers = callOpts.headers ?? {};
    const header = (name: string): string | undefined => {
      const key = Object.keys(headers).find((k) => k.toLowerCase() === name);
      const v = key ? headers[key] : undefined;
      return typeof v === "string" && v ? v : undefined;
    };
    const agyOpts = callOpts.providerOptions?.agy as Record<string, unknown> | undefined;
    const agent = header("x-agy-agent") ?? (agyOpts?.agent as string | undefined);
    const systemText = callOpts.prompt
      .filter((m) => m.role === "system")
      .map((m) => m.content as string)
      .join("\n");
    if (process.env.AGY_BRIDGE_DEBUG === "2") {
      try {
        mkdirSync(dirname(DEBUG_LOG), { recursive: true });
        appendFileSync(join(dirname(DEBUG_LOG), "system-prompts.log"), `\n===== ${new Date().toISOString()}\n${systemText}\n`);
      } catch {
        // diagnostics only
      }
    }
    const ephemeral =
      (agent ? EPHEMERAL_AGENTS.has(agent) : false) ||
      HELPER_SYSTEM_PREFIXES.some((p) => systemText.trimStart().startsWith(p));
    // OpenCode 2.x sends the session natively (x-opencode-session / X-Session-Id);
    // x-agy-session-id is the legacy OpenCode 1.x plugin header.
    const headerSession =
      header("x-opencode-session") ??
      header("x-session-id") ??
      header("x-agy-session-id") ??
      (agyOpts?.sessionId as string | undefined);
    const sessionId = ephemeral
      ? `ephemeral-${randomUUID()}`
      : headerSession ?? fallbackSessionId(callOpts.prompt);

    const entry = ephemeral ? null : await store.getEntry(sessionId);
    const conversationId = entry?.conversationId ?? null;
    // Fallback only: agy reports the conversation id on its very first NDJSON line, so no
    // global lock is needed (the old binding lock serialized every new session).
    const before = conversationId || ephemeral ? null : await snapshot(conversationsDir);

    const warnings: SharedV3Warning[] = [];
    const nonSystem = callOpts.prompt.filter((m) => m.role !== "system");
    let prompt: string;
    let mode: "ephemeral" | "replay" | "turn";

    if (ephemeral) {
      // One-shot helper prompt: send everything, including OpenCode's own instructions.
      mode = "ephemeral";
      const converted = formatToolPartsForAgy(callOpts.prompt, {
        includeSystem: true,
        labelUser: nonSystem.length > 1,
      });
      prompt = converted.text;
    } else if (!conversationId && nonSystem.length > 1) {
      // New agy conversation but OpenCode already has history (provider switch, lost
      // state file): replay the transcript once so agy has the context.
      mode = "replay";
      const converted = formatToolPartsForAgy(nonSystem, { includeSystem: false, labelUser: true });
      prompt = converted.text;
      warnings.push(...converted.warnings);
    } else {
      // agy CLI expects ONE user message per call (stream-json NDJSON) and keeps the
      // history itself via --conversation, so only the last user message is sent.
      mode = "turn";
      const newMessages = conversationId
        ? callOpts.prompt.slice(entry?.processedMessages ?? 0)
        : callOpts.prompt;
      const lastUserMessage =
        [...newMessages].reverse().find((m) => m.role === "user") ??
        [...callOpts.prompt].reverse().find((m) => m.role === "user");

      if (!lastUserMessage) {
        throw new Error("No user message found in prompt");
      }

      if (enableToolConversion) {
        const converted = formatToolPartsForAgy([lastUserMessage]);
        prompt = converted.text;
        warnings.push(...converted.warnings);
      } else {
        // Legacy behavior
        const flattened = flattenPromptDetailed([lastUserMessage]);
        prompt = flattened.text;
        if (flattened.skippedFileParts > 0) {
          warnings.push({
            type: "unsupported",
            feature: "file content parts",
            details: `agy bridge omitted ${flattened.skippedFileParts} image/file part(s) — agy CLI does not accept them`,
          });
        }
        if (flattened.skippedToolParts > 0) {
          warnings.push({
            type: "unsupported",
            feature: "tool calling",
            details: `agy bridge omitted ${flattened.skippedToolParts} tool part(s) — tool use happens inside agy's own process`,
          });
        }
      }
    }

    // Structured-output requests: agy has no response_format flag
    const responseFormat = (callOpts as { responseFormat?: { type?: string } }).responseFormat;
    if (responseFormat?.type === "json") {
      prompt += "\n\nRespond with valid JSON only. No markdown fences, no extra text.";
      warnings.push({
        type: "compatibility",
        feature: "structured-output",
        details: "agy CLI has no response_format support; appended a JSON-only instruction instead",
      });
    }

    dbg("prepare", {
      modelId,
      agent: agent ?? null,
      mode,
      sessionId,
      sessionSource: ephemeral ? "ephemeral" : headerSession ? "header" : "fallback-hash",
      conversationId,
      promptChars: prompt.length,
      messages: callOpts.prompt.length,
      headers: Object.fromEntries(
        Object.entries(headers).map(([k, v]) => [
          k,
          /auth|key|token|ticket|cookie/i.test(k) ? "<redacted>" : String(v).slice(0, 80),
        ]),
      ),
      providerOptions: JSON.stringify(callOpts.providerOptions ?? {}).slice(0, 400),
      systemPrefix: callOpts.prompt
        .filter((m) => m.role === "system")
        .map((m) => (m.content as string).slice(0, 160))
        .join(" | "),
    });

    return {
      sessionId,
      conversationId,
      before,
      prompt,
      warnings,
      entry,
      ephemeral,
      pendingBind: null,
      newMessageCount: callOpts.prompt.length,
    };
  };

  const runForCall = (
    prep: PreparedAgyCall,
    abortSignal: AbortSignal | undefined,
    handlers: StreamHandlers = {},
  ) => {
    const spec = resolveAgyModelSpec(modelId, opts.defaultModel);
    const extraArgs = [...(opts.extraArgs ?? [])];
    if (prep.ephemeral) {
      // Title/summary prompts don't benefit from deep thinking; use the -low variant if any.
      const low = spec.model.replace(/-(high|medium)$/, "-low");
      if (low !== spec.model && KNOWN_MODEL_IDS.has(low)) spec.model = low;
    }
    if (spec.effort && !extraArgs.includes("--effort")) {
      extraArgs.push("--effort", spec.effort);
    }
    const t0 = Date.now();
    let firstDelta = true;

    return runAgy({
      prompt: prep.prompt,
      cwd: process.cwd(),
      conversationId: prep.conversationId ?? undefined,
      model: spec.model,
      binary: opts.binary,
      extraArgs,
      timeoutMs: opts.timeoutMs,
      abortSignal,
      onConversationId: (id) => {
        dbg("agy:conversation-id", { sessionId: prep.sessionId, id, ms: Date.now() - t0 });
        if (prep.ephemeral || prep.conversationId) return;
        // Bind immediately so an aborted/crashed turn still resumes the same conversation.
        prep.pendingBind = store
          .set(prep.sessionId, id, prep.newMessageCount, prep.entry?.prevOutput ?? "")
          .catch(() => {});
      },
      onTextDelta: handlers.onTextDelta
        ? (delta) => {
          if (firstDelta) {
            firstDelta = false;
            dbg("agy:first-delta", { sessionId: prep.sessionId, ms: Date.now() - t0 });
          }
          handlers.onTextDelta!(delta);
        }
        : undefined,
      onToolStep: (step) => {
        dbg("agy:tool", { sessionId: prep.sessionId, ms: Date.now() - t0, tool: describeToolStep(step), state: step.state });
        handlers.onToolStep?.(step);
      },
    }).then((result) => {
      dbg("agy:done", {
        sessionId: prep.sessionId,
        model: spec.model,
        effort: spec.effort ?? null,
        ms: Date.now() - t0,
        usage: result.usage,
      });
      return result;
    });
  };

  const finalizeAgyCall = async (
    prep: PreparedAgyCall,
    result: Awaited<ReturnType<typeof runAgy>>,
  ): Promise<{ conversationId: string | null; delta: string }> => {
    if (prep.ephemeral) {
      return { conversationId: result.conversationId, delta: result.text };
    }
    if (prep.pendingBind) await prep.pendingBind;

    let conversationId = prep.conversationId;
    if (!conversationId) {
      if (result.conversationId) {
        conversationId = result.conversationId;
      } else if (prep.before) {
        const newId = await findNewConversation(prep.before, conversationsDir);
        if (newId) {
          conversationId = newId;
        }
      }
    }

    // Restore prevOutput from persisted store
    let prevOutput = prevOutputs.get(prep.sessionId) ?? "";
    if (!prevOutput && prep.entry?.prevOutput) {
      prevOutput = prep.entry.prevOutput;
      prevOutputs.set(prep.sessionId, prevOutput);
    }

    // Extract delta
    const delta = extractDelta(prevOutput, result.text, result.parsedJson);

    // Always update cache with full text for next turn
    if (conversationId) {
      prevOutputs.set(prep.sessionId, result.text);
    } else {
      prevOutputs.delete(prep.sessionId);
    }

    // Persist state (survives restarts)
    await store.set(
      prep.sessionId,
      conversationId,
      conversationId ? prep.newMessageCount : 0,
      conversationId ? result.text : "",
    );

    return { conversationId, delta };
  };

  const finishReasonFor = (result: Awaited<ReturnType<typeof runAgy>>): LanguageModelV3FinishReason => ({
    // OpenCode maps `unified` -> LLM.FinishReasonDetails.normalized; it MUST be present.
    unified: "stop",
    raw: "stop",
  });

  const doGenerate = async (callOpts: LanguageModelV3CallOptions) => {
    const prep = await prepareAgyCall(callOpts);
    const result = await runForCall(prep, callOpts.abortSignal);
    const { conversationId, delta } = await finalizeAgyCall(prep, result);

    return {
      content: [{ type: "text" as const, text: delta.trim() ? delta : emptyResponseNotice(result.stderr) }],
      finishReason: finishReasonFor(result),
      usage: toV3Usage(result.usage),
      providerMetadata: {
        agy: {
          sessionId: prep.sessionId,
          conversationId: conversationId ?? null,
        },
      },
      response: {
        id: result.conversationId ?? randomUUID(),
        timestamp: new Date(),
        modelId,
      },
      warnings: prep.warnings,
    };
  };

  const doStream = async (callOpts: LanguageModelV3CallOptions) => {
    // Fast now (no global lock) — errors here surface as a normal rejected call.
    const prep = await prepareAgyCall(callOpts);

    // Internal controller so a cancelled stream (OpenCode stopped reading) kills agy too.
    const ac = new AbortController();
    const onOuterAbort = () => ac.abort();
    if (callOpts.abortSignal?.aborted) ac.abort();
    callOpts.abortSignal?.addEventListener("abort", onOuterAbort, { once: true });

    let closed = false;

    const stream = new ReadableStream<LanguageModelV3StreamPart>({
      start(controller) {
        const enqueue = (part: LanguageModelV3StreamPart) => {
          if (closed) return;
          try {
            controller.enqueue(part);
          } catch {
            closed = true;
          }
        };
        const close = () => {
          if (closed) return;
          closed = true;
          callOpts.abortSignal?.removeEventListener("abort", onOuterAbort);
          try {
            controller.close();
          } catch {
            // already closed/errored
          }
        };

        enqueue({ type: "stream-start", warnings: prep.warnings });

        // Text blocks: a new block after each agy tool step, so text and tool activity
        // render in order.
        let textSeq = 0;
        let textId: string | null = null;
        let streamedText = "";
        const openText = (): string => {
          if (!textId) {
            textId = `agy-text-${++textSeq}`;
            enqueue({ type: "text-start", id: textId });
          }
          return textId;
        };
        const closeText = () => {
          if (textId) {
            enqueue({ type: "text-end", id: textId });
            textId = null;
          }
        };

        // agy's own tool calls (run_command, view_file, ...) are shown as reasoning blocks.
        const openTools = new Set<string>();
        const onToolStep = (step: AgyToolStep) => {
          if (ac.signal.aborted) return;
          const rid = `agy-tool-${step.index}`;
          const active = step.state === "ACTIVE";
          if (!openTools.has(rid)) {
            closeText();
            openTools.add(rid);
            enqueue({ type: "reasoning-start", id: rid });
            enqueue({ type: "reasoning-delta", id: rid, delta: `▸ ${describeToolStep(step)}` });
          }
          if (!active) {
            if (step.state && step.state !== "DONE") {
              enqueue({ type: "reasoning-delta", id: rid, delta: ` (${step.state.toLowerCase()})` });
            }
            enqueue({ type: "reasoning-end", id: rid });
            openTools.delete(rid);
          }
        };
        const closeTools = () => {
          for (const rid of openTools) enqueue({ type: "reasoning-end", id: rid });
          openTools.clear();
        };

        // Do NOT await inside start(): run the turn in the background and push parts as
        // they arrive, so the consumer renders deltas live.
        void (async () => {
          try {
            const result = await runForCall(prep, ac.signal, {
              onTextDelta: (delta) => {
                if (ac.signal.aborted) return;
                streamedText += delta;
                enqueue({ type: "text-delta", id: openText(), delta });
              },
              onToolStep,
            });

            if (ac.signal.aborted) {
              close();
              return;
            }

            const { delta } = await finalizeAgyCall(prep, result);
            closeTools();

            enqueue({
              type: "response-metadata",
              id: result.conversationId ?? randomUUID(),
              timestamp: new Date(),
              modelId,
            });

            if (streamedText) {
              // If final delta has more than we streamed, emit remainder
              if (delta.length > streamedText.length && delta.startsWith(streamedText)) {
                const remaining = delta.slice(streamedText.length);
                if (remaining) enqueue({ type: "text-delta", id: openText(), delta: remaining });
              }
            } else {
              // No streamed deltas: emit the full text, or explain why there is none
              // (e.g. agy auto-denied a tool permission in headless mode).
              const text = delta.trim() ? delta : emptyResponseNotice(result.stderr);
              enqueue({ type: "text-delta", id: openText(), delta: text });
            }
            closeText();

            enqueue({
              type: "finish",
              finishReason: finishReasonFor(result),
              usage: toV3Usage(result.usage),
              providerMetadata: {
                agy: {
                  sessionId: prep.sessionId,
                  conversationId: result.conversationId ?? null,
                },
              },
            });
            close();
          } catch (err) {
            if (ac.signal.aborted) {
              close();
              return;
            }
            dbg("agy:error", { sessionId: prep.sessionId, error: String(err) });
            closeTools();
            closeText();
            enqueue({ type: "error", error: err });
            close();
          }
        })();
      },
      cancel() {
        closed = true;
        ac.abort();
        callOpts.abortSignal?.removeEventListener("abort", onOuterAbort);
      },
    });

    return { stream };
  };

  return {
    specificationVersion: "v3",
    provider: "agy",
    modelId,
    supportedUrls: {},
    doGenerate,
    doStream,
  };
}

function unsupportedEmbeddingModel(modelId: string): EmbeddingModelV3 {
  return {
    specificationVersion: "v3",
    provider: "agy",
    modelId,
    maxEmbeddingsPerCall: 0,
    supportsParallelCalls: false,
    doEmbed: async () => {
      throw new Error("agy bridge does not support text embeddings");
    },
  };
}

function unsupportedImageModel(modelId: string): ImageModelV3 {
  return {
    specificationVersion: "v3",
    provider: "agy",
    modelId,
    maxImagesPerCall: 0,
    doGenerate: async () => {
      throw new Error("agy bridge does not support image generation");
    },
  };
}

export function createAgyProvider(
  opts?: AgyProviderOptions,
): ProviderV3 & { (modelId: string): LanguageModelV3; provider: string } {
  const resolvedOpts = opts ?? {};

  const factory = (modelId: string): LanguageModelV3 => {
    return buildLanguageModel(modelId, resolvedOpts);
  };

  factory.provider = "agy";
  factory.specificationVersion = "v3" as const;
  factory.languageModel = factory;
  factory.embeddingModel = (modelId: string) => unsupportedEmbeddingModel(modelId);
  factory.textEmbeddingModel = (modelId: string) => unsupportedEmbeddingModel(modelId);
  factory.imageModel = (modelId: string) => unsupportedImageModel(modelId);

  return factory as ProviderV3 & { (modelId: string): LanguageModelV3; provider: string };
}

export default function defaultFactory(
  opts?: AgyProviderOptions,
): ProviderV3 {
  return createAgyProvider(opts) as ProviderV3;
}

// Re-export model utilities for OpenCode plugin config
export {
  KNOWN_AGY_MODELS,
  KNOWN_MODEL_IDS,
  COSMETIC_MODEL_IDS,
  isKnownModel,
  getModelName,
  getModelsByFamily,
  DEFAULT_AGY_MODEL,
  resolveAgyModel,
  resolveAgyModelSpec,
} from "./models.js";