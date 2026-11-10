import { createHash } from "node:crypto";

/**
 * RFC 8785 (JSON Canonicalization Scheme) serialization.
 *
 * Strings and numbers use the ECMAScript JSON serialization, which is what
 * JCS mandates. Object members are sorted by their UTF-16 code units, which is
 * the default order of `Array.prototype.sort` on strings.
 *
 * Values that have no JSON form (non-finite numbers, bigint, functions,
 * symbols, cycles) throw, so two different inputs can never collapse to the
 * same hash by being silently dropped.
 */
export function canonicalize(value: unknown): string {
  return serialize(value, new Set());
}

function serialize(value: unknown, seen: Set<object>): string {
  if (value === null) return "null";
  switch (typeof value) {
    case "boolean":
      return value ? "true" : "false";
    case "string":
      return JSON.stringify(value);
    case "number":
      if (!Number.isFinite(value)) {
        throw new TypeError("canonicalize: non-finite numbers have no JSON form");
      }
      // JSON.stringify(-0) === "0", as JCS requires.
      return JSON.stringify(value);
    case "object":
      break;
    default:
      throw new TypeError(`canonicalize: unsupported type ${typeof value}`);
  }

  const obj = value as object;
  if (seen.has(obj)) throw new TypeError("canonicalize: cyclic structure");
  seen.add(obj);
  try {
    if (Array.isArray(obj)) {
      const parts = obj.map((item) => (item === undefined ? "null" : serialize(item, seen)));
      return `[${parts.join(",")}]`;
    }
    const toJSON = (obj as { toJSON?: unknown }).toJSON;
    if (typeof toJSON === "function") {
      return serialize(toJSON.call(obj), seen);
    }
    const keys = Object.keys(obj).sort();
    const parts: string[] = [];
    for (const key of keys) {
      const member = (obj as Record<string, unknown>)[key];
      if (member === undefined) continue;
      parts.push(`${JSON.stringify(key)}:${serialize(member, seen)}`);
    }
    return `{${parts.join(",")}}`;
  } finally {
    seen.delete(obj);
  }
}

/** SHA-256 (hex) of the canonical JSON form of `value`. */
export function hashArgs(value: unknown): string {
  return createHash("sha256")
    .update(canonicalize(value ?? null), "utf8")
    .digest("hex");
}
