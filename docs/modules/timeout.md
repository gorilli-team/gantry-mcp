# timeout

Stops calls that run too long.

```ts
timeout({ default: "30s", perTool: { export_report: "5m" } })
```

When the limit hits, Gantry aborts `ctx.signal` (the handler's `ctx.mcpReq.signal`) and returns `TIMEOUT`. Pass the signal to your I/O (`fetch(url, { signal })`, database drivers) so the work actually stops; work that ignores it keeps running in the background. The message tells the model the call may have partly run.

`timeout` sits before `approval`, so the limit includes the time a human takes to approve. Give approval-gated tools a longer per-tool limit.

## When you don't need this

Every handler already enforces its own deadline, or the client cancels slow calls reliably.
