import type { GantryCode } from "../errors.js";
import { getGantryPayload } from "../errors.js";

interface MatcherContext {
  isNot?: boolean;
  equals(a: unknown, b: unknown): boolean;
  utils?: { printReceived?(v: unknown): string; printExpected?(v: unknown): string };
}

interface MatcherResult {
  pass: boolean;
  message(): string;
}

const show = (v: unknown) => {
  try {
    return JSON.stringify(v, null, 2);
  } catch {
    return String(v);
  }
};

/** Matchers for Vitest and Jest: `expect.extend(gantryMatchers)`. */
export const gantryMatchers = {
  toBeGantryOk(this: MatcherContext, received: unknown): MatcherResult {
    const r = received as { isError?: boolean } | undefined;
    const pass = !!r && typeof r === "object" && !r.isError;
    return {
      pass,
      message: () =>
        pass
          ? "expected the call not to succeed"
          : `expected the call to succeed, got:\n${show(received)}`,
    };
  },

  toBeGantryError(
    this: MatcherContext,
    received: unknown,
    code?: GantryCode | string,
  ): MatcherResult {
    const r = received as { isError?: boolean } | undefined;
    const payload = getGantryPayload(received);
    const pass = !!r?.isError && !!payload && (code === undefined || payload.code === code);
    return {
      pass,
      message: () =>
        pass
          ? `expected the call not to be refused with ${code ?? "a Gantry error"}`
          : `expected a Gantry refusal${code ? ` with code ${code}` : ""}, got:\n${show(received)}`,
    };
  },

  toContainEvent(
    this: MatcherContext,
    received: unknown,
    expected: Record<string, unknown>,
  ): MatcherResult {
    const events = Array.isArray(received) ? received : [];
    const pass = events.some(
      (e) =>
        !!e &&
        typeof e === "object" &&
        Object.entries(expected).every(([k, v]) =>
          this.equals((e as Record<string, unknown>)[k], v),
        ),
    );
    return {
      pass,
      message: () =>
        pass
          ? `expected no event matching ${show(expected)}`
          : `expected an event matching ${show(expected)}, got types: ${events
              .map((e) => (e as { type?: string }).type)
              .join(", ")}`,
    };
  },
};

export interface GantryMatchers<R = unknown> {
  toBeGantryOk(): R;
  toBeGantryError(code?: GantryCode | string): R;
  toContainEvent(expected: Record<string, unknown>): R;
}
