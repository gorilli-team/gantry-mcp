import { randomUUID } from "node:crypto";
import { type Clock, systemClock } from "../clock.js";
import { LockBusyError } from "../errors.js";
import type { Store } from "./types.js";

interface Entry {
  value: unknown;
  expiresAt: number;
}

export interface MemoryStoreOptions {
  /** Upper bound on keys; the oldest are evicted first. Default 100_000. */
  maxKeys?: number;
  clock?: Clock;
}

/**
 * Process-local store. Fine for stdio servers and single instances; use a
 * shared store when you run more than one instance behind HTTP.
 * Values are deep-copied on write and read so callers cannot mutate stored state.
 */
export function memoryStore(options: MemoryStoreOptions = {}): Store {
  const maxKeys = options.maxKeys ?? 100_000;
  let clock = options.clock ?? systemClock;
  const data = new Map<string, Entry>();

  const live = (key: string): Entry | undefined => {
    const entry = data.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt <= clock.now()) {
      data.delete(key);
      return undefined;
    }
    return entry;
  };

  const put = (key: string, value: unknown, ttlMs?: number) => {
    data.delete(key);
    if (data.size >= maxKeys) sweep();
    while (data.size >= maxKeys) {
      const oldest = data.keys().next().value;
      if (oldest === undefined) break;
      data.delete(oldest);
    }
    const expiresAt = ttlMs === undefined ? Number.POSITIVE_INFINITY : clock.now() + ttlMs;
    data.set(key, { value, expiresAt });
  };

  const sweep = () => {
    const now = clock.now();
    for (const [key, entry] of data) if (entry.expiresAt <= now) data.delete(key);
  };

  return {
    kind: "memory",
    async get(key) {
      const entry = live(key);
      return entry ? structuredClone(entry.value) : undefined;
    },
    async set(key, value, ttlMs) {
      put(key, structuredClone(value), ttlMs);
    },
    async consume(key) {
      const entry = live(key);
      if (!entry) return undefined;
      data.delete(key);
      return entry.value;
    },
    async incr(key, by, ttlMs) {
      const entry = live(key);
      if (entry) {
        const next = (typeof entry.value === "number" ? entry.value : 0) + by;
        entry.value = next;
        return next;
      }
      put(key, by, ttlMs);
      return by;
    },
    async lock(key, ttlMs) {
      const lockKey = `\u0000lock:${key}`;
      if (live(lockKey)) throw new LockBusyError(`Lock "${key}" is held`);
      const owner = randomUUID();
      put(lockKey, owner, ttlMs);
      return async () => {
        if (live(lockKey)?.value === owner) data.delete(lockKey);
      };
    },
    useClock(next) {
      clock = next;
    },
  };
}
