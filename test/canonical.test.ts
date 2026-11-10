import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { canonicalize, hashArgs } from "../src/canonical.js";

describe("canonicalize", () => {
  it("sorts keys and removes whitespace", () => {
    expect(canonicalize({ b: 1, a: [true, null, "x"] })).toBe('{"a":[true,null,"x"],"b":1}');
  });

  it("matches RFC 8785 number and string examples", () => {
    expect(canonicalize(1e21)).toBe("1e+21");
    expect(canonicalize(0.000001)).toBe("0.000001");
    expect(canonicalize(1e-7)).toBe("1e-7");
    expect(canonicalize(-0)).toBe("0");
    expect(canonicalize('€$\u000f\nA\'B"\\\\"/')).toBe('"€$\\u000f\\nA\'B\\"\\\\\\\\\\"/"');
  });

  it("sorts by UTF-16 code units", () => {
    // From RFC 8785 section 3.2.3, written with escapes to keep the source ASCII.
    const input = {
      "\u20ac": "Euro Sign",
      "\r": "Carriage Return",
      "\ufb33": "Hebrew Letter Dalet With Dagesh",
      "1": "One",
      "\ud83d\ude00": "Emoji: Grinning Face",
      "\u0080": "Control",
      "\u00f6": "Latin Small Letter O With Diaeresis",
    };
    const expected = ["\r", "1", "\u0080", "\u00f6", "\u20ac", "\ud83d\ude00", "\ufb33"];
    // JSON.parse would move integer-like keys first, so compare positions in the raw output.
    const out = canonicalize(input);
    const positions = expected.map((k) => out.indexOf(JSON.stringify(k)));
    expect(positions.every((pos) => pos >= 0)).toBe(true);
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);
  });

  it("drops undefined members and maps undefined array items to null", () => {
    expect(canonicalize({ a: undefined, b: [undefined] })).toBe('{"b":[null]}');
  });

  it("uses toJSON", () => {
    expect(canonicalize({ d: new Date(0) })).toBe('{"d":"1970-01-01T00:00:00.000Z"}');
  });

  it("rejects values with no JSON form", () => {
    expect(() => canonicalize(Number.NaN)).toThrow(TypeError);
    expect(() => canonicalize(Number.POSITIVE_INFINITY)).toThrow(TypeError);
    expect(() => canonicalize(10n)).toThrow(TypeError);
    expect(() => canonicalize({ f: () => 1 })).toThrow(TypeError);
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(() => canonicalize(cyclic)).toThrow(/cyclic/);
  });

  it("allows shared (non-cyclic) references", () => {
    const shared = { x: 1 };
    expect(canonicalize({ a: shared, b: shared })).toBe('{"a":{"x":1},"b":{"x":1}}');
  });

  it("property: output is valid JSON that round-trips to an equal value", () => {
    fc.assert(
      fc.property(fc.jsonValue(), (v) => {
        const out = canonicalize(v);
        expect(JSON.parse(out)).toEqual(JSON.parse(JSON.stringify(v)));
      }),
    );
  });

  it("property: idempotent", () => {
    fc.assert(
      fc.property(fc.jsonValue(), (v) => {
        const once = canonicalize(v);
        expect(canonicalize(JSON.parse(once))).toBe(once);
      }),
    );
  });

  it("property: key order does not change the hash", () => {
    fc.assert(
      fc.property(fc.dictionary(fc.string(), fc.jsonValue()), (obj) => {
        const reversed = Object.fromEntries(Object.entries(obj).reverse());
        expect(hashArgs(reversed)).toBe(hashArgs(obj));
      }),
    );
  });

  it("property: different canonical forms give different hashes", () => {
    fc.assert(
      fc.property(fc.jsonValue(), fc.jsonValue(), (a, b) => {
        fc.pre(canonicalize(a) !== canonicalize(b));
        expect(hashArgs(a)).not.toBe(hashArgs(b));
      }),
    );
  });
});

describe("hashArgs", () => {
  it("is a hex sha256 and treats undefined as null", () => {
    expect(hashArgs(undefined)).toMatch(/^[0-9a-f]{64}$/);
    expect(hashArgs(undefined)).toBe(hashArgs(null));
  });
});
