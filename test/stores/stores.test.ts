import { describe, expect, it } from "vitest";
import { memoryStore } from "../../src/store/memory.js";
import { mongoStore } from "../../stores/mongodb.js";
import { redisStore } from "../../stores/redis.js";
import { storeContract } from "./contract.js";
import { fakeCollection, fakeRedis } from "./fakes.js";

storeContract("memoryStore", () => memoryStore());
storeContract("redisStore (ioredis-style fake)", () => redisStore(fakeRedis("ioredis")));
storeContract("redisStore (node-redis-style fake)", () =>
  redisStore(fakeRedis("node-redis"), { prefix: "t:" }),
);
storeContract("mongoStore (fake collection)", () => mongoStore(fakeCollection()));

// Real servers, when available (CI runs them as service containers).
if (process.env.REDIS_URL) {
  const { Redis } = await import("ioredis");
  const client = new Redis(process.env.REDIS_URL);
  storeContract("redisStore (real Redis)", () =>
    redisStore(client, { prefix: `gantry-test:${Date.now()}:` }),
  );
}
if (process.env.MONGODB_URL) {
  const { MongoClient } = await import("mongodb");
  const client = await new MongoClient(process.env.MONGODB_URL).connect();
  const coll = client.db("gantry_test").collection(`store_${Date.now()}`);
  storeContract("mongoStore (real MongoDB)", () => mongoStore(coll as never));
}

describe("redisStore", () => {
  it("propagates connection errors so modules fail closed", async () => {
    const s = redisStore({ call: async () => Promise.reject(new Error("ECONNREFUSED")) });
    await expect(s.get("x")).rejects.toThrow("ECONNREFUSED");
  });
});

describe("mongoStore", () => {
  it("surfaces non-duplicate insert errors", async () => {
    const coll = { ...fakeCollection(), insertOne: async () => Promise.reject(new Error("down")) };
    await expect(mongoStore(coll).lock("k", 100)).rejects.toThrow("down");
  });
});
