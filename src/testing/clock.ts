import type { Clock } from "../clock.js";

export interface FakeClock extends Clock {
  /** Moves time forward, firing due timers in order and flushing promise jobs between them. */
  advance(ms: number): Promise<void>;
  /** Sets the absolute time without firing timers. */
  set(now: number): void;
  /** Number of pending timers. */
  readonly pending: number;
}

interface Timer {
  id: number;
  at: number;
  fn: () => void;
}

const flush = async () => {
  for (let i = 0; i < 10; i++) await new Promise<void>((r) => setImmediate(r));
};

export function fakeClock(start = Date.UTC(2026, 0, 1)): FakeClock {
  let now = start;
  let seq = 0;
  const timers = new Map<number, Timer>();
  return {
    now: () => now,
    setTimeout(fn, ms) {
      const id = ++seq;
      timers.set(id, { id, at: now + Math.max(0, ms), fn });
      return id;
    },
    clearTimeout(handle) {
      timers.delete(handle as number);
    },
    async advance(ms) {
      const target = now + ms;
      await flush();
      for (;;) {
        const due = [...timers.values()]
          .filter((t) => t.at <= target)
          .sort((a, b) => a.at - b.at || a.id - b.id)[0];
        if (!due) break;
        timers.delete(due.id);
        now = due.at;
        due.fn();
        await flush();
      }
      now = target;
      await flush();
    },
    set(next) {
      now = next;
    },
    get pending() {
      return timers.size;
    },
  };
}
