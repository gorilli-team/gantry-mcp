import { GantryConfigError } from "./errors.js";

/** A duration: milliseconds as a number, or a string such as "500ms", "30s", "5m", "24h", "7d". */
export type Duration = number | `${number}${"ms" | "s" | "m" | "min" | "h" | "d"}`;

const UNITS: Record<string, number> = {
  ms: 1,
  s: 1_000,
  sec: 1_000,
  m: 60_000,
  min: 60_000,
  h: 3_600_000,
  hour: 3_600_000,
  d: 86_400_000,
  day: 86_400_000,
};

/** Config strings are short; anything longer is a mistake (and never worth parsing). */
const MAX_INPUT = 64;

/** "30s" -> ["30s", "30", "s"]. Whitespace is trimmed first so the pattern stays linear. */
function splitAmount(input: string): RegExpExecArray | null {
  if (typeof input !== "string" || input.length > MAX_INPUT) return null;
  return /^(\d+(?:\.\d+)?)([a-z]+)$/i.exec(input.trim().replace(/^(\d+(?:\.\d+)?) +/, "$1"));
}

export function parseDuration(input: Duration | string, label = "duration"): number {
  if (typeof input === "number") {
    if (!Number.isFinite(input) || input <= 0) {
      throw new GantryConfigError(`${label} must be a positive number of milliseconds`);
    }
    return input;
  }
  const match = splitAmount(input);
  const unit = match ? UNITS[match[2]!.toLowerCase()] : undefined;
  if (!match || unit === undefined) {
    throw new GantryConfigError(
      `Invalid ${label} "${input}". Use e.g. "500ms", "30s", "5m", "24h".`,
    );
  }
  const ms = Number(match[1]) * unit;
  if (ms <= 0) throw new GantryConfigError(`${label} must be positive`);
  return ms;
}

/** A rate such as "60/min", "10/hour", "5/s", "100/day" or "10/5m". */
export type Rate = string | { limit: number; windowMs: number };

export interface ParsedRate {
  limit: number;
  windowMs: number;
}

export function parseRate(input: Rate, label = "rate"): ParsedRate {
  if (typeof input === "object") {
    if (!Number.isInteger(input.limit) || input.limit <= 0) {
      throw new GantryConfigError(`${label}: limit must be a positive integer`);
    }
    return { limit: input.limit, windowMs: parseDuration(input.windowMs, label) };
  }
  // Split first, then match each short, whitespace-free part: no regex here can backtrack.
  const parts = typeof input === "string" && input.length <= MAX_INPUT ? input.split("/") : [];
  const limitPart = parts[0]?.trim() ?? "";
  const windowPart = parts[1]?.trim() ?? "";
  const windowMatch = /^(\d*)([a-z]+)$/i.exec(windowPart);
  if (parts.length !== 2 || !/^\d+$/.test(limitPart) || !windowMatch) {
    throw new GantryConfigError(`Invalid ${label} "${input}". Use e.g. "60/min".`);
  }
  const limit = Number(limitPart);
  const count = windowMatch[1] ? Number(windowMatch[1]) : 1;
  const unit = UNITS[windowMatch[2]!.toLowerCase()];
  if (unit === undefined || limit <= 0 || count <= 0) {
    throw new GantryConfigError(`Invalid ${label} "${input}". Use e.g. "60/min".`);
  }
  return { limit, windowMs: count * unit };
}
