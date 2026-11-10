# rateLimit

Caps how often a principal, a session, a tool or everyone can call.

```ts
rateLimit({
  perPrincipal: "60/min",
  perTool: { send_email: "10/hour" },   // counted per principal
  perSession: "300/hour",
  global: "1000/min",
  key: { by: (ctx) => ctx.client.name, rate: "100/min", name: "client" },
})
```

Rates are `"<limit>/<window>"`: `"5/s"`, `"60/min"`, `"10/hour"`, `"100/day"`, `"10/5m"`.

It is a sliding-window counter: the previous window's count, weighted by how much of it overlaps, plus the current count. It only needs the store's atomic `incr`, so it holds across instances on Redis or MongoDB. Refused calls do not consume quota, and the error includes `retryAfterSeconds`.

Store errors refuse the call (`UNAVAILABLE`).

## When you don't need this

An API gateway in front of the server already limits per client, and no single tool needs its own budget.
