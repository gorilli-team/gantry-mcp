# The pipeline

Every `tools/call` handled by a Gantry-wrapped tool runs through `use`, in order, then the handler:

```
audit → rateLimit → timeout → idempotency → approval → annotations → outputLimit → handler
```

## Middleware contract

```ts
type Middleware = (
  ctx: CallContext,
  next: () => Promise<CallToolResult>,
) => Promise<CallToolResult>;
```

A middleware either calls `next()` once or returns its own result. Calling `next()` twice throws. For an expected refusal, return a result made with `gantryError(code, text, details)` instead of throwing, so the agent sees it and can react.

## CallContext

| Field               | Meaning                                                    |
| ------------------- | ---------------------------------------------------------- |
| `tool`              | `{ name, annotations, meta }`, frozen                      |
| `args`              | validated input, without reserved arguments                |
| `argsHash`          | SHA-256 of the RFC 8785 canonical JSON of `args`           |
| `principal`         | from your `principal` resolver                             |
| `sessionId`         | MCP session, when the transport has one                    |
| `requestId`         | unique per call (JSON-RPC ids repeat across sessions)      |
| `signal`, `abort()` | aborted by `timeout` or client cancellation                |
| `client`            | `{ capabilities, name }`                                   |
| `elicit`            | ask the human through the client; undefined if unsupported |
| `store`, `clock`    | shared state and time source                               |
| `emit(event)`       | publish on the event stream                                |
| `state`             | per-call `Map` shared between middlewares                  |
| `reserved`          | reserved argument values (untrusted)                       |
| `clients`, `fetch`  | I/O helpers that modules (e.g. `annotations`) may wrap     |

Handlers receive the SDK context with one addition, `ctx.gantry`, the `CallContext` above. `ctx.mcpReq.signal` (v2) or `ctx.signal` (v1) is replaced by Gantry's combined signal.

## Writing your own

```ts
import { defineMiddleware, gantryError } from "@gorilli/gantry-mcp";

export const businessHours = defineMiddleware(
  async (ctx, next) => {
    const hour = new Date(ctx.clock.now()).getUTCHours();
    if (ctx.tool.annotations.destructiveHint && (hour < 8 || hour > 18)) {
      return gantryError(
        "APPROVAL_DENIED",
        "Destructive tools only run between 08:00 and 18:00 UTC. Try again then.",
      );
    }
    return next();
  },
  { gantryName: "businessHours" },
);
```

Hooks you can attach with `defineMiddleware(fn, hooks)`:

- `init(api)`: once, with `store`, `clock`, `on(listener)` and `logger`.
- `onRegister(tool)`: for every wrapped tool. Throw `GantryConfigError` to refuse a registration.
- `reservedArgs(tool)`: JSON Schemas of extra arguments this module reads; Gantry adds them to the tool's input schema and strips them from `args`.

## Events

```ts
g.on((event) => metrics.increment(`gantry.${event.type}`, { tool: event.tool }));
```

Each event has `type`, `tool`, `principal`, `requestId`, `sessionId` and `at`, plus module fields such as `code` or `durationMs`. Events never contain tokens. Arguments and results only appear when `audit` is configured to include them, already redacted.
