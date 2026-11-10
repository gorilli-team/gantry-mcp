import { describe, expect, it } from "vitest";
import { LockBusyError } from "../src/errors.js";
import { memoryStore } from "../src/store/memory.js";
import { fakeClock } from "../src/testing/clock.js";

describe("memoryStore", () => {
  it("gets, sets with TTL and expires", async () => {
    const clock = fakeClock();
    const s = memoryStore({ clock });
    await s.set("a", { x: 1 }, 1000);
    expect(await s.get("a")).toEqual({ x: 1 });
    await clock.advance(1000);
    expect(await s.get("a")).toBeUndefined();
  });

  it("copies values so callers cannot mutate stored state", async () => {
    const s = memoryStore();
    const v = { x: 1 };
    await s.set("a", v);
    v.x = 2;
    const read = (await s.get("a")) as { x: number };
    read.x = 3;
    expect(await s.get("a")).toEqual({ x: 1 });
  });

  it("consume is single use, even under concurrency", async () => {
    const s = memoryStore();
    await s.set("t", "token");
    const results = await Promise.all(Array.from({ length: 20 }, () => s.consume("t")));
    expect(results.filter((r) => r === "token")).toHaveLength(1);
    expect(await s.consume("missing")).toBeUndefined();
  });

  it("incr creates with TTL and keeps it on later increments", async () => {
    const clock = fakeClock();
    const s = memoryStore({ clock });
    expect(await s.incr("c", 1, 1000)).toBe(1);
    await clock.advance(500);
    expect(await s.incr("c", 2, 1000)).toBe(3);
    await clock.advance(500);
    expect(await s.incr("c", 1, 1000)).toBe(1);
  });

  it("lock is exclusive, releasable and expires", async () => {
    const clock = fakeClock();
    const s = memoryStore({ clock });
    const release = await s.lock("k", 1000);
    await expect(s.lock("k", 1000)).rejects.toBeInstanceOf(LockBusyError);
    await release();
    const again = await s.lock("k", 1000);
    await clock.advance(1000);
    const third = await s.lock("k", 1000);
    // A stale holder cannot release someone else's lock.
    await again();
    await expect(s.lock("k", 1000)).rejects.toBeInstanceOf(LockBusyError);
    await third();
  });

  it("evicts the oldest keys beyond maxKeys", async () => {
    const s = memoryStore({ maxKeys: 2 });
    await s.set("a", 1);
    await s.set("b", 2);
    await s.set("c", 3);
    expect(await s.get("a")).toBeUndefined();
    expect(await s.get("c")).toBe(3);
  });
});
