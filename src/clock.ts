/** Time source used by Gantry and its modules. Swap it in tests for a fake clock. */
export interface Clock {
  now(): number;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export const systemClock: Clock = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => {
    const t = setTimeout(fn, ms);
    // Never keep the process alive just for a Gantry timer.
    (t as { unref?: () => void }).unref?.();
    return t;
  },
  clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
};

/** Resolves after `ms` on the given clock, or rejects when `signal` aborts. */
export function sleep(clock: Clock, ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const onAbort = () => {
      clock.clearTimeout(handle);
      reject(signal?.reason);
    };
    const handle = clock.setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
