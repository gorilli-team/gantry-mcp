import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { gantry, getGantryPayload } from "../src/index.js";
import { audit, rateLimit } from "../src/modules/index.js";
import { redact } from "../src/redact.js";
import { fakeClock } from "../src/testing/clock.js";
import type { GantryEvent, Middleware } from "../src/types.js";
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

describe("audit", () => {
  it("records received and executed with timing, redacted", async () => {
    const events: GantryEvent[] = [];
    const { server, g } = await setup([
      audit({
        sink: (e) => void events.push(e),
        includeArgs: true,
        includeResult: true,
        redact: ["ssn"],
      }),
    ]);
    g.tool(
      "t",
      { inputSchema: { user: z.string(), password: z.string(), ssn: z.string() } },
      async () => ok("done"),
    );
    const { call } = await connect(server);
    await call("t", { user: "u", password: "hunter2", ssn: "123" });
    await vi.waitFor(() => expect(events.map((e) => e.type)).toEqual(["received", "executed"]));
    expect(events[0]!.args).toEqual({ user: "u", password: "[REDACTED]", ssn: "[REDACTED]" });
    expect(JSON.stringify(events)).not.toContain("hunter2");
    expect(events[1]!.durationMs).toBe(0);
    expect(events[1]!.result).toBeDefined();
  });

  it("omits args and results by default", async () => {
    const events: GantryEvent[] = [];
    const { server, g } = await setup([audit({ sink: (e) => void events.push(e) })]);
    g.tool("t", { inputSchema: { a: z.string() } }, async () => ok("x"));
    const { call } = await connect(server);
    await call("t", { a: "secret-ish" });
    await vi.waitFor(() => expect(events).toHaveLength(2));
    expect(events[0]!.args).toBeUndefined();
    expect(events[1]!.result).toBeUndefined();
  });

  it("records refusals with their code and handler errors as failed", async () => {
    const events: GantryEvent[] = [];
    const { server, g } = await setup([
      audit({ sink: (e) => void events.push(e) }),
      rateLimit({ perPrincipal: "1/min" }),
    ]);
    g.tool("t", {}, async () => ok("x"));
    g.tool("boom", {}, async () => {
      throw new Error("bad");
    });
    g.tool("soft", {}, async () => ({ isError: true, content: [{ type: "text", text: "nope" }] }));
    const { call } = await connect(server);
    await call("t");
    await call("t");
    await vi.waitFor(() =>
      expect(events.at(-1)).toMatchObject({ type: "refused", code: "RATE_LIMITED" }),
    );
  });

  it("records thrown and soft errors as failed", async () => {
    const events: GantryEvent[] = [];
    const { server, g } = await setup([audit({ sink: (e) => void events.push(e) })]);
    g.tool("boom", {}, async () => {
      throw new TypeError("bad");
    });
    g.tool("soft", {}, async () => ({ isError: true, content: [{ type: "text", text: "nope" }] }));
    const { call } = await connect(server);
    await call("boom");
    await call("soft");
    await vi.waitFor(() =>
      expect(events.filter((e) => e.type === "failed").map((e) => e.tool)).toEqual([
        "boom",
        "soft",
      ]),
    );
    expect(events.find((e) => e.tool === "boom" && e.type === "failed")?.error).toBe("TypeError");
  });

  it("fails closed when the sink cannot record the call", async () => {
    const handler = vi.fn(async () => ok("ran"));
    const { server, g } = await setup([
      audit({
        sink: async (e) => {
          if (e.type === "received") throw new Error("disk full");
        },
      }),
    ]);
    g.tool("t", {}, handler);
    const { call } = await connect(server);
    const r = await call("t");
    expect(getGantryPayload(r)?.code).toBe("UNAVAILABLE");
    expect(handler).not.toHaveBeenCalled();
  });

  it("can be configured to fail open", async () => {
    const { server, g } = await setup([
      audit({
        failClosed: false,
        sink: () => {
          throw new Error("down");
        },
      }),
    ]);
    g.tool("t", {}, async () => ok("ran"));
    const { call } = await connect(server);
    expect(text(await call("t"))).toBe("ran");
  });

  it("requires a sink", () => {
    expect(() => audit({} as never)).toThrow(TypeError);
  });
});

describe("redact", () => {
  it("keeps __proto__ keys as data", () => {
    const input = JSON.parse('{"a":1,"__proto__":{"evil":"payload"}}');
    const out = redact(input) as Record<string, unknown>;
    expect(Object.keys(out)).toEqual(["a", "__proto__"]);
    expect(JSON.stringify(out)).toContain("payload");
    expect(({} as Record<string, unknown>).evil).toBeUndefined();
  });

  it("scrubs Gantry tokens from string values", () => {
    const out = redact({ text: "use gat_eyJhIjoxfQ.abc-DEF_12 now", d: "gad_x.y" });
    expect(out).toEqual({ text: "use [REDACTED] now", d: "[REDACTED]" });
  });

  it("handles nesting, arrays, cycles, regex flags and depth", () => {
    const cyclic: Record<string, unknown> = { a: 1 };
    cyclic.self = cyclic;
    let deep: Record<string, unknown> = {};
    const root = deep;
    for (let i = 0; i < 30; i++) {
      deep.next = {};
      deep = deep.next as Record<string, unknown>;
    }
    const out = redact(
      { list: [{ apiKey: "k" }], cyclic, root, n: 10n, MySecretValue: "x", authToken: "t" },
      ["apiKey", /secret/gi, /token/i],
    ) as Record<string, unknown>;
    expect(out.list).toEqual([{ apiKey: "[REDACTED]" }]);
    expect((out.cyclic as Record<string, unknown>).self).toBe("[Circular]");
    expect(JSON.stringify(out.root)).toContain("[Truncated]");
    expect(out.n).toBe("10");
    expect(out.MySecretValue).toBe("[REDACTED]");
    expect(out.authToken).toBe("[REDACTED]");
  });
});
