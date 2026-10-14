// Manual end-to-end check against the real agy CLI (not run in CI).
// Usage: npm run build && AGY_BRIDGE_DEBUG=1 node scripts/smoke.mjs
import { createAgyProvider } from "../dist/provider.js";

const provider = createAgyProvider({ stateFile: "/tmp/agy-bridge-smoke/sessions.json" });
const model = provider("gemini-3.8-flash-high");
const sessionID = "smoke-" + Date.now();

async function turn(prompt, headers) {
  const t0 = Date.now();
  const { stream } = await model.doStream({ prompt, headers });
  const reader = stream.getReader();
  let text = "", deltas = 0, firstDeltaMs = null, finish = null;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    if (value.type === "text-delta") {
      deltas++; text += value.delta;
      if (firstDeltaMs === null) firstDeltaMs = Date.now() - t0;
    } else if (value.type === "finish") finish = value;
    else if (value.type === "error") throw value.error;
  }
  return { totalMs: Date.now() - t0, firstDeltaMs, deltas, text: text.slice(0, 120), finish };
}

const u = (t) => ({ role: "user", content: [{ type: "text", text: t }] });
const a = (t) => ({ role: "assistant", content: [{ type: "text", text: t }] });
// OpenCode 2.x sends the session natively in x-opencode-session.
const H = { "x-opencode-session": sessionID };

const r1 = await turn([u("Meu número favorito é 42. Responda só 'ok'.")], H);
console.log("TURN1", JSON.stringify(r1, null, 1));

const r2 = await turn([u("Meu número favorito é 42. Responda só 'ok'."), a(r1.text), u("Qual é meu número favorito? Responda só o número.")], H);
console.log("TURN2", JSON.stringify({ ...r2, finish: undefined }));

const r3 = await turn(
  [{ role: "system", content: "You are a title generator. You output ONLY a thread title. Nothing else." }, u("Explique o protocolo TCP")],
  H,
);
console.log("TITLE", JSON.stringify({ ...r3, finish: undefined }));
