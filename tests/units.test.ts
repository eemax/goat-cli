import { describe, expect, test } from "bun:test";

import { parseBytes, parseTime, parseTokenCount } from "../src/units.js";

describe("parseTime", () => {
  test("parses seconds", () => {
    expect(parseTime("45s")).toBe(45);
    expect(parseTime("10s")).toBe(10);
    expect(parseTime("0.5s")).toBe(0.5);
  });

  test("parses minutes", () => {
    expect(parseTime("5m")).toBe(300);
    expect(parseTime("30m")).toBe(1800);
  });

  test("parses hours", () => {
    expect(parseTime("2h")).toBe(7200);
    expect(parseTime("1h")).toBe(3600);
  });

  test("parses milliseconds", () => {
    expect(parseTime("100ms")).toBe(0.1);
    expect(parseTime("500ms")).toBe(0.5);
    expect(parseTime("1000ms")).toBe(1);
  });

  test("parses compound expressions", () => {
    expect(parseTime("1h 30m")).toBe(5400);
    expect(parseTime("2m 30s")).toBe(150);
    expect(parseTime("1h 30m 15s")).toBe(5415);
    expect(parseTime("1h30m")).toBe(5400);
  });

  test("is case-insensitive", () => {
    expect(parseTime("2H")).toBe(7200);
    expect(parseTime("30M")).toBe(1800);
    expect(parseTime("100MS")).toBe(0.1);
    expect(parseTime("10S")).toBe(10);
  });

  test("rejects bare numbers", () => {
    expect(() => parseTime("45")).toThrow();
  });

  test("rejects empty string", () => {
    expect(() => parseTime("")).toThrow();
  });

  test("rejects invalid input", () => {
    expect(() => parseTime("abc")).toThrow();
    expect(() => parseTime("10x")).toThrow();
  });
});

describe("parseBytes", () => {
  test("parses megabytes", () => {
    expect(parseBytes("8mb")).toBe(8 * 1024 * 1024);
    expect(parseBytes("1mb")).toBe(1024 * 1024);
    expect(parseBytes("16mb")).toBe(16 * 1024 * 1024);
  });

  test("parses kilobytes", () => {
    expect(parseBytes("50kb")).toBe(50 * 1024);
    expect(parseBytes("512kb")).toBe(512 * 1024);
  });

  test("parses decimal values", () => {
    expect(parseBytes("0.5mb")).toBe(Math.floor(0.5 * 1024 * 1024));
    expect(parseBytes("1.5kb")).toBe(Math.floor(1.5 * 1024));
  });

  test("is case-insensitive", () => {
    expect(parseBytes("8MB")).toBe(8 * 1024 * 1024);
    expect(parseBytes("50KB")).toBe(50 * 1024);
    expect(parseBytes("8Mb")).toBe(8 * 1024 * 1024);
  });

  test("rejects bare numbers", () => {
    expect(() => parseBytes("1024")).toThrow();
  });

  test("rejects unsupported units", () => {
    expect(() => parseBytes("1gb")).toThrow();
    expect(() => parseBytes("1tb")).toThrow();
  });

  test("rejects compound expressions", () => {
    expect(() => parseBytes("1mb 500kb")).toThrow();
  });

  test("rejects empty string", () => {
    expect(() => parseBytes("")).toThrow();
  });
});

describe("parseTokenCount", () => {
  test("parses bare integers", () => {
    expect(parseTokenCount("200000")).toBe(200000);
    expect(parseTokenCount("4000")).toBe(4000);
    expect(parseTokenCount("1")).toBe(1);
  });

  test("parses k suffix", () => {
    expect(parseTokenCount("4k")).toBe(4000);
    expect(parseTokenCount("180k")).toBe(180000);
    expect(parseTokenCount("128k")).toBe(128000);
  });

  test("parses m suffix", () => {
    expect(parseTokenCount("1m")).toBe(1000000);
    expect(parseTokenCount("2m")).toBe(2000000);
  });

  test("parses decimals with suffix", () => {
    expect(parseTokenCount("1.5k")).toBe(1500);
    expect(parseTokenCount("2.5m")).toBe(2500000);
  });

  test("is case-insensitive", () => {
    expect(parseTokenCount("4K")).toBe(4000);
    expect(parseTokenCount("1M")).toBe(1000000);
  });

  test("rejects bare decimals without suffix", () => {
    expect(() => parseTokenCount("1.5")).toThrow();
  });

  test("rejects invalid input", () => {
    expect(() => parseTokenCount("abc")).toThrow();
    expect(() => parseTokenCount("")).toThrow();
    expect(() => parseTokenCount("0")).toThrow();
  });
});
