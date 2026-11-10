import { describe, expect, it } from "vitest";
import { parseDuration, parseRate } from "../src/duration.js";
import { GantryConfigError } from "../src/errors.js";

describe("parseDuration", () => {
  it.each([
    ["500ms", 500],
    ["30s", 30_000],
    ["5m", 300_000],
    ["2min", 120_000],
    ["24h", 86_400_000],
    ["1d", 86_400_000],
    ["1.5s", 1500],
    [250, 250],
  ])("%s", (input, ms) => {
    expect(parseDuration(input as never)).toBe(ms);
  });

  it.each(["", "abc", "10 parsecs", "-5s", "0s", 0, -1, Number.NaN])("rejects %s", (input) => {
    expect(() => parseDuration(input as never)).toThrow(GantryConfigError);
  });
});

describe("parseRate", () => {
  it.each([
    ["60/min", 60, 60_000],
    ["10/hour", 10, 3_600_000],
    ["5/s", 5, 1000],
    ["100/day", 100, 86_400_000],
    ["10/5m", 10, 300_000],
  ])("%s", (input, limit, windowMs) => {
    expect(parseRate(input)).toEqual({ limit, windowMs });
  });

  it("accepts objects", () => {
    expect(parseRate({ limit: 3, windowMs: 1000 })).toEqual({ limit: 3, windowMs: 1000 });
  });

  it("parses adversarial input in linear time (CodeQL polynomial regex)", () => {
    const started = performance.now();
    for (const bad of [
      `9/${" ".repeat(50_000)}`,
      `${" ".repeat(50_000)}9`,
      `9${" ".repeat(50_000)}s`,
    ]) {
      expect(() => parseRate(bad)).toThrow(GantryConfigError);
      expect(() => parseDuration(bad as never)).toThrow(GantryConfigError);
    }
    expect(performance.now() - started).toBeLessThan(50);
  });

  it("accepts spaces around the parts", () => {
    expect(parseRate(" 60 / min ")).toEqual({ limit: 60, windowMs: 60_000 });
    expect(parseDuration(" 30 s " as never)).toBe(30_000);
  });

  it.each(["60", "0/min", "x/min", "5/fortnight", "1/2/min", "5/ 2 m"])("rejects %s", (input) => {
    expect(() => parseRate(input)).toThrow(GantryConfigError);
  });
  it("rejects bad objects", () => {
    expect(() => parseRate({ limit: 0, windowMs: 1 })).toThrow(GantryConfigError);
  });
});
