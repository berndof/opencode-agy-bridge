# Permissions and effort control — evaluation

Status: Plan-mode enforcement (option D) **implemented**; effort via ctrl+t **designed, not implemented**. Facts below were verified on OpenCode 2.0.16 and the
current agy CLI (2026-10-14).

## Verified facts

| # | Fact | How verified |
|---|---|---|
| F1 | In headless mode agy **auto-denies** any tool that would need an approval prompt; the turn ends `SUCCESS` with empty text, reason only on stderr. | stream-json run asking for `run_command` |
| F2 | agy's stream-json has no permission request/response protocol (closed vocabulary `init` / `step_update` / `result`; stdin only takes `user` messages). | binary strings + changelog |
| F3 | OpenCode's AI SDK adapter **drops** `tool-approval-request` stream parts. | `cm()` in the OpenCode bundle: `case "tool-approval-request": return []` |
| F4 | OpenCode does render provider-executed `tool-call` / `tool-result` parts (`providerExecuted: true`). | same adapter |
| F5 | The selected **model variant** (ctrl+t, `/variants`, `-m provider/model#variant`) is merged into `providerOptions.agy` on every call. | variant `{ "effort": "high" }` arrived as `providerOptions.agy.effort` |
| F6 | `agent.<name>.options` does **not** reach the provider. | probe on the `build` agent |
| F7 | Plan and Build send the same system prompt, but OpenCode injects `<system-reminder>` **user messages**: `You are in Plan mode.` once when Plan starts, `You are NO LONGER in Plan mode.` when leaving it. | `AGY_BRIDGE_DEBUG=2` dump of user messages |
| F8 | `agy --mode plan` does not modify the workspace even with `--dangerously-skip-permissions`: it writes a plan artifact and asks for confirmation. | asked it to create a file → only `plan.md` artifact |
| F9 | agy merges project configs from `~/.gemini/config/projects/` over the global `~/.gemini/antigravity-cli/settings.json` (shared by every agy session, incl. the Antigravity CLI). | agy changelog |
| F10 | `agy models` ids embed the effort (`gemini-4-argon-low|medium|high`); agy also accepts `--effort low|medium|high|xhigh|max`. | `agy models`, `agy --help` |

## 1. Effort via ctrl+t (variants)

**Feasible now** (F5, F10).

Config — one OpenCode model per family, effort as variants:

```jsonc
"gemini-4-argon": {
  "name": "Gemini 4 Argon",
  "variants": {
    "low":    { "effort": "low" },
    "medium": { "effort": "medium" },
    "high":   { "effort": "high" }
  }
}
```

Bridge change (small):

```ts
const effort = callOpts.providerOptions?.agy?.effort ?? opts.defaultEffort;   // e.g. "medium"
const candidate = `${modelId}-${effort}`;
model = KNOWN_MODEL_IDS.has(candidate) ? candidate : resolveAgyModelSpec(modelId).model;
```

- Families: `gemini-4-argon`, `gemini-3.8-flash`, `claude-opus-5-5`, `claude-sonnet-5-5`
  (low/medium/high) and `gpt-oss-120b` (medium only → no variants).
- Full ids (`gemini-4-argon-high`) keep working, so old sessions/configs don't break.
- Title calls keep forcing `-low`.
- **To verify:** switching variant mid-session resumes the same agy conversation with a
  different `--model` (expected to work; agy conversations aren't model-bound).

## 2. Permissions

What is **not** possible today: OpenCode approving each agy tool call interactively. agy
can't ask a driver (F2) and OpenCode ignores provider approval requests (F3). This would
need an agy feature (a stream-json `permission_request` event + stdin reply).

agy's tools run inside the agy process, so OpenCode's `permission` rules and its Plan
agent **don't apply** to them.

### Options

| Option | Control | Effort | Notes |
|---|---|---|---|
| A. Global skip (current: `extraArgs: ["--dangerously-skip-permissions"]`) | none | done | Everything auto-approved, also in Plan. |
| B. Policy as a **variant option** | per call, from the UI | small | Variants are the only per-call UI knob (F5). E.g. `high` = skip, `high-plan` = `--mode plan`. Doubles the variant list. |
| C. Policy per **model entry** | per model pick | small | e.g. `gemini-4-argon` (skip) and `gemini-4-argon-plan` (`--mode plan`), via a model option `"permission": "skip" \| "plan" \| "ask"`. |
| D. Follow OpenCode's Plan agent automatically | automatic | **implemented** | Latest reminder marker in the history (F7) → `--mode plan` (F8). Verified: Plan refused to create a file; switching to Build in the same session created it. |
| E. Project allow-rules generated from OpenCode `permission` config | per project, per command | medium | Write agy project config (F9) with `command(<prefix>)` rules mirroring OpenCode's `bash` allow list; leave the rest denied (agy then explains, the bridge shows it). No global side effects. |
| F. Show agy tools as real tool cards | visibility only | small | Emit provider-executed `tool-call`/`tool-result` (F4) instead of reasoning text. Pairs with any option above. |

### Current setup

`extraArgs: ["--dangerously-skip-permissions"]` (A) **plus** automatic `--mode plan` while
OpenCode's Plan agent is active (D). Build runs unrestricted; Plan is enforced by agy itself.

Before D, agy already *declined* edits in Plan because the reminder text reached it, but that
was only an instruction. `--mode plan` makes it a hard block.

### Further options

1. **C + F**. Each model picks a policy through an option resolved in the bridge:
   - `skip` → `--dangerously-skip-permissions`
   - `plan` → `--mode plan` (safe, verified F8)
   - `ask` → no flag (agy denies; the bridge shows why)

   Default `skip`, plus `-plan` entries for read-only work. Tool cards (F) make it visible
   what agy did.
3. **E** if you want per-command control without the global settings file.
