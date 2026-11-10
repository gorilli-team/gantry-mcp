import { type AnnotationsOptions, annotations } from "./modules/annotations.js";
import { type ApprovalOptions, approval } from "./modules/approval/index.js";
import { type AuditOptions, audit } from "./modules/audit.js";
import { type IdempotencyOptions, idempotency } from "./modules/idempotency.js";
import { type OutputLimitOptions, outputLimit } from "./modules/outputLimit.js";
import { type RateLimitOptions, rateLimit } from "./modules/rateLimit.js";
import { type TimeoutOptions, timeout } from "./modules/timeout.js";
import type { Middleware } from "./types.js";

export interface RecommendedOptions {
  /** Audit needs a sink; omitted means no audit module. */
  audit?: AuditOptions | false;
  /** Default { perPrincipal: "120/min" }. */
  rateLimit?: RateLimitOptions | false;
  /** Default { default: "30s" }. Keep it long enough for a human to approve. */
  timeout?: TimeoutOptions | false;
  /** Default { ttl: "24h" }. */
  idempotency?: IdempotencyOptions | false;
  /**
   * Default: on for every tool that may be destructive, asking in the client
   * (elicitation). Clients that cannot elicit are refused. Token or
   * out-of-band fallbacks are opt-in: `approval: { fallback: ["token"], secret }`.
   */
  approval?: ApprovalOptions | false;
  /** Default { enforce: true }. */
  annotations?: AnnotationsOptions | false;
  /** Default { maxTokens: 8000 }. */
  outputLimit?: OutputLimitOptions | false;
}

/**
 * The recommended stack, in the recommended order:
 * audit → rateLimit → timeout → idempotency → approval → annotations → outputLimit.
 * Idempotency sits before approval so a retried, already-executed call returns
 * its stored result without asking the human again.
 */
export function recommended(options: RecommendedOptions = {}): Middleware[] {
  const out: Middleware[] = [];
  if (options.audit) out.push(audit(options.audit));
  if (options.rateLimit !== false)
    out.push(rateLimit(options.rateLimit ?? { perPrincipal: "120/min" }));
  if (options.timeout !== false) out.push(timeout(options.timeout ?? { default: "30s" }));
  if (options.idempotency !== false) out.push(idempotency(options.idempotency ?? { ttl: "24h" }));
  if (options.approval !== false)
    out.push(approval({ mode: "elicit", ...(options.approval ?? {}) }));
  if (options.annotations !== false)
    out.push(annotations(options.annotations ?? { enforce: true }));
  if (options.outputLimit !== false)
    out.push(outputLimit(options.outputLimit ?? { maxTokens: 8000 }));
  return out;
}
