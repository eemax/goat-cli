import { describe, expect, test } from "bun:test";

import { createPreview } from "../src/artifacts.js";

describe("createPreview", () => {
  test("returns short text unchanged", () => {
    expect(createPreview("hello world")).toBe("hello world");
  });

  test("returns text exactly at maxChars unchanged", () => {
    const text = "a".repeat(4000);
    expect(createPreview(text)).toBe(text);
  });

  test("truncates long text with head and tail", () => {
    const text = "a".repeat(3000) + "b".repeat(3000);
    const result = createPreview(text);
    expect(result).toContain("\n...\n");
    expect(result.length).toBeLessThan(text.length);
    const [head, tail] = result.split("\n...\n");
    expect(head).toBe("a".repeat(2000));
    expect(tail).toBe("b".repeat(2000));
  });

  test("respects custom maxChars", () => {
    const text = "x".repeat(100);
    const result = createPreview(text, 20);
    expect(result).toContain("\n...\n");
    const [head, tail] = result.split("\n...\n");
    expect(head).toHaveLength(10);
    expect(tail).toHaveLength(10);
  });
});
