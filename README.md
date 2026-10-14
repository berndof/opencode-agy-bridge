# opencode-agy-bridge

[OpenCode](https://opencode.ai) provider that routes LLM calls to **`agy`** (Google Antigravity CLI),
so you can use your Antigravity models (Gemini, Claude, GPT-OSS) from OpenCode.

> Fork of [`raultov/opencode-agy-bridge`](https://github.com/raultov/opencode-agy-bridge) (MIT),
> targeting **OpenCode 2.x**. Not published to npm — consumed from a local checkout.

## How it works

```
OpenCode ──LanguageModelV3──▶ provider ──spawn──▶ agy --model <id> --conversation <id>
                                                     --input-format stream-json --output-format stream-json
            ◀── text-delta (live) ───── step_update events ◀──┘
            ◀── finish (usage incl. reasoning) ── result event
```

- One agy **conversation per OpenCode session** (keyed by OpenCode's `x-opencode-session`
  header; mapping persisted in `~/.opencode-agy-bridge/sessions.json`). Only the newest user
  message is sent each turn — agy keeps the history.
- Responses **stream live** from agy's `step_update` deltas.
- agy's internal tool steps (`run_command`, `view_file`, …) are emitted as **provider-executed
  tool cards** (`tool-call` + `tool-result` with `providerExecuted: true`).
- **Effort variants (`ctrl+t` / `/variants`)**: base family model ids (`gemini-4-argon`,
  `claude-sonnet-5-5`, …) resolve the selected `effort` variant (`low` / `medium` / `high`)
  from `providerOptions.agy.effort`.
- Usage maps `thinking_tokens` → reasoning and `cache_read_tokens` → cache read.
- OpenCode's parallel **title** request runs as an isolated one-shot call on the `-low` variant.
- OpenCode's **Plan** agent is enforced: while it is active agy runs with `--mode plan`
  (no workspace edits), detected from OpenCode's `<system-reminder>` messages.
- agy runs its own tools; OpenCode tool calls/results in the history are converted to text.

Details and gotchas: [`docs/OPENCODE-INTEGRATION.md`](docs/OPENCODE-INTEGRATION.md) ·
permissions & effort: [`docs/PERMISSIONS-AND-EFFORT.md`](docs/PERMISSIONS-AND-EFFORT.md) ·
ideas: [`docs/ROADMAP.md`](docs/ROADMAP.md).

## Requirements

- `agy` installed and authenticated (run `agy` once).
- Node.js ≥ 18 (build) — OpenCode runs the provider with its bundled Bun.
- OpenCode 2.x.

## Install

```bash
git clone https://github.com/berndof/opencode-agy-bridge.git ~/workspace/opencode-agy-bridge
cd ~/workspace/opencode-agy-bridge
npm install && npm run build
```

## Configure OpenCode

`~/.config/opencode/opencode.jsonc`:

```jsonc
{
  "provider": {
    "agy": {
      "name": "Google Antigravity (via agy CLI)",
      // file:// URL to the package DIRECTORY. A bare "opencode-agy-bridge" makes OpenCode
      // download upstream 0.2.8 from npm instead of using this fork.
      "npm": "file:///home/USER/workspace/opencode-agy-bridge",
      "options": {
        "binary": "agy",
        "timeoutMs": 300000,
        "defaultModel": "gemini-3.8-flash-high"   // used by the "antigravity" alias
      },
      "models": {
        // Option A: one entry per family with ctrl+t effort variants
        "gemini-4-argon": {
          "name": "Gemini 4 Argon",
          "variants": {
            "low":    { "effort": "low" },
            "medium": { "effort": "medium" },
            "high":   { "effort": "high" }
          }
        },
        "gemini-3.8-flash": {
          "name": "Gemini 3.8 Flash",
          "variants": {
            "low":    { "effort": "low" },
            "medium": { "effort": "medium" },
            "high":   { "effort": "high" }
          }
        },
        "claude-opus-5-5": {
          "name": "Claude Opus 5.5",
          "variants": {
            "low":    { "effort": "low" },
            "medium": { "effort": "medium" },
            "high":   { "effort": "high" }
          }
        },
        "claude-sonnet-5-5": {
          "name": "Claude Sonnet 5.5",
          "variants": {
            "low":    { "effort": "low" },
            "medium": { "effort": "medium" },
            "high":   { "effort": "high" }
          }
        },
        "gpt-oss-120b": { "name": "GPT-OSS 120B" }
      }
    }
  }
}
```

Both base family ids (`gemini-4-argon` with `variants`) and full `agy models` ids
(`gemini-4-argon-high`, `gemini-4-argon-medium`, `gemini-4-argon-low`, …) are supported.
Old ids (`claude-sonnet-5.5-high`, `gemini-3.1-pro`, `gemini-3.6-*`) still resolve too.
No `plugin` entry is needed on OpenCode 2.x.

**After every rebuild, restart OpenCode** — the server keeps the old module in memory.
Quick check without touching a running session:

```bash
opencode run --standalone --model agy/gemini-3.8-flash-low "say ok"
```

### Provider options

| Option | Default | Description |
|---|---|---|
| `binary` | `"agy"` | agy executable |
| `timeoutMs` | `300000` | inactivity timeout (no agy output for this long kills the turn) |
| `defaultModel` | `gemini-3.8-flash-high` | model for the `antigravity` alias |
| `defaultEffort` | `"high"` | fallback effort (`low`\|`medium`\|`high`) for base family models |
| `extraArgs` | `[]` | extra agy flags (e.g. `["--sandbox"]`) |
| `stateFile` | `~/.opencode-agy-bridge/sessions.json` | session → conversation map |
| `enableToolConversion` | `true` | render tool calls/results in history as text |
| `emitToolCards` | `true` | emit agy tool steps as `providerExecuted` tool cards (`false` = reasoning blocks) |

## Debugging

```bash
AGY_BRIDGE_DEBUG=1 opencode      # per-phase timings, session/mode decisions, tool steps
AGY_BRIDGE_DEBUG=2 opencode      # + full system prompts / message lists (system-prompts.log, user-messages.log)
tail -f ~/.opencode-agy-bridge/debug.log
```

OpenCode's own log: `~/.local/share/opencode/log/opencode.log`.

## Known limitations

- **agy tool permissions (headless):** agy runs its own tools, but in headless mode it
  **auto-denies** any tool that would need an approval prompt and ends the turn with no
  text. The bridge shows agy's explanation instead of an empty reply, and emits agy's tool
  steps as provider-executed tool cards. To let agy use tools, either add allow-rules to
  `~/.gemini/antigravity-cli/settings.json` (`permissions.allow`, e.g. `"command(git log)"`
  — shared with every agy session), or pass `"extraArgs": ["--dangerously-skip-permissions"]`
  in the provider options (auto-approves everything, only for OpenCode-launched agy; the
  Plan agent still blocks edits via `--mode plan`). See
  [`docs/PERMISSIONS-AND-EFFORT.md`](docs/PERMISSIONS-AND-EFFORT.md).
- **Startup latency:** each turn spawns a fresh `agy` (≈3–5 s before the model starts).
  A persistent per-session process is planned ([roadmap](docs/ROADMAP.md)).
- **No client-executed tool calls:** agy uses its own tools inside its process (rendered as provider-executed tool cards).
- **No images/files:** file parts are dropped with a warning.
- **Finish reason** is always `stop` on success.

## Development

```bash
npm run build            # tsc → dist/
bun test                 # unit tests (CI runs build + tests on push/PR)
AGY_BRIDGE_DEBUG=1 node scripts/smoke.mjs   # manual end-to-end check with real agy
```

```
src/
├── provider.ts             # LanguageModelV3: sessions, streaming, usage
├── agy-runner.ts           # spawn agy (stream-json over stdin/stdout)
├── models.ts               # model catalog (mirrors `agy models`) + legacy aliases
├── session-store.ts        # session → conversation persistence
├── conversation-tracker.ts # fallback conversation discovery (.db files)
├── prompt-mapper.ts        # legacy prompt flattening
├── index.ts                # package entry (provider factory; 1.x plugin shim)
└── plugin.ts               # OpenCode 1.x plugin (chat.headers) — unused on 2.x
```
