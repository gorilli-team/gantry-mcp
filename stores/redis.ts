import { randomUUID } from "node:crypto";
import { LockBusyError } from "../src/errors.js";
import type { Store } from "../src/store/types.js";

/**
 * Minimal command interface. ioredis clients satisfy it through `call`;
 * node-redis clients through `sendCommand`.
 */
export type RedisLike =
  | { call(command: string, ...args: (string | number)[]): Promise<unknown> }
  | { sendCommand(args: string[]): Promise<unknown> };

export interface RedisStoreOptions {
  /** Key prefix. Default "gantry:". */
  prefix?: string;
}

/** Lua scripts keep each operation atomic on the server. */
export const SCRIPTS = {
  consume: `local v = redis.call('GET', KEYS[1]); if v then redis.call('DEL', KEYS[1]) end; return v`,
  incr: `local n = redis.call('INCRBY', KEYS[1], ARGV[1]); if redis.call('PTTL', KEYS[1]) < 0 then redis.call('PEXPIRE', KEYS[1], ARGV[2]) end; return n`,
  release: `if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) else return 0 end`,
} as const;

/** Shared store on Redis (ioredis or node-redis). Values are JSON encoded. */
export function redisStore(client: RedisLike, options: RedisStoreOptions = {}): Store {
  const prefix = options.prefix ?? "gantry:";
  const cmd = (...args: (string | number)[]): Promise<unknown> => {
    if ("call" in client && typeof client.call === "function") {
      const [command, ...rest] = args;
      return client.call(String(command), ...rest);
    }
    return (client as { sendCommand(a: string[]): Promise<unknown> }).sendCommand(args.map(String));
  };
  const k = (key: string) => `${prefix}${key}`;
  const decode = (raw: unknown) => {
    if (raw === null || raw === undefined) return undefined;
    return JSON.parse(typeof raw === "string" ? raw : String(raw));
  };
  const ms = (ttl: number) => Math.max(1, Math.ceil(ttl));

  return {
    kind: "redis",
    async get(key) {
      return decode(await cmd("GET", k(key)));
    },
    async set(key, value, ttlMs) {
      const payload = JSON.stringify(value ?? null);
      if (ttlMs === undefined) await cmd("SET", k(key), payload);
      else await cmd("SET", k(key), payload, "PX", ms(ttlMs));
    },
    async consume(key) {
      return decode(await cmd("EVAL", SCRIPTS.consume, 1, k(key)));
    },
    async incr(key, by, ttlMs) {
      return Number(await cmd("EVAL", SCRIPTS.incr, 1, k(key), Math.trunc(by), ms(ttlMs)));
    },
    async lock(key, ttlMs) {
      const lockKey = k(`lock:${key}`);
      const owner = randomUUID();
      const res = await cmd("SET", lockKey, owner, "PX", ms(ttlMs), "NX");
      if (res !== "OK") throw new LockBusyError(`Lock "${key}" is held`);
      return async () => {
        await cmd("EVAL", SCRIPTS.release, 1, lockKey, owner);
      };
    },
  };
}
