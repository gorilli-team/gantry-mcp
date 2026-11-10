import { randomUUID } from "node:crypto";
import { LockBusyError } from "../src/errors.js";
import type { Store } from "../src/store/types.js";

interface Doc {
  _id: string;
  v: unknown;
  exp: Date | null;
}

/** The subset of a MongoDB `Collection` this store uses. */
export interface CollectionLike {
  findOne(filter: object): Promise<unknown>;
  replaceOne(filter: object, doc: object, options: { upsert: boolean }): Promise<unknown>;
  findOneAndDelete(filter: object): Promise<unknown>;
  findOneAndUpdate(
    filter: object,
    update: object,
    options: { returnDocument: "after" },
  ): Promise<unknown>;
  insertOne(doc: object): Promise<unknown>;
  deleteOne(filter: object): Promise<unknown>;
  createIndex?(spec: object, options: object): Promise<unknown>;
}

const DUPLICATE_KEY = 11000;
const isDuplicate = (e: unknown) => (e as { code?: number })?.code === DUPLICATE_KEY;

/**
 * Shared store on MongoDB. Pass a dedicated collection. A TTL index on `exp`
 * is created to clean up; expiry is also checked on every read, since TTL
 * deletion is lazy. Values are JSON encoded.
 */
export function mongoStore(
  collection: CollectionLike,
  options: { now?: () => number } = {},
): Store {
  const now = () => new Date(options.now?.() ?? Date.now());
  const alive = () => ({ $or: [{ exp: null }, { exp: { $gt: now() } }] });
  const expAt = (ttlMs?: number) =>
    ttlMs === undefined ? null : new Date(now().getTime() + Math.max(1, ttlMs));
  const decode = (doc: unknown) => {
    const d = doc as (Doc & { n?: number }) | null;
    if (typeof d?.n === "number") return d.n;
    return typeof d?.v === "string" ? JSON.parse(d.v) : undefined;
  };
  const indexReady = collection
    .createIndex?.({ exp: 1 }, { expireAfterSeconds: 0 })
    .catch(() => {});

  const insertFresh = async (id: string, fields: Record<string, unknown>, ttlMs?: number) => {
    try {
      await collection.insertOne({ _id: id, ...fields, exp: expAt(ttlMs) });
      return true;
    } catch (e) {
      if (!isDuplicate(e)) throw e;
      // An expired document still occupies the id: remove it and try once more.
      await collection.deleteOne({ _id: id, exp: { $lte: now() } });
      try {
        await collection.insertOne({ _id: id, ...fields, exp: expAt(ttlMs) });
        return true;
      } catch (e2) {
        if (isDuplicate(e2)) return false;
        throw e2;
      }
    }
  };

  return {
    kind: "mongodb",
    async get(key) {
      await indexReady;
      return decode(await collection.findOne({ _id: key, ...alive() }));
    },
    async set(key, value, ttlMs) {
      await collection.replaceOne(
        { _id: key },
        { _id: key, v: JSON.stringify(value ?? null), exp: expAt(ttlMs) },
        { upsert: true },
      );
    },
    async consume(key) {
      return decode(await collection.findOneAndDelete({ _id: key, ...alive() }));
    },
    async incr(key, by, ttlMs) {
      for (let attempt = 0; attempt < 5; attempt++) {
        const updated = (await collection.findOneAndUpdate(
          { _id: key, ...alive() },
          { $inc: { n: by } },
          { returnDocument: "after" },
        )) as { n?: number } | null;
        if (updated && typeof updated.n === "number") return updated.n;
        if (await insertFresh(key, { n: by }, ttlMs)) return by;
      }
      throw new Error("mongoStore.incr: too much contention");
    },
    async lock(key, ttlMs) {
      const id = `lock:${key}`;
      const owner = randomUUID();
      if (!(await insertFresh(id, { v: owner }, ttlMs)))
        throw new LockBusyError(`Lock "${key}" is held`);
      return async () => {
        await collection.deleteOne({ _id: id, v: owner });
      };
    },
  };
}
