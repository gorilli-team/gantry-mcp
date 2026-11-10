import { describe, expect, it } from "vitest";
import { z } from "zod";
import { gantry, gantryError } from "../src/index.js";
import { audit, rateLimit, timeout } from "../src/modules/index.js";
import { clientProfiles, fakeClock, gantryMatchers, gantryTest } from "../src/testing/index.js";
import type { GantryEvent } from "../src/types.js";
import { newServer } from "./helpers.js";

const ok = (t: string) => ({ content: [{ type: "text", text: t }] });

describe("gantryTest", () => {
  it("calls tools in process and collects events", async () => {
    const server = newServer();
    const g = gantry(server, { use: [audit({ sink: () => {} })] });
    g.tool("echo", { inputSchema: { msg: z.string() } }, async ({ msg }: { msg: string }) =>
      ok(msg),
    );
    const t = await gantryTest(g, { principal: "alice" });
    const res = await t.call("echo", { msg: "hi" });
    expect(res).toBeGantryOk();
    expect(t.events).toContainEvent({ type: "executed", tool: "echo", principal: "alice" });
    expect(t.events).not.toContainEvent({ type: "refused" });
    await t.close();
  });

  it("drives rate limits and timeouts with the fake clock", async () => {
    const server = newServer();
    const g = gantry(server, {
      use: [rateLimit({ perTool: { t: "1/min" } }), timeout({ default: "5s" })],
    });
    g.tool("t", {}, async () => ok("x"));
    g.tool("hang", {}, () => new Promise(() => {}));
    const t = await gantryTest(g);
    await expect(t.call("t")).resolves.toBeGantryOk();
    await expect(t.call("t")).resolves.toBeGantryError("RATE_LIMITED");
    await t.clock.advance(120_000);
    await expect(t.call("t")).resolves.toBeGantryOk();
    const pending = t.call("hang");
    await t.clock.advance(5_000);
    await expect(pending).resolves.toBeGantryError("TIMEOUT");
  });

  it("simulates elicitation answers and records requests", async () => {
    const server = newServer();
    const g = gantry(server);
    g.tool(
      "ask",
      {},
      async (sdkCtx: { gantry: { elicit?: (r: unknown) => Promise<{ action: string }> } }) => {
        const r = await sdkCtx.gantry.elicit!({
          message: "Proceed?",
          requestedSchema: { type: "object", properties: {} },
        });
        return ok(r.action);
      },
    );
    const t = await gantryTest(g, { clientCapabilities: clientProfiles.elicitation, clock: false });
    t.elicitation.respond({ action: "accept" });
    const first = await t.call("ask");
    const second = await t.call("ask");
    expect((first.content[0] as { text?: string }).text).toBe("accept");
    expect((second.content[0] as { text?: string }).text).toBe("cancel");
    expect(t.elicitation.requests).toHaveLength(2);
    expect(t.elicitation.requests[0]!.message).toBe("Proceed?");
    expect(() => t.clock).toThrow(/clock: false/);
  });

  it("supports full client profiles, meta and custom clocks", async () => {
    const server = newServer();
    let caps: unknown;
    let reserved: unknown;
    const g = gantry(server, {
      use: [
        async (ctx, next) => {
          caps = ctx.client.capabilities;
          reserved = ctx.reserved;
          return next();
        },
      ],
    });
    g.tool("t", {}, async () => ok("x"));
    const clock = fakeClock(0);
    const t = await gantryTest(g, { clientCapabilities: clientProfiles.full, clock });
    await t.call("t", {}, { meta: { "gantry/idempotencyKey": "abc" } });
    expect(caps).toMatchObject({ elicitation: {}, roots: {} });
    expect(reserved).toEqual({ _idempotencyKey: "abc" });
    expect(t.clock).toBe(clock);
  });
});

describe("matchers", () => {
  const ctx = { equals: (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b) };
  it("produce helpful messages", () => {
    const err = gantryError("RATE_LIMITED", "slow down");
    expect(gantryMatchers.toBeGantryOk.call(ctx, err).message()).toContain(
      "expected the call to succeed",
    );
    expect(gantryMatchers.toBeGantryOk.call(ctx, ok("x")).message()).toContain("not to succeed");
    expect(gantryMatchers.toBeGantryError.call(ctx, ok("x"), "TIMEOUT").message()).toContain(
      "TIMEOUT",
    );
    expect(gantryMatchers.toBeGantryError.call(ctx, err).pass).toBe(true);
    expect(gantryMatchers.toBeGantryError.call(ctx, err, "TIMEOUT").pass).toBe(false);
    expect(gantryMatchers.toBeGantryError.call(ctx, err).message()).toContain("not to be refused");
    const events = [{ type: "a" }] as GantryEvent[];
    expect(gantryMatchers.toContainEvent.call(ctx, events, { type: "b" }).message()).toContain(
      "types: a",
    );
    expect(gantryMatchers.toContainEvent.call(ctx, events, { type: "a" }).message()).toContain(
      "no event",
    );
    expect(gantryMatchers.toContainEvent.call(ctx, "nope", { type: "a" }).pass).toBe(false);
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(gantryMatchers.toBeGantryOk.call(ctx, { isError: true, cyclic }).message()).toContain(
      "[object Object]",
    );
  });
});
