import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
  AnnotationViolationError,
  compose,
  defineMiddleware,
  GantryConfigError,
  gantry,
  getGantryPayload,
} from "../src/index.js";
import type { CallContext, GantryEvent, Middleware } from "../src/types.js";
import { connect, newServer, text } from "./helpers.js";

const ok = (t: string) => ({ content: [{ type: "text", text: t }] });

describe("gantry pipeline", () => {
  it("runs middlewares in order around the handler", async () => {
    const server = newServer();
    const order: string[] = [];
    const mw =
      (name: string): Middleware =>
      async (_ctx, next) => {
        order.push(`${name}:before`);
        const r = await next();
        order.push(`${name}:after`);
        return r;
      };
    const g = gantry(server, { use: [mw("a"), mw("b")] });
    g.tool("echo", { inputSchema: { msg: z.string() } }, async ({ msg }: { msg: string }) => {
      order.push("handler");
      return ok(msg);
    });
    const { call } = await connect(server);
    const r = await call("echo", { msg: "hi" });
    expect(text(r)).toBe("hi");
    expect(order).toEqual(["a:before", "b:before", "handler", "b:after", "a:after"]);
  });

  it("builds a context with principal, hash, ids and annotations", async () => {
    const server = newServer();
    let seen: CallContext | undefined;
    const g = gantry(server, {
      principal: () => "alice",
      use: [
        async (ctx, next) => {
          seen = ctx;
          return next();
        },
      ],
    });
    g.tool(
      "t",
      {
        inputSchema: z.object({ b: z.number(), a: z.string() }),
        annotations: { readOnlyHint: true },
      },
      async () => ok("x"),
    );
    const { call } = await connect(server, { capabilities: { elicitation: {} } });
    await call("t", { a: "1", b: 2 });
    expect(seen?.principal).toBe("alice");
    expect(seen?.args).toEqual({ a: "1", b: 2 });
    expect(seen?.argsHash).toMatch(/^[0-9a-f]{64}$/);
    expect(seen?.requestId).toMatch(/^[0-9a-f-]{36}$/);
    expect(seen?.tool.annotations.readOnlyHint).toBe(true);
    expect(seen?.client.name).toBe("test-client");
    expect(seen?.client.capabilities.elicitation).toBeDefined();
    expect(typeof seen?.elicit).toBe("function");
  });

  it("defaults principal to anonymous and supports tools without input", async () => {
    const server = newServer();
    let principal = "";
    const g = gantry(server, {
      use: [
        async (ctx, next) => {
          principal = ctx.principal;
          return next();
        },
      ],
    });
    g.tool("noargs", { description: "x" }, async (sdkCtx: { gantry: CallContext }) =>
      ok(`has gantry: ${!!sdkCtx.gantry}`),
    );
    const { call } = await connect(server);
    expect(text(await call("noargs"))).toBe("has gantry: true");
    expect(principal).toBe("anonymous");
  });

  it("refuses when the principal resolver throws (fails closed)", async () => {
    const server = newServer();
    const handler = vi.fn(async () => ok("ran"));
    const g = gantry(server, {
      principal: () => {
        throw new Error("no auth");
      },
      logger: { warn: () => {}, error: () => {} },
    });
    g.tool("t", {}, handler);
    const { call } = await connect(server);
    const r = await call("t");
    expect(r.isError).toBe(true);
    expect(getGantryPayload(r)?.code).toBe("UNAVAILABLE");
    expect(handler).not.toHaveBeenCalled();
  });

  it("lets a middleware short-circuit", async () => {
    const server = newServer();
    const handler = vi.fn(async () => ok("ran"));
    const g = gantry(server, { use: [async () => ok("blocked")] });
    g.tool("t", {}, handler);
    const { call } = await connect(server);
    expect(text(await call("t"))).toBe("blocked");
    expect(handler).not.toHaveBeenCalled();
  });

  it("dispatches events with base fields and survives throwing listeners", async () => {
    const server = newServer();
    const events: GantryEvent[] = [];
    const g = gantry(server, {
      principal: () => "bob",
      logger: { warn: () => {}, error: () => {} },
      use: [
        async (ctx, next) => {
          ctx.emit({ type: "custom", extra: 1 });
          return next();
        },
      ],
    });
    g.on(() => {
      throw new Error("listener bug");
    });
    const off = g.on((e) => events.push(e));
    g.tool("t", {}, async () => ok("x"));
    const { call } = await connect(server);
    await call("t");
    off();
    await call("t");
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: "custom", tool: "t", principal: "bob", extra: 1 });
    expect(typeof events[0]!.at).toBe("number");
  });

  it("passes a combined abort signal to the handler", async () => {
    const server = newServer();
    const g = gantry(server, {
      use: [
        async (ctx, next) => {
          ctx.abort(new Error("stop"));
          return next();
        },
      ],
    });
    g.tool("t", {}, async (sdkCtx: { mcpReq: { signal: AbortSignal } }) =>
      ok(`aborted=${sdkCtx.mcpReq.signal.aborted}`),
    );
    const { call } = await connect(server);
    expect(text(await call("t"))).toBe("aborted=true");
  });

  it("turns AnnotationViolationError into a structured refusal", async () => {
    const server = newServer();
    const g = gantry(server);
    g.tool("t", {}, async () => {
      throw new AnnotationViolationError("Write attempted.");
    });
    const { call } = await connect(server);
    const r = await call("t");
    expect(getGantryPayload(r)?.code).toBe("ANNOTATION_VIOLATION");
  });

  it("keeps the SDK behavior for other handler errors", async () => {
    const server = newServer();
    const g = gantry(server);
    g.tool("t", {}, async () => {
      throw new Error("boom");
    });
    const { call } = await connect(server);
    const r = await call("t");
    expect(r.isError).toBe(true);
    expect(text(r)).toContain("boom");
  });

  it("adds reserved arguments to the schema and strips them from args", async () => {
    const server = newServer();
    let ctxSeen: CallContext | undefined;
    const reservedMw = defineMiddleware(
      async (ctx, next) => {
        ctxSeen = ctx;
        return next();
      },
      { reservedArgs: () => ({ _approvalToken: { type: "string" } }) },
    );
    const g = gantry(server, { use: [reservedMw] });
    let handlerArgs: unknown;
    g.tool(
      "t",
      { inputSchema: { id: z.string(), n: z.number().optional() } },
      async (args: unknown) => {
        handlerArgs = args;
        return ok("x");
      },
    );
    g.tool("noinput", {}, async () => ok("y"));
    const { call, client } = await connect(server);
    const tools = await client.listTools();
    const schema = tools.tools.find((t) => t.name === "t")!.inputSchema as {
      properties: Record<string, unknown>;
      required?: string[];
    };
    expect(Object.keys(schema.properties).sort()).toEqual(["_approvalToken", "id", "n"]);
    expect(schema.required).toEqual(["id"]);

    await call("t", { id: "a", _approvalToken: "tok" });
    expect(handlerArgs).toEqual({ id: "a" });
    expect(ctxSeen?.reserved).toEqual({ _approvalToken: "tok" });

    const bad = await call("t", { id: "a", _approvalToken: 5 });
    expect(bad.isError).toBe(true);
    const invalid = await call("t", { id: 5 });
    expect(invalid.isError).toBe(true);

    expect(text(await call("noinput", { _approvalToken: "tok2" }))).toBe("y");
    expect(ctxSeen?.reserved).toEqual({ _approvalToken: "tok2" });
  });

  it("reads reserved values from request _meta", async () => {
    const server = newServer();
    let reserved: unknown;
    const g = gantry(server, {
      use: [
        async (ctx, next) => {
          reserved = ctx.reserved;
          return next();
        },
      ],
    });
    g.tool("t", {}, async () => ok("x"));
    const { client } = await connect(server);
    await client.callTool({
      name: "t",
      arguments: {},
      _meta: { "gantry/idempotencyKey": "k1", other: 1 },
    });
    expect(reserved).toEqual({ _idempotencyKey: "k1" });
  });

  it("validates configuration at startup", () => {
    expect(() => gantry({} as never)).toThrow(GantryConfigError);
    expect(() => gantry(newServer(), { use: [42 as never] })).toThrow(GantryConfigError);
  });

  it("calls onRegister and init hooks", () => {
    const onRegister = vi.fn();
    const init = vi.fn();
    const g = gantry(newServer(), {
      use: [defineMiddleware(async (_c, n) => n(), { onRegister, init })],
    });
    g.tool("x", { annotations: { destructiveHint: true } }, async () => ok(""));
    expect(init).toHaveBeenCalledOnce();
    expect(onRegister).toHaveBeenCalledWith(expect.objectContaining({ name: "x" }));
  });

  it("warns when memoryStore is used with an HTTP transport", async () => {
    const warn = vi.fn();
    const server = { registerTool: vi.fn(), connect: vi.fn(async (_t: unknown) => {}) };
    gantry(server, { logger: { warn, error: () => {} } });
    class StreamableHTTPServerTransport {}
    await server.connect(new StreamableHTTPServerTransport());
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("memoryStore"));
  });
});

describe("compose", () => {
  it("rejects calling next twice", async () => {
    const run = compose(
      [
        async (_ctx, next) => {
          await next();
          return next();
        },
      ],
      async () => ok("x"),
    );
    await expect(run({ tool: { name: "t" } } as CallContext)).rejects.toThrow(/more than once/);
  });
});
