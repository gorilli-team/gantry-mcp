import { describe, expect, it } from "vitest";
import { gantry, getGantryPayload } from "../src/index.js";
import { timeout } from "../src/modules/index.js";
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

describe("timeout", () => {
  it("aborts slow calls and returns TIMEOUT", async () => {
    let aborted = false;
    const { server, g, clock } = await setup([timeout({ default: "1s" })]);
    g.tool("slow", {}, (sdkCtx: { mcpReq: { signal: AbortSignal } }) => {
      return new Promise((_resolve, reject) => {
        sdkCtx.mcpReq.signal.addEventListener("abort", () => {
          aborted = true;
          reject(new Error("aborted"));
        });
      });
    });
    const { call } = await connect(server);
    const pending = call("slow");
    await clock.advance(1000);
    const r = await pending;
    expect(getGantryPayload(r)).toMatchObject({ code: "TIMEOUT", timeoutMs: 1000 });
    expect(text(r)).toContain("within 1s");
    expect(aborted).toBe(true);
  });

  it("uses per-tool overrides and clears timers on success", async () => {
    const { server, g, clock } = await setup([
      timeout({ default: "1s", perTool: { fast: "250ms" } }),
    ]);
    g.tool("fast", {}, async () => ok("quick"));
    g.tool("medium", {}, () => new Promise((r) => clock.setTimeout(() => r(ok("late")), 500)));
    const { call } = await connect(server);
    expect(text(await call("fast"))).toBe("quick");
    expect(clock.pending).toBe(0);
    const pending = call("medium");
    await clock.advance(500);
    expect(text(await pending)).toBe("late");

    g.tool("fast2", {}, () => new Promise((r) => clock.setTimeout(() => r(ok("late")), 500)));
  });

  it("times out per-tool overrides", async () => {
    const { server, g, clock } = await setup([timeout({ perTool: { t: "250ms" } })]);
    g.tool("t", {}, () => new Promise(() => {}));
    const { call } = await connect(server);
    const pending = call("t");
    await clock.advance(250);
    expect(text(await pending)).toContain("250ms");
  });
});
