import { describe, test, expect } from "bun:test";
import { detectPlanMode } from "../src/provider";

const u = (text: string) => ({ role: "user" as const, content: [{ type: "text" as const, text }] });
const a = (text: string) => ({ role: "assistant" as const, content: [{ type: "text" as const, text }] });

const PLAN_ON =
  "<system-reminder>\nYou are in Plan mode. Discuss the plan with the user directly in the conversation.\n</system-reminder>";
const PLAN_OFF =
  "<system-reminder>\nYou are NO LONGER in Plan mode. The previous Plan restrictions no longer apply.\n</system-reminder>";

describe("detectPlanMode (OpenCode <system-reminder> markers)", () => {
  test("no marker → not plan", () => {
    expect(detectPlanMode([u("hi")])).toBe(false);
  });

  test("plan reminder injected once stays active on later turns", () => {
    expect(detectPlanMode([u(PLAN_ON), u("q1"), a("r1"), u("q2")])).toBe(true);
  });

  test("leaving plan: the latest marker wins", () => {
    expect(detectPlanMode([u(PLAN_ON), u("q1"), a("r1"), u(PLAN_OFF), u("q2")])).toBe(false);
  });

  test("re-entering plan after build", () => {
    expect(detectPlanMode([u(PLAN_ON), a("r"), u(PLAN_OFF), a("r"), u(PLAN_ON), u("q")])).toBe(true);
  });
});
