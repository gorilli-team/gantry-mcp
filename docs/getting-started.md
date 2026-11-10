# Getting started

```bash
npm install @gorilli/gantry-mcp @modelcontextprotocol/server zod
```

Gantry needs Node 22 or later and the official MCP TypeScript SDK (v2, `@modelcontextprotocol/server`; v1, `@modelcontextprotocol/sdk`, also works). It has no runtime dependencies of its own.

## One line

```ts
import { McpServer } from "@modelcontextprotocol/server";
import { gantry } from "@gorilli/gantry-mcp";

const server = new McpServer({ name: "crm", version: "1.0.0" });
const g = gantry(server, { use: gantry.recommended({ secret: process.env.GANTRY_SECRET }) });
```

Then register tools with `g.tool()` instead of `server.registerTool()`. The signature is the same:

```ts
g.tool(
  "delete_client",
  {
    description: "Delete a client and all its data",
    inputSchema: z.object({ clientId: z.string() }),
    annotations: { destructiveHint: true },
  },
  async ({ clientId }) => {
    await db.clients.delete(clientId);
    return { content: [{ type: "text", text: "Deleted" }] };
  },
);
```

## Already have tools?

```ts
server.registerTool(
  "legacy",
  {
    /* ... */
  },
  handler,
);
g.wrapExisting(); // wraps every tool registered so far
g.wrapExisting(["legacy"]); // or just some
```

`wrapExisting` cannot add Gantry's reserved arguments (`_approvalToken`, `_idempotencyKey`) to existing schemas. Clients can send them in request `_meta` as `gantry/approvalToken` and `gantry/idempotencyKey`, or you can declare them as optional string fields.

## One module at a time

`gantry.recommended()` is a convenience. You can pick modules yourself:

```ts
import { audit, rateLimit } from "@gorilli/gantry-mcp/modules";

gantry(server, { use: [audit({ sink: console.log }), rateLimit({ perPrincipal: "60/min" })] });
```

Each module is also importable on its own: `@gorilli/gantry-mcp/modules/approval`.

## Who is calling

Gantry reads a principal you supply. It defaults to `authInfo.clientId` (set by the SDK's bearer auth on HTTP transports) and falls back to `"anonymous"`:

```ts
gantry(server, { principal: (req) => req.authInfo?.clientId ?? "anonymous" });
```

If the resolver throws, the call is refused. On stdio there is usually one user, so the default is fine.

## The secret

Token and out-of-band approval sign with HMAC-SHA256. The secret must be at least 32 characters with real entropy, or Gantry refuses to start:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"
```
