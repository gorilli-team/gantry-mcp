# annotations

Makes tool annotations mean something.

```ts
annotations({ enforce: true, strict: true });
```

**enforce** (default on). In a tool marked `readOnlyHint: true`:

- `ctx.gantry.fetch` refuses methods other than `GET`, `HEAD`, `OPTIONS`.
- `ctx.gantry.clients.*` (the clients you passed to `gantry({ clients })`) are proxied: methods that look like writes (`insert*`, `update*`, `delete*`, `create*`, `send*`, ...) throw, as do assignments and deletes. Configure the list with `writeMethods`.

A blocked write returns `ANNOTATION_VIOLATION`.

```ts
const g = gantry(server, { clients: { db }, use: [annotations()] });
g.tool("list_clients", { annotations: { readOnlyHint: true } }, async (ctx) => {
  const db = ctx.gantry.clients.db as Db;
  return text(JSON.stringify(await db.clients.find())); // allowed
});
```

Values returned by guarded methods (including awaited promises) and arguments passed to callbacks (such as `tx` in `db.transaction(tx => ...)`) are guarded too.

**Limits.** Methods that run raw queries (`query`, `raw`, `sql`) cannot be classified from their name, so they are allowed by default; add them to `writeMethods` if your read-only tools should never send raw SQL. Enforcement only covers I/O through `ctx.gantry.fetch` and `ctx.gantry.clients`. Gantry cannot see a handler that imports its own database client or calls the global `fetch`. Treat this as a guard rail against mistakes, not a sandbox.

**strict** (default off). Refuses to register a tool whose name looks like a write (`delete_`, `send_`, `update_`, `create_`, ...) without `readOnlyHint` or `destructiveHint`, and tools that declare both.

## When you don't need this

Your read-only tools use credentials that cannot write (a read replica, a read-only API key). That is the stronger control.
