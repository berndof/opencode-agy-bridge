# OpenCode 2.x integration notes

What we learned wiring this bridge into **OpenCode 2.0.x** (verified against 2.0.16 and
agy CLI with `stream-json`). Keep this updated when OpenCode or agy changes behaviour.

## 1. Loading: always point at the local checkout

OpenCode resolves `provider.<id>.npm` by **installing from the npm registry** into
`~/.cache/opencode/npm/<name>@latest/`. With `"npm": "opencode-agy-bridge"` it silently
runs the **upstream 0.2.8** package, not this fork — symlinks in `~/.config/opencode/node_modules`
are ignored.

Use a `file://` URL to the package **directory** (not a `.js` file):

```jsonc
"npm": "file:///home/USER/workspace/opencode-agy-bridge"
```

The running OpenCode server keeps the module in memory: after `npm run build`, restart
OpenCode (the TUI spawns `opencode serve --service` as a child). For one-off checks,
`opencode run --standalone ...` starts a private server with the fresh build.

## 2. The plugin is not needed (and does not load) on 2.x

- OpenCode 2.x removed the `chat.headers` hook (the v2 plugin API is `{ id, setup(ctx) }`).
- Plugin specs like `opencode-agy-bridge/plugin` are treated as a **GitHub shorthand** →
  `NpmInstallFailedError: An unknown git error occurred`.
- Local plugin paths must be directories (`configured plugin path must be a directory`).

It isn't needed because OpenCode 2.x sends the session natively on every call:

| Header | Value |
|---|---|
| `x-opencode-session` / `X-Session-Id` / `x-session-affinity` | `ses_…` (OpenCode session id) |
| `x-opencode-project` | project hash |
| `x-opencode-client` | `cli` / `tui` |

The bridge keys agy conversations by `x-opencode-session` (falls back to the legacy
`x-agy-session-id`, then to a hash of the first user message). `src/plugin.ts` is kept only
for OpenCode 1.x.

## 3. Finish reason → `LLM.Event.StepFinish`

OpenCode consumes the raw `LanguageModelV3` stream and maps:

```js
reason: { normalized: f.finishReason.unified === "other" ? "unknown" : f.finishReason.unified,
          raw: f.finishReason.raw }
```

`finishReason.unified` is **mandatory**. A missing `unified` (or a V2-style string
`finishReason: "stop"`, as in upstream 0.2.8) yields
`Schema validation failed … path ["reason","normalized"]`.

## 4. Usage

agy's `usage` (both on the final `step_update` and the `result` event):

```json
{"input_tokens":11841,"output_tokens":595,"thinking_tokens":476,"cache_read_tokens":0,"total_tokens":12436}
```

`output_tokens` **includes** `thinking_tokens` (input + output = total), which matches V3:
`outputTokens.total = 595`, `.reasoning = 476`, `.text = 119`;
`inputTokens.cacheRead = cache_read_tokens`, `.noCache = input − cacheRead`.
OpenCode reads `outputTokens.reasoning` as `reasoningTokens`.

## 5. Helper calls (title generation)

For each new session OpenCode fires a **title** request in parallel with the main turn,
with the same session header. Providers aren't told the agent name, so the bridge detects
it by the system prompt (`You are a title generator…`) and runs it as an **ephemeral**
one-shot call: full prompt, `-low` model variant, no session binding. Otherwise both calls
race on the same agy conversation and the title turn pollutes the history.

Compaction/summary prompts are not detected yet — they run as normal turns in the same
agy conversation (agy already has the full history, so the result is still correct).

## 6. agy `stream-json` protocol (what the runner relies on)

```
{"event":"init","conversation_id":"…","init":{"model":"…","tools":[…]}}
{"event":"step_update","step_update":{"conversation_id":"…","step_type":"user_input","state":"DONE"}}
{"event":"step_update","step_update":{"step_type":"agent_response","state":"ACTIVE","text_delta":"…"}}   (many)
{"event":"step_update","step_update":{"step_type":"agent_response","state":"DONE","text_delta":"…","usage":{…}}}
{"event":"result","result":{"conversation_id":"…","status":"SUCCESS","response":"…","usage":{…}}}
```

- Real token streaming works (≈20–30 ms between deltas). The old "agy buffers the whole
  response" premise no longer holds.
- `conversation_id` arrives on the very first line → no global lock / directory diffing
  is needed to bind a session (the `.db` snapshot is only a fallback).
- Thinking **text** is not exposed — only `thinking_tokens`.
- Model ids from `agy models` are accepted verbatim by `--model` (the effort variant is
  part of the id, e.g. `claude-sonnet-5-5-medium`).

## 7. Latency profile (gemini-3.8-flash, cold process per turn)

| Phase | Typical |
|---|---|
| spawn → `init` (CLI startup) | 2.6 – 5.6 s |
| `init` → first delta (model) | 2 – 8 s (depends on effort/thinking) |
| streaming | < 1 s for short answers |

Run with `AGY_BRIDGE_DEBUG=1` to get per-phase timings in
`~/.opencode-agy-bridge/debug.log`.
