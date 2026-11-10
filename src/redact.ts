export type RedactRule = string | RegExp;

/** Keys always redacted, whatever the configuration. */
export const DEFAULT_REDACT: readonly RedactRule[] = [
  "password",
  "passwd",
  "secret",
  "token",
  "apiKey",
  "api_key",
  "authorization",
  "cookie",
  "_approvalToken",
  /secret/i,
  /token/i,
  /password/i,
];

const REDACTED = "[REDACTED]";
/** Gantry approval and decision tokens, scrubbed from any string value. */
const TOKEN_PATTERN = /\bga[td]_[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g;
const MAX_DEPTH = 20;

function matches(key: string, rules: readonly RedactRule[]): boolean {
  const lower = key.toLowerCase();
  for (const rule of rules) {
    if (typeof rule === "string" ? rule.toLowerCase() === lower : rule.test(key)) return true;
  }
  return false;
}

/**
 * Returns a deep copy of `value` with matching keys replaced by "[REDACTED]".
 * Regexes are reset before use so global flags cannot skip matches.
 */
export function redact(value: unknown, rules: readonly RedactRule[] = DEFAULT_REDACT): unknown {
  const safeRules = rules.map((r) =>
    typeof r === "string" ? r : new RegExp(r.source, r.flags.replace("g", "")),
  );
  const walk = (v: unknown, depth: number, seen: WeakSet<object>): unknown => {
    if (typeof v === "string") return v.replace(TOKEN_PATTERN, REDACTED);
    if (v === null || typeof v !== "object") return typeof v === "bigint" ? v.toString() : v;
    if (seen.has(v)) return "[Circular]";
    if (depth >= MAX_DEPTH) return "[Truncated]";
    seen.add(v);
    if (Array.isArray(v)) return v.map((item) => walk(item, depth + 1, seen));
    const out: Record<string, unknown> = {};
    for (const [k, inner] of Object.entries(v)) {
      out[k] = matches(k, safeRules) ? REDACTED : walk(inner, depth + 1, seen);
    }
    return out;
  };
  return walk(value, 0, new WeakSet());
}
