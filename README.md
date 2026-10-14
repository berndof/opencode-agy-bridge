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
- Usage maps `thinking_tokens` → reasoning and `cache_read_tokens` → cache read.
- OpenCode's parallel **title** request runs as an isolated one-shot call on the `-low` variant.
- agy runs its own tools; OpenCode tool calls/results in the history are converted to text.

Details and gotchas: [`docs/OPENCODE-INTEGRATION.md`](docs/OPENCODE-INTEGRATION.md) ·
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
        "gemini-4-argon-high":      { "name": "Gemini 4 Argon (High)" },
        "gemini-4-argon-medium":    { "name": "Gemini 4 Argon (Medium)" },
        "gemini-4-argon-low":       { "name": "Gemini 4 Argon (Low)" },
        "gemini-3.8-flash-high":    { "name": "Gemini 3.8 Flash (High)" },
        "gemini-3.8-flash-medium":  { "name": "Gemini 3.8 Flash (Medium)" },
        "gemini-3.8-flash-low":     { "name": "Gemini 3.8 Flash (Low)" },
        "claude-opus-5-5-high":     { "name": "Claude Opus 5.5 (High)" },
        "claude-opus-5-5-medium":   { "name": "Claude Opus 5.5 (Medium)" },
        "claude-opus-5-5-low":      { "name": "Claude Opus 5.5 (Low)" },
        "claude-sonnet-5-5-high":   { "name": "Claude Sonnet 5.5 (High)" },
        "claude-sonnet-5-5-medium": { "name": "Claude Sonnet 5.5 (Medium)" },
        "claude-sonnet-5-5-low":    { "name": "Claude Sonnet 5.5 (Low)" },
        "gpt-oss-120b-medium":      { "name": "GPT-OSS 120B (Medium)" }
      }
    }
  }
}
```

Model ids are exactly those of `agy models` and are passed verbatim to `agy --model`.
Old ids (`claude-sonnet-5.5-high`, `gemini-3.1-pro`, `gemini-3.6-*`) still resolve but
aren't listed. No `plugin` entry is needed on OpenCode 2.x.

**After every rebuild, restart OpenCode** — the server keeps the old module in memory.
Quick check without touching a running session:

```bash
opencode run --standalone --model agy/gemini-3.8-flash-low "say ok"
```

### Provider options

| Option | Default | Description |
|---|---|---|
| `binary` | `"agy"` | agy executable |
| `timeoutMs` | `300000` | per-turn timeout |
| `defaultModel` | `gemini-3.8-flash-high` | model for the `antigravity` alias |
| `extraArgs` | `[]` | extra agy flags (e.g. `["--sandbox"]`) |
| `stateFile` | `~/.opencode-agy-bridge/sessions.json` | session → conversation map |
| `enableToolConversion` | `true` | render tool calls/results in history as text |

## Debugging

```bash
AGY_BRIDGE_DEBUG=1 opencode      # per-phase timings, session/mode decisions
tail -f ~/.opencode-agy-bridge/debug.log
```

OpenCode's own log: `~/.local/share/opencode/log/opencode.log`.

## Known limitations

- **agy tool permissions (headless):** agy runs its own tools, but in headless mode it
  **auto-denies** any tool that would need an approval prompt and ends the turn with no
  text. The bridge shows agy's explanation instead of an empty reply, and lists agy's tool
  steps as reasoning blocks. To let agy use tools, either add allow-rules to
  `~/.gemini/antigravity-cli/settings.json` (`permissions.allow`, e.g. `"command(git log)"`
  — shared with every agy session), or pass `"extraArgs": ["--dangerously-skip-permissions"]`
  in the provider options (auto-approves everything, only for OpenCode-launched agy).
- **Startup latency:** each turn spawns a fresh `agy` (≈3–5 s before the model starts).
  A persistent per-session process is planned ([roadmap](docs/ROADMAP.md)).
- **No structured tool calls:** agy uses its own tools inside its process.
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
