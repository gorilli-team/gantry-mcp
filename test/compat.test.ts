import { Client as ClientV1 } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport as InMemoryV1 } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer as McpServerV1 } from "@modelcontextprotocol/sdk/server/mcp.js";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { GantryConfigError, gantry, getGantryPayload } from "../src/index.js";
import { approval, rateLimit } from "../src/modules/index.js";
import { gantryTest } from "../src/testing/index.js";
import type { CallContext, CallToolResult } from "../src/types.js";
import { newServer } from "./helpers.js";

const ok = (t: string) => ({ content: [{ type: "text" as const, text: t }] });
const txt = (r: CallToolResult) => (r.content[0] as { text?: string }).text;

describe("wrapExisting", () => {
  it("wraps tools registered directly on the server", async () => {
    const server = newServer();
    server.registerTool("plain", { inputSchema: z.object({ n: z.number() }) }, async ({ n }) =>
      ok(`n=${n}`),
    );
    server.registerTool("noargs", { annotations: { readOnlyHint: true } }, async () => ok("none"));
    const g = gantry(server, { use: [rateLimit({ perPrincipal: "2/min" })] });
    expect(g.wrapExisting().sort()).toEqual(["noargs", "plain"]);
    expect(g.wrapExisting()).toEqual([]);
    const t = await gantryTest(g);
    expect(txt(await t.call("plain", { n: 3 }))).toBe("n=3");
    expect(txt(await t.call("noargs"))).toBe("none");
    await expect(t.call("plain", { n: 3 })).resolves.toBeGantryError("RATE_LIMITED");
  });

  it("wraps a named subset and reports unknown names", () => {
    const server = newServer();
    server.registerTool("a", {}, async () => ok("a"));
    server.registerTool("b", {}, async () => ok("b"));
    const g = gantry(server);
    expect(g.wrapExisting(["a"])).toEqual(["a"]);
    expect(() => g.wrapExisting(["zzz"])).toThrow(GantryConfigError);
    expect(() => gantry({ registerTool: () => {} }).wrapExisting()).toThrow(GantryConfigError);
    const broken = { registerTool: () => {}, _registeredTools: { x: { handler: 1 } } };
    expect(() => gantry(broken as never).wrapExisting()).toThrow(/cannot wrap/);
  });

  it("reads reserved values from _meta for wrapped tools", async () => {
    const server = newServer();
    server.registerTool("drop", { annotations: { destructiveHint: true } }, async () =>
      ok("dropped"),
    );
    const secret = "x9F!kq2LmP0zR7vB4nT8wY1cH6jD3sGa";
    const g = gantry(server, { use: [approval({ mode: "token", secret })] });
    g.wrapExisting();
    const t = await gantryTest(g);
    const first = await t.call("drop");
    const token = String(getGantryPayload(first)?.approvalToken);
    await expect(
      t.call("drop", {}, { meta: { "gantry/approvalToken": token } }),
    ).resolves.toBeGantryOk();
  });
});

describe("SDK v1 compatibility", () => {
  async function connectV1(server: McpServerV1, capabilities: Record<string, unknown> = {}) {
    const [a, b] = InMemoryV1.createLinkedPair();
    const client = new ClientV1({ name: "v1-client", version: "1" }, { capabilities });
    await server.connect(a);
    await client.connect(b);
    return client;
  }

  it("runs the pipeline on a v1 McpServer", async () => {
    const server = new McpServerV1({ name: "v1", version: "1" });
    let seen: CallContext | undefined;
    const warn = vi.fn();
    const g = gantry(server as never, {
      logger: { warn, error: () => {} },
      use: [
        async (ctx, next) => {
          seen = ctx;
          return next();
        },
        approval({
          mode: "token",
          secret: "x9F!kq2LmP0zR7vB4nT8wY1cH6jD3sGa",
          when: (t) => t.name === "guarded",
        }),
      ],
    });
    g.tool(
      "echo",
      { inputSchema: { msg: z.string() } },
      async ({ msg }: { msg: string }, extra: { signal: AbortSignal }) =>
        ok(`${msg}:${extra.signal instanceof AbortSignal}`),
    );
    g.tool("guarded", { inputSchema: { msg: z.string() } }, async () => ok("guarded"));
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("SDK v1"));
    const client = await connectV1(server);
    const r = (await client.callTool({ name: "echo", arguments: { msg: "hi" } })) as CallToolResult;
    expect(txt(r)).toBe("hi:true");
    expect(seen?.client.name).toBe("v1-client");
    expect(seen?.args).toEqual({ msg: "hi" });
  });

  it("reads declared reserved fields on v1 and keeps them out of args", async () => {
    const server = new McpServerV1({ name: "v1", version: "1" });
    let seen: CallContext | undefined;
    const secret = "x9F!kq2LmP0zR7vB4nT8wY1cH6jD3sGa";
    const g = gantry(server as never, {
      logger: { warn: () => {}, error: () => {} },
      use: [
        async (ctx, next) => {
          seen = ctx;
          return next();
        },
        approval({ mode: "token", secret }),
      ],
    });
    let handlerArgs: unknown;
    g.tool(
      "drop",
      {
        inputSchema: { id: z.string(), _approvalToken: z.string().optional() },
        annotations: { destructiveHint: true },
      },
      async (args: unknown) => {
        handlerArgs = args;
        return ok("dropped");
      },
    );
    const client = await connectV1(server);
    const first = (await client.callTool({
      name: "drop",
      arguments: { id: "1" },
    })) as CallToolResult;
    const token = String(getGantryPayload(first)?.approvalToken);
    const hashBefore = seen?.argsHash;
    const second = (await client.callTool({
      name: "drop",
      arguments: { id: "1", _approvalToken: token },
    })) as CallToolResult;
    expect(txt(second)).toBe("dropped");
    expect(seen?.argsHash).toBe(hashBefore);
    expect(handlerArgs).toEqual({ id: "1" });
  });

  it("elicits through the v1 server API", async () => {
    const server = new McpServerV1({ name: "v1", version: "1" });
    const g = gantry(server as never, { use: [approval({})] });
    g.tool("drop", { annotations: { destructiveHint: true } }, async () => ok("dropped"));
    const client = await connectV1(server, { elicitation: {} });
    const { ElicitRequestSchema } = await import("@modelcontextprotocol/sdk/types.js");
    client.setRequestHandler(ElicitRequestSchema, async () => ({
      action: "accept",
      content: { approve: true },
    }));
    const r = (await client.callTool({ name: "drop", arguments: {} })) as CallToolResult;
    expect(txt(r)).toBe("dropped");
  });
});
