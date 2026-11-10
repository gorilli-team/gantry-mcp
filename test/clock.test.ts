import { describe, expect, it } from "vitest";
import { sleep, systemClock } from "../src/clock.js";
import { fakeClock } from "../src/testing/clock.js";

describe("systemClock", () => {
  it("tells time and runs and cancels timers", async () => {
    expect(Math.abs(systemClock.now() - Date.now())).toBeLessThan(50);
    await sleep(systemClock, 5);
    let fired = false;
    const h = systemClock.setTimeout(() => {
      fired = true;
    }, 5);
    systemClock.clearTimeout(h);
    await sleep(systemClock, 15);
    expect(fired).toBe(false);
  });
});

describe("sleep", () => {
  it("rejects when aborted, before or during", async () => {
    const clock = fakeClock();
    const pre = new AbortController();
    pre.abort(new Error("early"));
    await expect(sleep(clock, 10, pre.signal)).rejects.toThrow("early");
    const mid = new AbortController();
    const p = sleep(clock, 1000, mid.signal);
    mid.abort(new Error("late"));
    await expect(p).rejects.toThrow("late");
    expect(clock.pending).toBe(0);
  });
});

describe("fakeClock", () => {
  it("sets time, cancels timers and fires in order", async () => {
    const clock = fakeClock(0);
    const order: number[] = [];
    clock.setTimeout(() => order.push(2), 20);
    clock.setTimeout(() => order.push(1), 10);
    const h = clock.setTimeout(() => order.push(3), 15);
    clock.clearTimeout(h);
    clock.setTimeout(() => order.push(0), -5);
    await clock.advance(30);
    expect(order).toEqual([0, 1, 2]);
    clock.set(1000);
    expect(clock.now()).toBe(1000);
  });
});
