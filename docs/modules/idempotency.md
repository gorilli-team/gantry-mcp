# idempotency

Agents retry. This makes sure a retried write does not run twice.

```ts
idempotency({
  ttl: "24h", // how long results are replayed
  scope: "principal", // or "session" | "global"
  onlyFor: (tool) => !tool.annotations.readOnlyHint, // default
  waitFor: "30s", // how long a duplicate waits for the first call
});
```

- The same scope + tool + `argsHash` within the TTL returns the stored result, marked `_meta["gantry/replayed"]`.
- An explicit `_idempotencyKey` argument (added to the tool's schema automatically) groups calls by key instead. Reusing a key with different arguments returns `IDEMPOTENCY_CONFLICT`.
- Concurrent duplicates wait for the first call; on a shared store this holds across instances via `lock`. After `waitFor`, they get `DUPLICATE_IN_FLIGHT`.
- Only successful results are stored. Failures can be retried.
- Results over `maxResultBytes` (default 256 KiB) are not stored, so one caller cannot fill the store; those calls are not deduplicated.

It sits before `approval`, so a retried call that already ran returns its result without asking the human again.

## When you don't need this

Your tools are naturally idempotent (upserts keyed by the caller), or the backend API takes its own idempotency keys and you pass them through.
