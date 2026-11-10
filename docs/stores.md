# Stores

All modules share one store:

```ts
interface Store {
  get(key: string): Promise<unknown | undefined>;
  set(key: string, value: unknown, ttlMs?: number): Promise<void>;
  consume(key: string): Promise<unknown | undefined>;            // atomic get + delete
  incr(key: string, by: number, ttlMs: number): Promise<number>; // atomic
  lock(key: string, ttlMs: number): Promise<() => Promise<void>>; // rejects with LockBusyError when held
}
```

| Store | Import | When |
|---|---|---|
| `memoryStore()` | `@gorilli/gantry-mcp` | stdio servers, a single instance, tests |
| `redisStore(client)` | `@gorilli/gantry-mcp/stores/redis` | several instances; works with `ioredis` and `node-redis` |
| `mongoStore(collection)` | `@gorilli/gantry-mcp/stores/mongodb` | several instances, MongoDB already in your stack |

Multi-instance deployments must use a shared store, or rate limits, idempotency and approvals only hold per instance. Gantry warns at startup when `memoryStore` runs with an HTTP transport.

```ts
import { Redis } from "ioredis";
import { redisStore } from "@gorilli/gantry-mcp/stores/redis";

gantry(server, { store: redisStore(new Redis(process.env.REDIS_URL!)), use: [/* ... */] });
```

```ts
import { MongoClient } from "mongodb";
import { mongoStore } from "@gorilli/gantry-mcp/stores/mongodb";

const client = await new MongoClient(process.env.MONGODB_URL!).connect();
gantry(server, { store: mongoStore(client.db("app").collection("gantry")), use: [/* ... */] });
```

Every module treats a store error as a refusal (`UNAVAILABLE`), never as permission.

## Your own store

Implement the interface and run the contract suite in `test/stores/contract.ts` against it. Each operation must be atomic per key; `lock` must only release a lock its caller still owns.
