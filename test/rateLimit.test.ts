import { describe, expect, it, vi } from "vitest";
import { gantry, getGantryPayload } from "../src/index.js";
import { rateLimit } from "../src/modules/index.js";
import { retryAfterMs } from "../src/modules/rateLimit.js";
import { memoryStore } from "../src/store/memory.js";
import { fakeClock } from "../src/testing/clock.js";
import type { Middleware } from "../src/types.js";
import { connect, newServer, text } from "./helpers.js";

const ok = (t: string) => ({ content: [{ type: "text", text: t }] });
const quiet = { warn: () => {}, error: () => {} };

async function setup(use: Middleware[], opts: { principal?: string } = {}) {
  const server = newServer();
  const clock = fakeClock();
  const g = gantry(server, {
    use,
    clock,
    logger: quiet,
    principal: () => opts.principal ?? "alice",
  });
  return { server, clock, g };
}

describe("rateLimit", () => {
  it("limits per principal and reports retry-after", async () => {
    const { server, g, clock } = await setup([rateLimit({ perPrincipal: "2/min" })]);
    g.tool("t", {}, async () => ok("x"));
    const { call } = await connect(server);
    expect((await call("t")).isError).toBeFalsy();
    expect((await call("t")).isError).toBeFalsy();
    const refused = await call("t");
    const payload = getGantryPayload(refused);
    expect(payload?.code).toBe("RATE_LIMITED");
    expect(payload?.retryAfterSeconds).toBeGreaterThan(0);
    expect(text(refused)).toMatch(/Retry after \d+s/);
    await clock.advance(120_000);
    expect((await call("t")).isError).toBeFalsy();
  });

  it("counts per tool separately and refusals do not consume", async () => {
    const { server, g } = await setup([rateLimit({ perTool: { send_email: "1/hour" } })]);
    g.tool("send_email", {}, async () => ok("sent"));
    g.tool("other", {}, async () => ok("o"));
    const { call } = await connect(server);
    expect(text(await call("send_email"))).toBe("sent");
    for (let i = 0; i < 3; i++) expect((await call("send_email")).isError).toBe(true);
    for (let i = 0; i < 3; i++) expect(text(await call("other"))).toBe("o");
  });

  it("isolates principals and rolls back earlier buckets on refusal", async () => {
    const store = memoryStore();
    const clock = fakeClock();
    const make = (principal: string) => {
      const server = newServer();
      const g = gantry(server, {
        store,
        clock,
        logger: quiet,
        principal: () => principal,
        use: [rateLimit({ perPrincipal: "10/min", perTool: { t: "1/min" } })],
      });
      g.tool("t", {}, async () => ok(principal));
      return server;
    };
    const a = await connect(make("a"));
    const b = await connect(make("b"));
    expect(text(await a.call("t"))).toBe("a");
    expect(text(await b.call("t"))).toBe("b");
    expect((await a.call("t")).isError).toBe(true);
    const keys = await store.get(`gantry:rl:principal:a:${Math.floor(clock.now() / 60_000)}`);
    expect(keys).toBe(1);
  });

  it("supports session, global and custom keys", async () => {
    const { server, g } = await setup([
      rateLimit({
        perSession: "5/min",
        global: "5/min",
        key: { by: (c) => (c.tool.name === "k" ? "x" : undefined), rate: "1/min" },
      }),
    ]);
    g.tool("k", {}, async () => ok("k"));
    g.tool("j", {}, async () => ok("j"));
    const { call } = await connect(server);
    expect(text(await call("k"))).toBe("k");
    expect(getGantryPayload(await call("k"))?.scope).toBe("key:custom");
    expect(text(await call("j"))).toBe("j");
  });

  it("fails closed when the store errors", async () => {
    const handler = vi.fn(async () => ok("x"));
    const broken = { ...memoryStore(), incr: async () => Promise.reject(new Error("redis down")) };
    const server = newServer();
    const g = gantry(server, {
      store: broken,
      logger: quiet,
      use: [rateLimit({ perPrincipal: "5/min" })],
    });
    g.tool("t", {}, handler);
    const { call } = await connect(server);
    expect(getGantryPayload(await call("t"))?.code).toBe("UNAVAILABLE");
    expect(handler).not.toHaveBeenCalled();
  });

  it("requires at least one limit", () => {
    expect(() => rateLimit({})).toThrow(TypeError);
  });

  it("computes retry-after for both windows", () => {
    // Current window already full: wait for rollover plus decay.
    expect(retryAfterMs({ prev: 0, cur: 2, limit: 2, windowMs: 60_000, elapsed: 10_000 })).toBe(
      80_000,
    );
    // Previous window still weighs in: wait for it to decay within this window.
    expect(retryAfterMs({ prev: 10, cur: 0, limit: 5, windowMs: 60_000, elapsed: 0 })).toBe(36_000);
    // Room in the count but no previous window: next window.
    expect(retryAfterMs({ prev: 0, cur: 0, limit: 1, windowMs: 1000, elapsed: 400 })).toBe(600);
  });
});
