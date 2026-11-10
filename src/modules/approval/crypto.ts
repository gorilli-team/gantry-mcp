import { createHmac, timingSafeEqual } from "node:crypto";
import { GantryConfigError } from "../../errors.js";

export const MIN_SECRET_LENGTH = 32;

/**
 * Refuses weak secrets at startup: too short, or too few distinct characters
 * (e.g. "aaaa…" or "changeme" repeated).
 */
export function assertStrongSecret(secret: unknown): asserts secret is string {
  if (typeof secret !== "string" || secret.length < MIN_SECRET_LENGTH) {
    throw new GantryConfigError(
      `approval: secret must be at least ${MIN_SECRET_LENGTH} characters. Generate one with: node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"`,
    );
  }
  if (new Set(secret).size < 10) {
    throw new GantryConfigError("approval: secret has too little entropy. Use 32 random bytes.");
  }
}

/** Derives a purpose-specific key so a token for one use can never verify for another. */
export function deriveKey(secret: string, purpose: string): Buffer {
  return createHmac("sha256", secret).update(`gantry:${purpose}`).digest();
}

const b64 = (b: Buffer | string) => Buffer.from(b).toString("base64url");

/** `<prefix><base64url(json)>.<base64url(hmac)>` */
export function sign(key: Buffer, prefix: string, payload: Record<string, unknown>): string {
  const body = b64(JSON.stringify(payload));
  const mac = createHmac("sha256", key).update(`${prefix}${body}`).digest();
  return `${prefix}${body}.${b64(mac)}`;
}

/** Verifies a token in constant time. Returns the payload or undefined. */
export function verify(
  key: Buffer,
  prefix: string,
  token: unknown,
): Record<string, unknown> | undefined {
  if (typeof token !== "string" || token.length > 4096 || !token.startsWith(prefix))
    return undefined;
  const rest = token.slice(prefix.length);
  const dot = rest.indexOf(".");
  if (dot <= 0) return undefined;
  const body = rest.slice(0, dot);
  const given = Buffer.from(rest.slice(dot + 1), "base64url");
  const expected = createHmac("sha256", key).update(`${prefix}${body}`).digest();
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return undefined;
  try {
    const parsed: unknown = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}
