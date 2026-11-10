import { describe, expect, it } from "vitest";
import { LockBusyError } from "../../src/errors.js";
import type { Store } from "../../src/store/types.js";

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Behavior every Store implementation must have. */
export function storeContract(name: string, make: () => Promise<Store> | Store) {
  describe(`${name}: store contract`, () => {
    const uniq = () => `k-${Math.random().toString(36).slice(2)}`;

    it("round-trips JSON values and returns undefined for missing keys", async () => {
      const s = await make();
      const key = uniq();
      expect(await s.get(key)).toBeUndefined();
      await s.set(key, { a: [1, "two", null], b: { c: true } });
      expect(await s.get(key)).toEqual({ a: [1, "two", null], b: { c: true } });
      await s.set(key, "replaced");
      expect(await s.get(key)).toBe("replaced");
    });

    it("expires values", async () => {
      const s = await make();
      const key = uniq();
      await s.set(key, 1, 40);
      expect(await s.get(key)).toBe(1);
      await wait(80);
      expect(await s.get(key)).toBeUndefined();
    });

    it("consumes exactly once under concurrency", async () => {
      const s = await make();
      const key = uniq();
      await s.set(key, "v");
      const results = await Promise.all(Array.from({ length: 10 }, () => s.consume(key)));
      expect(results.filter((r) => r === "v")).toHaveLength(1);
      expect(await s.get(key)).toBeUndefined();
    });

    it("increments atomically, readable with get, and expires", async () => {
      const s = await make();
      const key = uniq();
      const results = await Promise.all(Array.from({ length: 10 }, () => s.incr(key, 1, 1000)));
      expect(Math.max(...results)).toBe(10);
      expect(await s.get(key)).toBe(10);
      expect(await s.incr(key, -3, 1000)).toBe(7);
      const short = uniq();
      await s.incr(short, 1, 40);
      await wait(80);
      expect(await s.incr(short, 1, 40)).toBe(1);
    });

    it("locks exclusively, releases only its own lock and expires", async () => {
      const s = await make();
      const key = uniq();
      const attempts = await Promise.allSettled(Array.from({ length: 5 }, () => s.lock(key, 1000)));
      const won = attempts.filter((a) => a.status === "fulfilled");
      expect(won).toHaveLength(1);
      for (const a of attempts) {
        if (a.status === "rejected") expect(a.reason).toBeInstanceOf(LockBusyError);
      }
      await (won[0] as PromiseFulfilledResult<() => Promise<void>>).value();
      const stale = await s.lock(key, 40);
      await wait(80);
      const fresh = await s.lock(key, 1000);
      await stale();
      await expect(s.lock(key, 1000)).rejects.toBeInstanceOf(LockBusyError);
      await fresh();
    });
  });
}
