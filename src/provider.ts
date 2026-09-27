import type {
  ProviderV3,
  LanguageModelV3,
  LanguageModelV3CallOptions,
  LanguageModelV3StreamPart,
  SharedV3Warning,
  EmbeddingModelV3,
  ImageModelV3,
} from "@ai-sdk/provider";
import { runAgy } from "./agy-runner.js";
import { snapshot, findNewConversation, defaultConversationsDir } from "./conversation-tracker.js";
import { SessionStore } from "./session-store.js";
import { flattenPromptDetailed } from "./prompt-mapper.js";
import { randomUUID } from "node:crypto";

export interface AgyProviderOptions {
  binary?: string;
  conversationsDir?: string;
  stateFile?: string;
  extraArgs?: string[];
  timeoutMs?: number;
  /** Real agy model used when the OpenCode model id is the cosmetic "antigravity". */
  defaultModel?: string;
}

/** Cosmetic ids that carry no real agy model name. */
const COSMETIC_MODEL_IDS = new Set(["antigravity"]);

export function resolveAgyModel(modelId: string, opts: AgyProviderOptions): string {
  if (COSMETIC_MODEL_IDS.has(modelId)) {
    return opts.defaultModel ?? "gemini-3.6-flash-low";
  }
  return modelId;
}

const prevOutputs = new Map<string, string>();

export function extractDelta(
  prevOutput: string,
  fullText: string,
  conversationBound: boolean,
): string {
  if (!conversationBound || !prevOutput) {
    return fullText;
  }

  const normalize = (str: string) => str.replace(/\r\n/g, "\n");
  const normPrev = normalize(prevOutput);
  const normFull = normalize(fullText);

  if (normFull.startsWith(normPrev)) {
    return normFull.slice(normPrev.length).replace(/^\n+/, "");
  }

  const normPrevTrimmed = normPrev.trimEnd();
  if (normFull.startsWith(normPrevTrimmed)) {
    return normFull.slice(normPrevTrimmed.length).replace(/^\s+/, "");
  }

  const idx = normFull.indexOf(normPrevTrimmed);
  if (idx !== -1) {
    return normFull.slice(idx + normPrevTrimmed.length).replace(/^\s+/, "");
  }

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

  const tailLength = 150;
  const tail = normPrevTrimmed.length > tailLength
    ? normPrevTrimmed.slice(-tailLength)
    : normPrevTrimmed;

  if (tail.length >= 20) {
    const tailIdx = normFull.lastIndexOf(tail);
    if (tailIdx !== -1) {
      return normFull.slice(tailIdx + tail.length).replace(/^\s+/, "");
    }
  }

  return fullText;
}

function toV3Usage(u: { inputTokens: number; outputTokens: number; totalTokens: number } | null) {
  return {
    inputTokens: {
      total: u?.inputTokens,
      noCache: undefined,
      cacheRead: undefined,
      cacheWrite: undefined,
    },
    outputTokens: {
      total: u?.outputTokens,
      text: u?.outputTokens,
      reasoning: undefined,
    },
  };
}

