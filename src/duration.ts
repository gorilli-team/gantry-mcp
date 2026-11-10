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

export function parseDuration(input: Duration | string, label = "duration"): number {
  if (typeof input === "number") {
    if (!Number.isFinite(input) || input <= 0) {
      throw new GantryConfigError(`${label} must be a positive number of milliseconds`);
    }
    return input;
  }
  const match = /^\s*(\d+(?:\.\d+)?)\s*([a-z]+)\s*$/i.exec(input);
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
  const match = /^\s*(\d+)\s*\/\s*(\d+)?\s*([a-z]+)\s*$/i.exec(input);
  if (!match) throw new GantryConfigError(`Invalid ${label} "${input}". Use e.g. "60/min".`);
  const limit = Number(match[1]);
  const count = match[2] ? Number(match[2]) : 1;
  const unit = UNITS[match[3]!.toLowerCase()];
  if (unit === undefined || limit <= 0 || count <= 0) {
    throw new GantryConfigError(`Invalid ${label} "${input}". Use e.g. "60/min".`);
  }
  return { limit, windowMs: count * unit };
}
