import { SCRIPTS } from "../../stores/redis.js";

interface Entry {
  value: string;
  expiresAt: number;
}

/** A tiny Redis stand-in that understands the commands and scripts redisStore uses. */
export function fakeRedis(style: "ioredis" | "node-redis" = "ioredis") {
  const data = new Map<string, Entry>();
  const live = (k: string) => {
    const e = data.get(k);
    if (e && e.expiresAt <= Date.now()) data.delete(k);
    return data.get(k);
  };
  const run = async (command: string, args: string[]): Promise<unknown> => {
    switch (command.toUpperCase()) {
      case "GET":
        return live(args[0]!)?.value ?? null;
      case "SET": {
        const [key, value, ...opts] = args;
        const upper = opts.map((o) => o.toUpperCase());
        if (upper.includes("NX") && live(key!)) return null;
        const px = upper.indexOf("PX");
        data.set(key!, {
          value: value!,
          expiresAt: px >= 0 ? Date.now() + Number(opts[px + 1]) : Number.POSITIVE_INFINITY,
        });
        return "OK";
      }
      case "EVAL": {
        const [script, , key, ...argv] = args;
        if (script === SCRIPTS.consume) {
          const e = live(key!);
          data.delete(key!);
          return e?.value ?? null;
        }
        if (script === SCRIPTS.incr) {
          const e = live(key!);
          const n = Number(e?.value ?? 0) + Number(argv[0]);
          data.set(key!, {
            value: String(n),
            expiresAt: e ? e.expiresAt : Date.now() + Number(argv[1]),
          });
          return n;
        }
        if (script === SCRIPTS.release) {
          if (live(key!)?.value === argv[0]) {
            data.delete(key!);
            return 1;
          }
          return 0;
        }
        throw new Error("unknown script");
      }
      default:
        throw new Error(`unsupported ${command}`);
    }
  };
  return style === "ioredis"
    ? { call: (c: string, ...a: (string | number)[]) => run(c, a.map(String)) }
    : { sendCommand: ([c, ...a]: string[]) => run(c!, a) };
}

type Doc = Record<string, unknown> & { _id: string };

function matches(doc: Doc, filter: Record<string, unknown>): boolean {
  return Object.entries(filter).every(([k, cond]) => {
    if (k === "$or") return (cond as Record<string, unknown>[]).some((f) => matches(doc, f));
    const v = doc[k];
    if (cond && typeof cond === "object" && !(cond instanceof Date)) {
      const c = cond as { $gt?: Date; $lte?: Date };
      if (c.$gt) return v instanceof Date && v > c.$gt;
      if (c.$lte) return v instanceof Date && v <= c.$lte;
    }
    if (cond === null) return v === null || v === undefined;
    return v === cond;
  });
}

/** A tiny MongoDB collection stand-in for the operations mongoStore uses. */
export function fakeCollection() {
  const docs = new Map<string, Doc>();
  const find = (f: Record<string, unknown>) => [...docs.values()].find((d) => matches(d, f));
  return {
    async findOne(f: Record<string, unknown>) {
      return find(f) ?? null;
    },
    async replaceOne(f: Record<string, unknown>, doc: object) {
      docs.set(String(f._id), { ...(doc as Doc) });
    },
    async findOneAndDelete(f: Record<string, unknown>) {
      const d = find(f);
      if (d) docs.delete(d._id);
      return d ?? null;
    },
    async findOneAndUpdate(f: Record<string, unknown>, u: { $inc?: Record<string, number> }) {
      const d = find(f);
      if (!d) return null;
      for (const [k, by] of Object.entries(u.$inc ?? {})) d[k] = Number(d[k] ?? 0) + by;
      return { ...d };
    },
    async insertOne(doc: object) {
      const d = doc as Doc;
      if (docs.has(d._id)) throw Object.assign(new Error("dup"), { code: 11000 });
      docs.set(d._id, { ...d });
    },
    async deleteOne(f: Record<string, unknown>) {
      const d = find(f);
      if (d) docs.delete(d._id);
    },
    async createIndex() {},
  };
}
