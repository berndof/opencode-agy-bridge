# Roadmap / ideas

Ordered by expected value. Measurements come from `docs/OPENCODE-INTEGRATION.md`.

## 1. Persistent agy process per session (biggest latency win)

`--input-format stream-json` runs one turn per NDJSON line and keeps going while stdin
stays open. Probe result: turn 2 on the same process started in **134 ms** vs ~3 s of CLI
startup for a fresh spawn.

Design sketch:
- Pool keyed by OpenCode session; one live `agy` child per session, turns serialized.
- Read events until `{"event":"result"}` to delimit a turn.
- Respawn (with `--conversation`) on: model change, abort (kill — a turn can't be
  cancelled mid-way), crash, timeout.
- Idle kill after N minutes; cap the pool size; kill all on process exit.
- Optional pre-warm: spawn on session start so even turn 1 skips startup.

## 2. Detect compaction / summary helper calls

Find OpenCode 2.x's compaction prompt and treat it like the title call when appropriate,
or at least avoid persisting the summary turn into the main agy conversation.

## 3. Map agy failures to proper finish reasons

Today every successful turn reports `unified: "stop"`. Map agy `status` values
(`ERROR`, cancellation, max-tokens if exposed) to `error` / `length` / `other`, and
surface agy errors as `error` stream parts with useful messages.

## 4. Model catalog sync

`src/models.ts` mirrors `agy models` by hand. Add a script that runs `agy models` and
prints the OpenCode `models` block (and flags drift), so the config can be regenerated
when agy ships new models.

## 5. Images / file parts

agy's stream-json `content` array may accept more than `text`. Investigate; today file
parts are dropped with a warning.

## Dropped

- **Talking to the Antigravity IDE `language_server` over Connect/gRPC** (upstream's
  streaming research). No longer needed: `agy` stream-json streams deltas natively.
