# audit

One structured event per stage of every call, redacted before your sink sees it.

```ts
audit({
  sink: (event) => logger.info(event), // may be async
  redact: ["ssn", /card/i], // added to the defaults
  includeArgs: false, // default
  includeResult: false, // default
  failClosed: true, // default
});
```

Events: `received`, `refused` (with `code`), `approved`, `executed` (with `durationMs`), `failed`, plus anything other modules emit (`rate_limited`, `timeout`, `replayed`, `approval_requested`, ...).

- Keys matching `password`, `secret`, `token`, `apiKey`, `authorization`, `cookie` and similar are always redacted, whatever you configure. Gantry approval tokens are scrubbed from any string value.
- Arguments and results are opt-in, because they are where personal data lives.
- With `failClosed` (the default), a sink that rejects on `received` refuses the call: no audit record, no execution. Later events are best effort and logged on failure.

Put `audit` first so it records refusals from every other module.

## When you don't need this

Your platform already logs every tool call with arguments redacted, or the server only exposes read-only tools over stdio to one user.
