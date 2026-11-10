import type { Clock } from "../clock.js";

/**
 * Shared state for all modules. Every operation must be atomic per key.
 * Multi-instance deployments need a shared implementation (Redis, MongoDB).
 */
export interface Store {
  get(key: string): Promise<unknown | undefined>;
  set(key: string, value: unknown, ttlMs?: number): Promise<void>;
  /** Atomic get + delete. Returns undefined when the key is missing or expired. */
  consume(key: string): Promise<unknown | undefined>;
  /** Atomic increment. Creates the key with `ttlMs` when missing; keeps the TTL otherwise. */
  incr(key: string, by: number, ttlMs: number): Promise<number>;
  /**
   * Non-blocking lock. Resolves with a release function when acquired and
   * rejects with `LockBusyError` when another holder has it. Locks expire
   * after `ttlMs` so a crashed holder cannot block forever.
   */
  lock(key: string, ttlMs: number): Promise<() => Promise<void>>;
  /** Optional: lets the test harness drive the store with a fake clock. */
  useClock?(clock: Clock): void;
  /** Optional: identifies process-local stores so Gantry can warn on HTTP transports. */
  readonly kind?: string;
}
