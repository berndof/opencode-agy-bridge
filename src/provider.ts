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

interface PreparedAgyCall {
  sessionId: string;
  conversationId: string | null;
  before: Set<string> | null;
  prompt: string;
  warnings: SharedV3Warning[];
  entry: Awaited<ReturnType<SessionStore["getEntry"]>>;
  releaseBindingLock: (() => Promise<void>) | null;
}

function buildLanguageModel(
  modelId: string,
  opts: AgyProviderOptions,
): LanguageModelV3 {
  const store = new SessionStore(opts.stateFile);
  const conversationsDir = opts.conversationsDir ?? defaultConversationsDir();

  const prepareAgyCall = async (callOpts: LanguageModelV3CallOptions): Promise<PreparedAgyCall> => {
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

    try {
      const before = conversationId ? null : await snapshot(conversationsDir);

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

      return {
        sessionId,
        conversationId,
        before,
        prompt,
        warnings,
        entry,
        releaseBindingLock,
      };
    } catch (err) {
      if (releaseBindingLock) {
        await releaseBindingLock();
      }
      throw err;
    }
  };

  const finalizeAgyCall = async (
    prep: PreparedAgyCall,
    result: Awaited<ReturnType<typeof runAgy>>,
    promptLength: number,
  ): Promise<{ conversationId: string | null; delta: string }> => {
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

    // Restore prevOutput from persisted store (survives restarts).
    // In-memory cache takes priority (faster, has latest turn data).
    let prevOutput = prevOutputs.get(prep.sessionId) ?? "";
    if (!prevOutput && prep.entry?.prevOutput) {
      prevOutput = prep.entry.prevOutput;
      prevOutputs.set(prep.sessionId, prevOutput);
    }

    // JSON responses are per-turn: the new text IS the delta. Only apply
    // heuristic delta extraction for raw-stdout fallback (unknown shape).
    const delta = result.parsedJson
      ? result.text
      : extractDelta(prevOutput, result.text, !!conversationId);

    if (conversationId) {
      prevOutputs.set(prep.sessionId, result.text);
    } else {
      prevOutputs.delete(prep.sessionId);
    }

    // Persist state so it survives process restarts.
    await store.set(
      prep.sessionId,
      conversationId,
      conversationId ? promptLength : 0,
      conversationId ? result.text : "",
    );

    return { conversationId, delta };
  };

  const doGenerate = async (callOpts: LanguageModelV3CallOptions) => {
    const prep = await prepareAgyCall(callOpts);
    try {
      const result = await runAgy({
        prompt: prep.prompt,
        cwd: process.cwd(),
        conversationId: prep.conversationId ?? undefined,
        model: resolveAgyModel(modelId, opts),
        binary: opts.binary,
        extraArgs: opts.extraArgs,
        timeoutMs: opts.timeoutMs,
        abortSignal: callOpts.abortSignal,
      });

      const { conversationId, delta } = await finalizeAgyCall(prep, result, callOpts.prompt.length);

      return {
        content: [{ type: "text" as const, text: delta }],
        finishReason: { unified: "stop" as const, raw: "stop" },
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
    } finally {
      if (prep.releaseBindingLock) {
        await prep.releaseBindingLock();
      }
    }
  };

  const doStream = async (callOpts: LanguageModelV3CallOptions) => {
    const textId = "agy-1";

    const stream = new ReadableStream<LanguageModelV3StreamPart>({
      async start(controller) {
        let prep: PreparedAgyCall | null = null;
        try {
          prep = await prepareAgyCall(callOpts);

          controller.enqueue({
            type: "stream-start",
            warnings: prep.warnings,
          });

          let textStarted = false;
          let streamedText = "";

          const result = await runAgy({
            prompt: prep.prompt,
            cwd: process.cwd(),
            conversationId: prep.conversationId ?? undefined,
            model: resolveAgyModel(modelId, opts),
            binary: opts.binary,
            extraArgs: opts.extraArgs,
            timeoutMs: opts.timeoutMs,
            abortSignal: callOpts.abortSignal,
            onTextDelta: (delta: string) => {
              if (callOpts.abortSignal?.aborted) return;
              if (!textStarted) {
                textStarted = true;
                controller.enqueue({
                  type: "text-start",
                  id: textId,
                });
              }
              streamedText += delta;
              controller.enqueue({
                type: "text-delta",
                id: textId,
                delta,
              });
            },
          });

          if (callOpts.abortSignal?.aborted) {
            controller.close();
            return;
          }

          const { conversationId, delta } = await finalizeAgyCall(prep, result, callOpts.prompt.length);

          controller.enqueue({
            type: "response-metadata",
            id: result.conversationId ?? randomUUID(),
            timestamp: new Date(),
            modelId,
          });

          if (textStarted) {
            // If the final parsed delta has additional characters not captured by stream
            if (delta.length > streamedText.length && delta.startsWith(streamedText)) {
              const remaining = delta.slice(streamedText.length);
              if (remaining) {
                controller.enqueue({
                  type: "text-delta",
                  id: textId,
                  delta: remaining,
                });
              }
            }
            controller.enqueue({
              type: "text-end",
              id: textId,
            });
          } else if (delta) {
            // Fallback: agy did not emit streaming deltas (e.g. mock or plain text), emit full text
            controller.enqueue({
              type: "text-start",
              id: textId,
            });
            controller.enqueue({
              type: "text-delta",
              id: textId,
              delta,
            });
            controller.enqueue({
              type: "text-end",
              id: textId,
            });
          }

          controller.enqueue({
            type: "finish",
            finishReason: { unified: "stop" as const, raw: "stop" },
            usage: toV3Usage(result.usage),
          });

          controller.close();
        } catch (err) {
          if (callOpts.abortSignal?.aborted) {
            controller.close();
            return;
          }
          controller.enqueue({ type: "error", error: err });
          controller.close();
        } finally {
          if (prep?.releaseBindingLock) {
            await prep.releaseBindingLock();
          }
        }
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