function buildLanguageModel(
  modelId: string,
  opts: AgyProviderOptions,
): LanguageModelV3 {
  const store = new SessionStore(opts.stateFile);
  const conversationsDir = opts.conversationsDir ?? defaultConversationsDir();

  const doGenerate = async (callOpts: LanguageModelV3CallOptions) => {
    const sessionId =
      (callOpts.headers?.["x-agy-session-id"] as string) ??
      (callOpts.providerOptions?.agy as Record<string, unknown> | undefined)
        ?.sessionId as string ??
      randomUUID();

    const entry = await store.getEntry(sessionId);
    let conversationId = entry?.conversationId ?? null;
    const processedMessages = entry?.processedMessages ?? 0;

    // On first turn (no conversation yet), acquire a global lock before
    // spawning agy so the .pb fallback diff stays race-free across
    // concurrent OpenCode instances.
    let releaseBindingLock: (() => Promise<void>) | null = null;
    if (!conversationId) {
      releaseBindingLock = await SessionStore.acquireBindingLock();
    }

    let before: Set<string> | null = null;
    try {
      before = conversationId ? null : await snapshot(conversationsDir);

      const newMessages = conversationId
        ? callOpts.prompt.slice(processedMessages)
        : callOpts.prompt;

      const flattened = flattenPromptDetailed(newMessages);
      let prompt = flattened.text;

      const warnings: SharedV3Warning[] = [];
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

      // Structured-output requests (e.g. session title generation): agy has
      // no response_format flag, so instruct JSON-only and let the caller parse.
      const responseFormat = (callOpts as { responseFormat?: { type?: string } }).responseFormat;
      if (responseFormat?.type === "json") {
        prompt += "\n\nRespond with valid JSON only. No markdown fences, no extra text.";
        warnings.push({
          type: "compatibility",
          feature: "structured-output",
          details: "agy CLI has no response_format support; appended a JSON-only instruction instead",
        });
      }

      const result = await runAgy({
        prompt,
        cwd: process.cwd(),
        conversationId: conversationId ?? undefined,
        model: resolveAgyModel(modelId, opts),
        binary: opts.binary,
        extraArgs: opts.extraArgs,
        timeoutMs: opts.timeoutMs,
      });

      // Prefer the authoritative id from --output-format json; fall back to
      // .pb diffing only when agy did not return one (older builds).
      if (!conversationId) {
        if (result.conversationId) {
          conversationId = result.conversationId;
        } else if (before) {
          const newId = await findNewConversation(before, conversationsDir);
          if (newId) {
            conversationId = newId;
          }
        }
      }

      // Restore prevOutput from persisted store (survives restarts).
      // In-memory cache takes priority (faster, has latest turn data).
      let prevOutput = prevOutputs.get(sessionId) ?? "";
      if (!prevOutput && entry?.prevOutput) {
        prevOutput = entry.prevOutput;
        prevOutputs.set(sessionId, prevOutput);
      }

      // JSON responses are per-turn: the new text IS the delta. Only apply
      // heuristic delta extraction for raw-stdout fallback (unknown shape).
      const delta = result.parsedJson
        ? result.text
        : extractDelta(prevOutput, result.text, !!conversationId);

      if (conversationId) {
        prevOutputs.set(sessionId, result.text);
      } else {
        prevOutputs.delete(sessionId);
      }

      // Persist state so it survives process restarts.
      await store.set(
        sessionId,
        conversationId,
        conversationId ? callOpts.prompt.length : 0,
        conversationId ? result.text : "",
      );

      return {
        content: [{ type: "text" as const, text: delta }],
        finishReason: { unified: "stop" as const, raw: "stop" },
        usage: toV3Usage(result.usage),
        providerMetadata: {
          agy: {
            sessionId,
            conversationId: conversationId ?? null,
          },
        },
        response: {
          id: result.conversationId ?? randomUUID(),
          timestamp: new Date(),
          modelId,
        },
        warnings,
      };
    } finally {
      if (releaseBindingLock) {
        await releaseBindingLock();
      }
    }
  };

  const doStream = async (callOpts: LanguageModelV3CallOptions) => {
    const generatePromise = doGenerate(callOpts);

    let aborted = false;

    callOpts.abortSignal?.addEventListener("abort", () => {
      aborted = true;
    });

    const stream = new ReadableStream<LanguageModelV3StreamPart>({
      async start(controller) {
        try {
          controller.enqueue({
            type: "stream-start",
            warnings: [],
          });

          const result = await generatePromise;

          if (aborted) {
            controller.close();
            return;
          }

          const textContent = result.content.find(
            (c) => c.type === "text",
          );
          const text = textContent && "text" in textContent ? textContent.text : "";

          if (text) {
            controller.enqueue({
              type: "text-start",
              id: "agy-1",
            });
            controller.enqueue({
              type: "text-delta",
              id: "agy-1",
              delta: text,
            });
            controller.enqueue({
              type: "text-end",
              id: "agy-1",
            });
          }

          controller.enqueue({
            type: "finish",
            finishReason: result.finishReason,
            usage: result.usage,
          });

          controller.close();
        } catch (err) {
          controller.enqueue({ type: "error", error: err });
          controller.close();
        }
      },
      cancel() {
        // agy is one-shot; no real cancellation possible here
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
