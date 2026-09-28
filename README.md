# opencode-agy-bridge

OpenCode plugin + provider that routes LLM prompts to `agy` (Google Antigravity CLI).

> **Fork of [`raultov/opencode-agy-bridge`](https://github.com/raultov/opencode-agy-bridge)** (MIT).
> This fork (`0.2.9-fork.0`) adds LanguageModelV3 support, `--model` routing, JSON output parsing,
> real usage metrics and English prompt framing. It is **not published to npm** — install it from
> this repository (see [Build from source](#build-from-source) + [Local development](#local-development-absolute-paths)).
> The upstream `0.2.8` package remains available as a rollback option.

## How it works

```
opencode TUI
  └─ /model → select agy/gemini-3.6-flash-low (or agy/antigravity)
      └─ you type a prompt
          └─ provider spawns: agy --add-dir <cwd> [--conversation <id>] [--model <modelId>] --input-format stream-json --output-format stream-json
              └─ prompt travels on stdin as NDJSON: {"event":"user","message":{...}}
              └─ agy → Google Antigravity backend → Gemini
                  └─ stdout (NDJSON events; final {"event":"result"} carries response + token usage)
              └─ provider parses JSON payload / extracts delta vs previous turn
          └─ stream-start → text-start → text-delta → text-end → finish (with usage) → opencode renders
```

## Fork Enhancements

This fork introduces key architectural upgrades and enhancements:

- **Migration to LanguageModelV3 / ProviderV3:** Fully updated to the `@ai-sdk/provider` V3 specification (`LanguageModelV3`, `ProviderV3`) for first-class compatibility with modern OpenCode and Vercel AI SDK v3.
- **Model Routing (`--model` support):** Explicit model IDs configured in OpenCode (such as `gemini-3.6-flash-low`, `gemini-3.6-flash-medium`, `gemini-3.6-flash-high`) are passed directly via `--model` to the `agy` CLI. Cosmetic aliases like `antigravity` seamlessly fall back to `defaultModel` (default: `gemini-3.6-flash-low`).
- **Structured Output & Usage Metrics:** Runs `agy` in stream-json mode (`--input-format stream-json --output-format stream-json`), reading the authoritative `result` event for conversation IDs and token usage metrics (`inputTokens`, `outputTokens`, `totalTokens`). Falls back gracefully to raw stdout for unparsed responses.
- **Preserved System Instructions & Technical English Context:** Preserves system prompt messages at the top of context blocks and standardizes multi-turn prompt framing using clean English delimiters (`[Previous conversation context]`, `[End of context]`, `Current request:`).
- **Stdin NDJSON Prompt Delivery:** Passes the prompt over stdin instead of argv. Linux caps a single argument at 128 KiB (`MAX_ARG_STRLEN`) and raises `E2BIG` beyond that, which long agent sessions hit routinely; stdin has no such limit.

## Prerequisites

1. **`agy` installed and authenticated** — run `agy` standalone at least once to complete OAuth.
2. **Node.js ≥ 18** or **Bun ≥ 1.0**.
3. **OpenCode** `>= 1.15.x` (uses Vercel AI SDK v3).

## Installation

> **This fork is consumed from a local path**, not from npm (see fork note above). The npm-based
> options below (`opencode-agy-bridge@<version>`) refer to the **upstream** package and are kept
> for reference/rollback only. CI publishing is disabled in this fork (`release.yml` validates
> builds on tags without calling `npm publish`).

### Build from source (recommended for this fork)

```bash
git clone https://github.com/berndof/opencode-agy-bridge.git
cd opencode-agy-bridge
bun install && bun run build && bun test
```

Then wire the local paths in `~/.config/opencode/opencode.json` — see
[Local development](#local-development-absolute-paths).

### Upstream (npm, reference only)

```bash
npm install -g opencode-agy-bridge   # upstream package, version 0.2.8
```

## Configuration

Add the plugin and provider to `~/.config/opencode/opencode.json`.

> The **node.js** path represents a **package** (directory or npm package name), not a `.js` file. Pointing `"npm"` at a `.js` file will cause a `ProviderInitError` because opencode internally appends `/provider` to resolve the exports map.

### Upstream npm variant (reference/rollback)

```jsonc
{
  "plugin": [
    "opencode-agy-bridge@0.2.8"
  ],
  "provider": {
    "agy": {
      "npm": "opencode-agy-bridge",
      "name": "Google Antigravity (via agy CLI)",
      "options": {
        "binary": "agy",
        "timeoutMs": 300000,
        "defaultModel": "gemini-3.6-flash-low"
      },
      "models": {
        "gemini-3.6-flash-low": { "name": "Gemini 3.6 Flash Low (Fast)" },
        "gemini-3.6-flash-medium": { "name": "Gemini 3.6 Flash Medium" },
        "gemini-3.6-flash-high": { "name": "Gemini 3.6 Flash High (Deep Thinking)" },
        "antigravity": { "name": "Antigravity (Default)" }
      }
    }
  }
}
```

### Local development (absolute paths)

> This is the **recommended setup for this fork**: `plugin` points at the built entry file and
> `provider.npm` at the package directory (opencode resolves `/provider` from its exports map).

```jsonc
{
  "plugin": [
    "/home/USER/workspace/opencode-agy-bridge/dist/plugin.js"
  ],
  "provider": {
    "agy": {
      "npm": "/home/USER/workspace/opencode-agy-bridge",
      "name": "Google Antigravity (via agy CLI)",
      "options": {
        "binary": "agy",
        "timeoutMs": 300000,
        "defaultModel": "gemini-3.6-flash-low"
      },
      "models": {
        "gemini-3.6-flash-low": { "name": "Gemini 3.6 Flash Low" },
        "gemini-3.6-flash-high": { "name": "Gemini 3.6 Flash High" },
        "antigravity": { "name": "Antigravity (Default)" }
      }
    }
  }
}
```

Then restart OpenCode and run `/model` → select `agy/gemini-3.6-flash-low` or your preferred model.

## Features

- **LanguageModelV3 Provider:** Adheres to the latest AI SDK standard with full lifecycle stream events (`stream-start`, `text-start`, `text-delta`, `text-end`, `finish`).
- **Token Usage Reporting:** Emits real token metrics (`inputTokens`, `outputTokens`, `totalTokens`) parsed from `agy` JSON output.
- **Model Selection & Passthrough:** Full support for selecting Antigravity models directly from OpenCode.
- **Robust Delta Extraction:** Automatically normalizes `\r\n` (CRLF) and `\n` (LF) line endings, tolerates trailing whitespace/newline differences, and implements suffix-based alignment to support seamless recovery during context window truncation when fallback parsing raw output.
- **Session Persistence Across Restarts:** Multi-turn conversation state survives OpenCode restarts via `~/.opencode-agy-bridge/sessions.json`.
- **Global Binding Lock:** Prevents race conditions when multiple OpenCode instances initialize concurrently.

## Known limitations

| Limitation | Detail |
|---|---|
| **No real streaming** | `agy` CLI buffers the full response and emits it on completion. Tokens appear in one batch, not one-by-one. The provider emits a single `text-delta` per turn inside standard V3 streaming lifecycle parts. |
| **Requires authenticated `agy`** | You must run `agy` standalone at least once to authenticate via OAuth. |
| **No tool-call passthrough** | `agy` CLI does not return structured tool calls to the caller. Tool use happens inside agy's own process. |
| **Per-turn subprocess** | Each prompt spawns a fresh `agy` process. Context is preserved via `--conversation <id>`. |
| **Images/file parts omitted** | OpenCode messages with image/file content parts are skipped with a warning — `agy` CLI does not support them. |

## Roadmap

### v0.x — Current

- **Unified plugin + provider entry point** — single npm package that OpenCode auto-detects as both plugin and provider.
- **LanguageModelV3 & ProviderV3 support** — full integration with Vercel AI SDK v3.
- **JSON output parsing & usage metrics** — reliable execution and token accounting.
- **Model routing** — custom model ID routing to `--model`.
- **Robust delta extraction** — end-of-line normalization (`\r\n` ↔ `\n`), whitespace-tolerant alignment, suffix fallback.
- **Session persistence across restarts** — conversation state survives OpenCode restarts via `~/.opencode-agy-bridge/sessions.json`.
- **Conversation binding via JSON / `.pb` diffing** — automatically discovers the `conversation_id` created by `agy`.
- **Global binding lock** — prevents race conditions when multiple OpenCode instances run concurrently.

### Future — Real streaming (see [`specs/docs/STREAMING_RESEARCH.md`](specs/docs/STREAMING_RESEARCH.md))

The current bridge relies on `agy`, which buffers the full response before emitting it. Investigation has confirmed that the Antigravity **IDE binary** hosts a Connect/gRPC-JSON server (`language_server`) with streaming RPCs (`StreamCascadeReactiveUpdates`, `StreamCascadeSummariesReactiveUpdates`, `StreamAgentStateUpdates`) that deliver token-by-token output.

A future v2 could bypass `agy` CLI entirely and speak directly to a language_server instance (either the one the IDE already runs, or one the plugin spawns itself), providing real progressive streaming instead of single-batch `text-delta` delivery. Estimated effort: ~2 weeks. Blocked pending proto reverse-engineering and ToS review.

## Project structure

```
src/
├── agy-runner.ts           # spawn agy in stream-json mode, prompt via stdin NDJSON
├── conversation-tracker.ts # snapshot .pb files, infer conversation_id fallback
├── session-store.ts        # persist session→conversation_id mapping
├── prompt-mapper.ts        # Vercel AI SDK prompt → formatted plain text
├── provider.ts             # LanguageModelV3 implementation (core)
└── plugin.ts               # OpenCode plugin entrypoint (hooks)
```

## Development

```bash
bun run build   # compile TypeScript
bun test        # run test suite
```
