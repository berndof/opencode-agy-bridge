import { describe, test, expect } from "bun:test";
import { extractDelta } from "../src/provider";

describe("extractDelta", () => {
  // JSON response mode (isJsonResponse = true): full text is the delta for this turn
  test("returns full text for JSON response (each turn is complete)", () => {
    expect(extractDelta("old response", "old response new part", true)).toBe("old response new part");
  });

  test("returns full text for JSON response even with prevOutput", () => {
    expect(extractDelta("turn one", "turn one\nturn two", true)).toBe("turn one\nturn two");
  });

  // Raw stdout fallback mode (isJsonResponse = false): prefix matching
  test("returns full text when prevOutput is empty (raw fallback)", () => {
    expect(extractDelta("", "any text", false)).toBe("any text");
  });

  test("strips prefix exactly (raw fallback)", () => {
    const prev = "turn one response\n";
    const full = "turn one response\nturn two response";
    expect(extractDelta(prev, full, false)).toBe("turn two response");
  });

  test("handles trailing newline mismatch (raw fallback)", () => {
    const prev = "turn one response\n";
    const full = "turn one response\n\n  turn two response";
    expect(extractDelta(prev, full, false)).toBe("  turn two response");
  });

  test("handles CRLF normalization (raw fallback)", () => {
    const prev = "line one\r\nline two";
    const full = "line one\nline two\nadded line";
    expect(extractDelta(prev, full, false)).toBe("added line");
  });

  test("finds prevOutput with prepended noise (concurrent agy, raw fallback)", () => {
    const prev = "previous response\n";
    const full = "WARNING: lock contention\nprevious response\nnew answer";
    expect(extractDelta(prev, full, false)).toBe("new answer");
  });

  test("finds prevOutput with prepended newlines and noise (raw fallback)", () => {
    const prev = "previous\nresponse";
    const full = "\n\nUpdate available: v2.0\n\nprevious\nresponse\nfresh content";
    expect(extractDelta(prev, full, false)).toBe("fresh content");
  });

  test("warns and returns full when prevOutput not found (raw fallback)", () => {
    const prev = "completely different text";
    const full = "something else entirely";
    expect(extractDelta(prev, full, false)).toBe("something else entirely");
  });

  test("handles exact match with no delta (raw fallback)", () => {
    const prev = "same text";
    const full = "same text";
    expect(extractDelta(prev, full, false)).toBe("");
  });

  test("handles prevOutput trimmed vs full text with trailing whitespace (raw fallback)", () => {
    const prev = "hello  ";
    const full = "hello  world";
    expect(extractDelta(prev, full, false)).toBe("world");
  });

  test("handles context truncation via last line alignment (raw fallback)", () => {
    const prev = "Hello! I can help you with that.\nLet me build a React application for you.\n";
    const full = "Let me build a React application for you.\nSure, here is the React code.";
    expect(extractDelta(prev, full, false)).toBe("Sure, here is the React code.");
  });

  test("handles context truncation via suffix alignment when last line is short (raw fallback)", () => {
    const prev = "Let me build a React application for you.\nOkay.\n";
    const full = "Let me build a React application for you.\nOkay.\nSure, here is the React code.";
    expect(extractDelta(prev, full, false)).toBe("Sure, here is the React code.");
  });

  test("tail matching with lastIndexOf avoids false match on repeated text (raw fallback)", () => {
    const prev =
      "Step 1: run tests. done.\n" +
      "Step 2: build project. done.\n" +
      "Step 3: deploy. done.\n";
    const full =
      "Step 1: run tests. done.\n" +
      "Step 2: build project. done.\n" +
      "Step 3: deploy. done.\n" +
      "NEW RESPONSE: All steps completed.";
    expect(extractDelta(prev, full, false)).toBe("NEW RESPONSE: All steps completed.");
  });

  test("tail matching handles truncated beginning (conversation grew too long, raw fallback)", () => {
    const marker = "UNIQUE_TAIL_".repeat(20);
    const longPrefix = "X".repeat(500);
    const prev = longPrefix + marker + "\n";

    const full = "...TRUNCATED...\n" + marker + "\nHere is the new response.";
    expect(extractDelta(prev, full, false)).toBe("Here is the new response.");
  });
});