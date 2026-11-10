import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { gantry, getGantryPayload } from "../src/index.js";
import { idempotency } from "../src/modules/idempotency.js";
import { memoryStore } from "../src/store/memory.js";
import { fakeClock, gantryTest } from "../src/testing/index.js";
import type { CallToolResult } from "../src/types.js";
import { newServer } from "./helpers.js";

const ok = (t: string): CallToolResult => ({ content: [{ type: "text", text: t }] });
const txt = (r: CallToolResult) => (r.content[0] as { text?: string }).text;
const quiet = { warn: () => {}, error: () => {} };

function setup(opts: Parameters<typeof idempotency>[0] = {}, store = memoryStore()) {
  const server = newServer();
  const g = gantry(server, { store, logger: quiet, use: [idempotency(opts)] });
  return { server, g, store };
}

describe("idempotency", () => {
  it("replays a successful result for the same args", async () => {
    const { g } = setup();
    let n = 0;
    g.tool("create", { inputSchema: { name: z.string() } }, async () => ok(`created ${++n}`));
    const t = await gantryTest(g);
    const first = await t.call("create", { name: "a" });
    const second = await t.call("create", { name: "a" });
    const other = await t.call("create", { name: "b" });
    expect(txt(first)).toBe("created 1");
    expect(txt(second)).toBe("created 1");
    expect(second._meta?.["gantry/replayed"]).toBe(true);
    expect(txt(other)).toBe("created 2");
    expect(t.events).toContainEvent({ type: "replayed", tool: "create" });
  });

  it("does not store failures and expires after the TTL", async () => {
    const { g } = setup({ ttl: "1h" });
    let n = 0;
    g.tool("flaky", {}, async () =>
      ++n === 1 ? { isError: true, content: [{ type: "text", text: "fail" }] } : ok(`ok ${n}`),
    );
    const t = await gantryTest(g);
    expect((await t.call("flaky")).isError).toBe(true);
    expect(txt(await t.call("flaky"))).toBe("ok 2");
    expect(txt(await t.call("flaky"))).toBe("ok 2");
    await t.clock.advance(3_600_000);
    expect(txt(await t.call("flaky"))).toBe("ok 3");
  });

  it("skips read-only tools by default and honours onlyFor", async () => {
    const { g } = setup();
    let n = 0;
    g.tool("read", { annotations: { readOnlyHint: true } }, async () => ok(`${++n}`));
    const t = await gantryTest(g);
    await t.call("read");
    expect(txt(await t.call("read"))).toBe("2");
    const tools = await t.client.listTools();
    expect(tools.tools[0]!.inputSchema.properties ?? {}).not.toHaveProperty("_idempotencyKey");
  });

  it("uses an explicit _idempotencyKey and rejects reuse with other args", async () => {
    const { g } = setup();
    let n = 0;
    g.tool("pay", { inputSchema: { amount: z.number() } }, async () => ok(`paid ${++n}`));
    const t = await gantryTest(g);
    const tools = await t.client.listTools();
    expect(tools.tools[0]!.inputSchema.properties).toHaveProperty("_idempotencyKey");
    expect(txt(await t.call("pay", { amount: 5, _idempotencyKey: "k1" }))).toBe("paid 1");
    expect(txt(await t.call("pay", { amount: 5, _idempotencyKey: "k1" }))).toBe("paid 1");
    expect(txt(await t.call("pay", { amount: 5, _idempotencyKey: "k2" }))).toBe("paid 2");
    await expect(t.call("pay", { amount: 9, _idempotencyKey: "k1" })).resolves.toBeGantryError(
      "IDEMPOTENCY_CONFLICT",
    );
  });

  it("scopes by principal unless configured otherwise", async () => {
    const store = memoryStore();
    const run = async (principal: string, scope?: "global") => {
      const server = newServer();
      const g = gantry(server, {
        store,
        logger: quiet,
        principal: () => principal,
        use: [idempotency({ scope })],
      });
      g.tool("t", {}, async () => ok(principal));
      const t = await gantryTest(g, { clock: false });
      return txt(await t.call("t"));
    };
    expect(await run("a")).toBe("a");
    expect(await run("b")).toBe("b");
    expect(await run("c", "global")).toBe("c");
    expect(await run("d", "global")).toBe("c");
  });

  it("supports session scope", async () => {
    const { g } = setup({ scope: "session" });
    let n = 0;
    g.tool("t", {}, async () => ok(`${++n}`));
    const t = await gantryTest(g);
    await t.call("t");
    expect(txt(await t.call("t"))).toBe("1");
  });

  it("makes concurrent duplicates wait for the first call (single process)", async () => {
    const { g } = setup();
    const handler = vi.fn(async () => {
      await new Promise((r) => setTimeout(r, 20));
      return ok("once");
    });
    g.tool("t", {}, handler);
    const t = await gantryTest(g, { clock: false });
    const results = await Promise.all(Array.from({ length: 10 }, () => t.call("t")));
    expect(handler).toHaveBeenCalledTimes(1);
    expect(results.every((r) => txt(r) === "once")).toBe(true);
  });

  it("waits across instances sharing a store, then replays", async () => {
    const store = memoryStore();
    const clock = fakeClock();
    let release!: () => void;
    const handler = vi.fn(
      () => new Promise<CallToolResult>((r) => (release = () => r(ok("first")))),
    );
    const mk = () => {
      const server = newServer();
      const g = gantry(server, {
        store,
        clock,
        logger: quiet,
        use: [idempotency({ waitFor: "10s" })],
      });
      g.tool("t", {}, handler);
      return g;
    };
    const a = await gantryTest(mk(), { clock });
    const b = await gantryTest(mk(), { clock });
    const p1 = a.call("t");
    await clock.advance(0);
    const p2 = b.call("t");
    await clock.advance(100);
    release();
    await clock.advance(2000);
    expect(txt(await p1)).toBe("first");
    expect(txt(await p2)).toBe("first");
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("refuses a concurrent call that reuses a key with different arguments", async () => {
    const { g } = setup({ scope: "global" });
    let release!: () => void;
    const handler = vi.fn(
      ({ to }: { to: string }) =>
        new Promise<CallToolResult>((r) => (release = () => r(ok(`secret result for ${to}`)))),
    );
    g.tool("pay", { inputSchema: { to: z.string() } }, handler);
    const t = await gantryTest(g, { clock: false });
    const first = t.call("pay", { to: "alice", _idempotencyKey: "K1" });
    await new Promise((r) => setTimeout(r, 20));
    const second = await t.call("pay", { to: "mallory", _idempotencyKey: "K1" });
    expect(second).toBeGantryError("IDEMPOTENCY_CONFLICT");
    expect(JSON.stringify(second)).not.toContain("secret result");
    release();
    expect(txt(await first)).toBe("secret result for alice");
    expect(handler).toHaveBeenCalledOnce();
  });

  it("returns DUPLICATE_IN_FLIGHT when the first call takes too long", async () => {
    const store = memoryStore();
    const clock = fakeClock();
    const mk = () => {
      const server = newServer();
      const g = gantry(server, {
        store,
        clock,
        logger: quiet,
        use: [idempotency({ waitFor: "1s" })],
      });
      g.tool("t", {}, () => new Promise(() => {}));
      return g;
    };
    const a = await gantryTest(mk(), { clock });
    const b = await gantryTest(mk(), { clock });
    void a.call("t");
    await clock.advance(0);
    const p2 = b.call("t");
    await clock.advance(5000);
    await expect(p2).resolves.toBeGantryError("DUPLICATE_IN_FLIGHT");
  });

  it("does not store results over maxResultBytes", async () => {
    const { g } = setup({ maxResultBytes: 100 });
    let n = 0;
    g.tool("big", {}, async () => ok(`${++n}`.padEnd(500, "x")));
    const t = await gantryTest(g);
    await t.call("big");
    expect(txt(await t.call("big"))?.startsWith("2")).toBe(true);
    expect(t.events).toContainEvent({ type: "idempotency_result_too_large" });
  });

  it("fails closed when the store is down", async () => {
    const handler = vi.fn(async () => ok("x"));
    const broken = { ...memoryStore(), get: async () => Promise.reject(new Error("down")) };
    const { g } = setup({}, broken);
    g.tool("t", {}, handler);
    const t = await gantryTest(g);
    const r = await t.call("t");
    expect(getGantryPayload(r)?.code).toBe("UNAVAILABLE");
    expect(handler).not.toHaveBeenCalled();
  });

  it("fails closed when locking errors and still returns results when saving fails", async () => {
    const lockBroken = { ...memoryStore(), lock: async () => Promise.reject(new Error("down")) };
    const a = setup({}, lockBroken);
    a.g.tool("t", {}, async () => ok("x"));
    await expect((await gantryTest(a.g)).call("t")).resolves.toBeGantryError("UNAVAILABLE");

    const setBroken = { ...memoryStore(), set: async () => Promise.reject(new Error("down")) };
    const b = setup({}, setBroken);
    b.g.tool("t", {}, async () => ok("ran"));
    const t = await gantryTest(b.g);
    expect(txt(await t.call("t"))).toBe("ran");
    expect(t.events).toContainEvent({ type: "idempotency_store_failed" });
  });

  it("propagates handler errors and does not store them", async () => {
    const { g } = setup();
    let n = 0;
    g.tool("t", {}, async () => {
      if (++n === 1) throw new Error("boom");
      return ok("second");
    });
    const t = await gantryTest(g);
    expect((await t.call("t")).isError).toBe(true);
    expect(txt(await t.call("t"))).toBe("second");
  });
});
