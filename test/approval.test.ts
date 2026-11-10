import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { GantryConfigError, gantry, getGantryPayload } from "../src/index.js";
import {
  type ApprovalRequest,
  approval,
  escapeHtml,
  escapeMarkdown,
  idempotency,
  sanitizePreview,
} from "../src/modules/index.js";
import { memoryStore } from "../src/store/memory.js";
import { clientProfiles, gantryTest } from "../src/testing/index.js";
import type { CallToolResult } from "../src/types.js";
import { newServer } from "./helpers.js";

const SECRET = "x9F!kq2LmP0zR7vB4nT8wY1cH6jD3sGa";
const ok = (t: string): CallToolResult => ({ content: [{ type: "text", text: t }] });
const txt = (r: CallToolResult) => (r.content[0] as { text?: string }).text ?? "";
const quiet = { warn: () => {}, error: () => {} };

function setup(opts: Parameters<typeof approval>[0], extra: { principal?: () => string } = {}) {
  const server = newServer();
  const appr = approval(opts);
  const handler = vi.fn(async ({ clientId }: { clientId: string }) => ok(`deleted ${clientId}`));
  const g = gantry(server, { logger: quiet, use: [appr], ...extra });
  g.tool(
    "delete_client",
    { inputSchema: { clientId: z.string() }, annotations: { destructiveHint: true } },
    handler,
  );
  g.tool("list_clients", { annotations: { readOnlyHint: true } }, async () => ok("list"));
  return { g, appr, handler };
}

describe("approval: configuration", () => {
  it("refuses weak or missing secrets for token and out-of-band modes", () => {
    expect(() => approval({ mode: "token" })).toThrow(GantryConfigError);
    expect(() => approval({ mode: "token", secret: "short" })).toThrow(/at least 32/);
    expect(() => approval({ mode: "token", secret: "a".repeat(64) })).toThrow(/entropy/);
    expect(() => approval({ mode: "out-of-band", secret: SECRET })).toThrow(/notifier/);
    expect(() => approval({ mode: "nope" as never })).toThrow(/unknown mode/);
    expect(() => approval({ mode: "elicit" })).not.toThrow();
  });
});

describe("approval: elicit", () => {
  it("runs after the human accepts, and skips tools that do not need approval", async () => {
    const { g, handler } = setup({});
    const t = await gantryTest(g, { clientCapabilities: clientProfiles.elicitation });
    expect(txt(await t.call("list_clients"))).toBe("list");
    t.elicitation.respond({ action: "accept", content: { approve: true } });
    const res = await t.call("delete_client", { clientId: "c1" });
    expect(res).toBeGantryOk();
    expect(handler).toHaveBeenCalledOnce();
    expect(t.events).toContainEvent({ type: "approved", tool: "delete_client", mode: "elicit" });
    expect(t.elicitation.requests[0]!.message).toContain('delete_client {"clientId":"c1"}');
  });

  it("refuses on decline, cancel or approve=false", async () => {
    const { g, handler } = setup({});
    const t = await gantryTest(g, { clientCapabilities: clientProfiles.elicitation });
    t.elicitation.respond({ action: "decline" });
    await expect(t.call("delete_client", { clientId: "c1" })).resolves.toBeGantryError(
      "APPROVAL_DENIED",
    );
    t.elicitation.respond({ action: "accept", content: { approve: false } });
    await expect(t.call("delete_client", { clientId: "c1" })).resolves.toBeGantryError(
      "APPROVAL_DENIED",
    );
    const cancelled = await t.call("delete_client", { clientId: "c1" }); // no answer queued -> cancel
    expect(txt(cancelled)).toContain("dismissed");
    expect(handler).not.toHaveBeenCalled();
  });

  it("refuses when the client cannot elicit and nothing else is configured", async () => {
    const { g, handler } = setup({});
    const t = await gantryTest(g);
    const r = await t.call("delete_client", { clientId: "c1" });
    expect(r).toBeGantryError("APPROVAL_REQUIRED");
    expect(getGantryPayload(r)?.reason).toBe("no_channel");
    expect(handler).not.toHaveBeenCalled();
  });

  it("refuses, and does not fall back, when elicitation throws", async () => {
    const server = newServer();
    const g = gantry(server, {
      logger: quiet,
      use: [approval({ fallback: ["token"], secret: SECRET })],
    });
    g.tool("drop", { annotations: { destructiveHint: true } }, async () => ok("dropped"));
    g._testing.elicit = async () => {
      throw new Error("not on this era");
    };
    const t = await gantryTest(g);
    await expect(t.call("drop")).resolves.toBeGantryError("UNAVAILABLE");
  });

  it("ignores per-request capabilities that contradict the session (no downgrade)", async () => {
    const server = newServer();
    const handler = vi.fn(async () => ok("wiped"));
    const g = gantry(server, {
      logger: quiet,
      use: [approval({ fallback: ["token"], secret: SECRET })],
    });
    g.tool("wipe", { annotations: { destructiveHint: true } }, handler);
    const t = await gantryTest(g, { clientCapabilities: clientProfiles.elicitation });
    const spoof = { "io.modelcontextprotocol/clientCapabilities": {} };
    t.elicitation.respond({ action: "decline" });
    const r = await t.call("wipe", {}, { meta: spoof });
    expect(r).toBeGantryError("APPROVAL_DENIED");
    expect(t.elicitation.requests).toHaveLength(1);
    expect(handler).not.toHaveBeenCalled();
  });

  it("sanitizes custom previews and falls back when they throw", async () => {
    const { g } = setup({ preview: () => "Delete ‮evil\u0007 now" });
    const t = await gantryTest(g, { clientCapabilities: clientProfiles.elicitation });
    t.elicitation.respond({ action: "decline" });
    await t.call("delete_client", { clientId: "c1" });
    expect(t.elicitation.requests[0]!.message).toContain("Delete evil now");

    const b = setup({
      preview: () => {
        throw new Error("bug");
      },
    });
    const t2 = await gantryTest(b.g, { clientCapabilities: clientProfiles.elicitation });
    await t2.call("delete_client", { clientId: "c2" });
    expect(t2.elicitation.requests[0]!.message).toContain('"clientId":"c2"');
  });
});

describe("approval: token", () => {
  const tokenOf = (r: CallToolResult) => String(getGantryPayload(r)?.approvalToken);

  it("proposes, then executes once with the bound token", async () => {
    const { g, handler } = setup({ mode: "token", secret: SECRET });
    const t = await gantryTest(g, { principal: "alice" });
    const tools = await t.client.listTools();
    const del = tools.tools.find((x) => x.name === "delete_client")!;
    expect(del.inputSchema.properties).toHaveProperty("_approvalToken");
    const list = tools.tools.find((x) => x.name === "list_clients")!;
    expect(list.inputSchema.properties ?? {}).not.toHaveProperty("_approvalToken");

    const proposal = await t.call("delete_client", { clientId: "c1" });
    expect(proposal).toBeGantryError("APPROVAL_REQUIRED");
    const token = tokenOf(proposal);
    expect(token).toMatch(/^gat_/);
    expect(txt(proposal)).toContain(token);
    expect(handler).not.toHaveBeenCalled();

    await expect(
      t.call("delete_client", { clientId: "c1", _approvalToken: token }),
    ).resolves.toBeGantryOk();
    expect(handler).toHaveBeenCalledOnce();
    expect(t.events).toContainEvent({ type: "approved", mode: "token" });
    expect(JSON.stringify(t.events)).not.toContain(token);

    // Single use.
    await expect(
      t.call("delete_client", { clientId: "c1", _approvalToken: token }),
    ).resolves.toBeGantryError("APPROVAL_INVALID");
    expect(handler).toHaveBeenCalledOnce();
  });

  it("is single use under concurrency", async () => {
    const { g, handler } = setup({ mode: "token", secret: SECRET });
    const t = await gantryTest(g);
    const token = tokenOf(await t.call("delete_client", { clientId: "c1" }));
    const results = await Promise.all(
      Array.from({ length: 10 }, () =>
        t.call("delete_client", { clientId: "c1", _approvalToken: token }),
      ),
    );
    expect(results.filter((r) => !r.isError)).toHaveLength(1);
    expect(handler).toHaveBeenCalledOnce();
  });

  it("rejects tokens for other args, tampered tokens and foreign secrets", async () => {
    const { g, handler } = setup({ mode: "token", secret: SECRET });
    const t = await gantryTest(g);
    const token = tokenOf(await t.call("delete_client", { clientId: "c1" }));
    await expect(
      t.call("delete_client", { clientId: "c2", _approvalToken: token }),
    ).resolves.toBeGantryError("APPROVAL_INVALID");
    const [body, mac] = token.slice(4).split(".");
    const forgedBody = Buffer.from(
      JSON.stringify({
        ...JSON.parse(Buffer.from(body!, "base64url").toString()),
        argsHash: "0".repeat(64),
      }),
    ).toString("base64url");
    for (const bad of [
      `gat_${forgedBody}.${mac}`,
      `${token}x`,
      "gat_abc",
      "gat_.x",
      "nope",
      `gat_${body}.`,
    ]) {
      await expect(
        t.call("delete_client", { clientId: "c1", _approvalToken: bad }),
      ).resolves.toBeGantryError("APPROVAL_INVALID");
    }
    const other = setup({ mode: "token", secret: `${SECRET}-other-secret` });
    const t2 = await gantryTest(other.g);
    await expect(
      t2.call("delete_client", { clientId: "c1", _approvalToken: token }),
    ).resolves.toBeGantryError("APPROVAL_INVALID");
    expect(handler).not.toHaveBeenCalled();
    // The original token still works: failed attempts do not burn it.
    await expect(
      t.call("delete_client", { clientId: "c1", _approvalToken: token }),
    ).resolves.toBeGantryOk();
  });

  it("binds tokens to the principal", async () => {
    let who = "alice";
    const { g } = setup({ mode: "token", secret: SECRET }, { principal: () => who });
    const t = await gantryTest(g);
    const token = tokenOf(await t.call("delete_client", { clientId: "c1" }));
    who = "mallory";
    await expect(
      t.call("delete_client", { clientId: "c1", _approvalToken: token }),
    ).resolves.toBeGantryError("APPROVAL_INVALID");
  });

  it("expires tokens", async () => {
    const { g } = setup({ mode: "token", secret: SECRET, ttl: "1m" });
    const t = await gantryTest(g);
    const token = tokenOf(await t.call("delete_client", { clientId: "c1" }));
    await t.clock.advance(61_000);
    await expect(
      t.call("delete_client", { clientId: "c1", _approvalToken: token }),
    ).resolves.toBeGantryError("APPROVAL_EXPIRED");
  });

  it("refuses tokens when token mode is not enabled", async () => {
    const { g } = setup({});
    const t = await gantryTest(g, { clientCapabilities: clientProfiles.elicitation });
    await expect(
      t.call("delete_client", { clientId: "c1" }, { meta: { "gantry/approvalToken": "gat_x.y" } }),
    ).resolves.toBeGantryError("APPROVAL_INVALID");
  });

  it("fails closed when the store is down", async () => {
    const server = newServer();
    const store = {
      ...memoryStore(),
      set: async () => Promise.reject(new Error("down")),
      consume: async () => Promise.reject(new Error("down")),
    };
    const appr = approval({ mode: "token", secret: SECRET });
    const g = gantry(server, { store, logger: quiet, use: [appr] });
    g.tool("drop", { annotations: { destructiveHint: true } }, async () => ok("x"));
    const t = await gantryTest(g);
    await expect(t.call("drop")).resolves.toBeGantryError("UNAVAILABLE");
  });

  it("works with idempotency: a replay after approval does not ask again", async () => {
    const server = newServer();
    const handler = vi.fn(async () => ok("deleted"));
    const g = gantry(server, {
      logger: quiet,
      use: [idempotency({ ttl: "24h" }), approval({ mode: "elicit", secret: SECRET })],
    });
    g.tool(
      "delete_client",
      { inputSchema: { clientId: z.string() }, annotations: { destructiveHint: true } },
      handler,
    );
    const t = await gantryTest(g, { principal: "alice", clientCapabilities: { elicitation: {} } });
    t.elicitation.respond({ action: "accept", content: { approve: true } });
    await expect(t.call("delete_client", { clientId: "c1" })).resolves.toBeGantryOk();
    expect(t.events).toContainEvent({ type: "approved", tool: "delete_client" });
    await expect(t.call("delete_client", { clientId: "c1" })).resolves.toBeGantryOk();
    expect(handler).toHaveBeenCalledOnce();
    expect(t.elicitation.requests).toHaveLength(1);
  });
});

describe("approval: out-of-band", () => {
  function oob(extra: Partial<Parameters<typeof approval>[0]> = {}) {
    const sent: ApprovalRequest[] = [];
    const s = setup({
      mode: "out-of-band",
      secret: SECRET,
      notifier: (r) => void sent.push(r),
      ...extra,
    });
    return { ...s, sent };
  }

  it("notifies the human, waits for the decision, then executes once", async () => {
    const { g, appr, handler, sent } = oob();
    const t = await gantryTest(g, { principal: "alice" });
    const first = await t.call("delete_client", { clientId: "c1" });
    expect(first).toBeGantryError("APPROVAL_REQUIRED");
    expect(JSON.stringify(first)).not.toContain("gad_");
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ tool: "delete_client", principal: "alice" });

    const pending = await t.call("delete_client", { clientId: "c1" });
    expect(getGantryPayload(pending)?.pending).toBe(true);
    expect(sent).toHaveLength(1);

    expect(await appr.decide(sent[0]!.approveToken, { by: "boss" })).toMatchObject({
      ok: true,
      status: "approved",
    });
    expect(await appr.decide(sent[0]!.denyToken)).toMatchObject({
      ok: false,
      reason: "already_decided",
    });

    await expect(t.call("delete_client", { clientId: "c1" })).resolves.toBeGantryOk();
    expect(t.events).toContainEvent({ type: "approved", mode: "out-of-band", by: "boss" });
    // The approval was consumed: the next call asks again.
    await expect(t.call("delete_client", { clientId: "c1" })).resolves.toBeGantryError(
      "APPROVAL_REQUIRED",
    );
    expect(handler).toHaveBeenCalledOnce();
    expect(sent).toHaveLength(2);
  });

  it("reports denials and rejects bad decision tokens", async () => {
    const { g, appr, handler, sent } = oob();
    const t = await gantryTest(g);
    await t.call("delete_client", { clientId: "c1" });
    expect(await appr.decide("gad_bogus.x")).toEqual({ ok: false, reason: "invalid" });
    expect(await appr.decide(sent[0]!.approveToken.replace("gad_", "gat_"))).toEqual({
      ok: false,
      reason: "invalid",
    });
    expect(await appr.deny(sent[0]!.proposalId)).toMatchObject({ ok: true, status: "denied" });
    await expect(t.call("delete_client", { clientId: "c1" })).resolves.toBeGantryError(
      "APPROVAL_DENIED",
    );
    expect(handler).not.toHaveBeenCalled();
    expect(await appr.approve("unknown-id")).toEqual({ ok: false, reason: "unknown" });
  });

  it("expires decisions", async () => {
    const { g, appr, sent } = oob({ ttl: "1m" });
    const t = await gantryTest(g);
    await t.call("delete_client", { clientId: "c1" });
    await t.clock.advance(30_000);
    const proposalId = sent[0]!.proposalId;
    await t.clock.advance(31_000);
    expect(await appr.decide(sent[0]!.approveToken)).toEqual({ ok: false, reason: "expired" });
    expect(await appr.approve(proposalId)).toMatchObject({ ok: false });
  });

  it("can wait within the call for the decision", async () => {
    const { g, appr, sent } = oob({ wait: "10s" });
    const t = await gantryTest(g);
    await t.call("delete_client", { clientId: "c1" });
    const waiting = t.call("delete_client", { clientId: "c1" });
    await t.clock.advance(500);
    await appr.approve(sent[0]!.proposalId);
    await t.clock.advance(3000);
    await expect(waiting).resolves.toBeGantryOk();
  });

  it("fails closed when the notifier throws", async () => {
    const { g, handler } = oob({
      notifier: () => {
        throw new Error("telegram down");
      },
    });
    const t = await gantryTest(g);
    await expect(t.call("delete_client", { clientId: "c1" })).resolves.toBeGantryError(
      "UNAVAILABLE",
    );
    expect(handler).not.toHaveBeenCalled();
  });

  it("does not let another principal use someone else's approval", async () => {
    let who = "alice";
    const sent: ApprovalRequest[] = [];
    const { g, appr, handler } = setup(
      { mode: "out-of-band", secret: SECRET, notifier: (r) => void sent.push(r) },
      { principal: () => who },
    );
    const t = await gantryTest(g);
    await t.call("delete_client", { clientId: "c1" });
    await appr.approve(sent[0]!.proposalId);
    who = "mallory";
    await expect(t.call("delete_client", { clientId: "c1" })).resolves.toBeGantryError(
      "APPROVAL_REQUIRED",
    );
    expect(handler).not.toHaveBeenCalled();
  });
});

describe("preview helpers", () => {
  it("escape and sanitize", () => {
    expect(escapeMarkdown("*bold* [x](y)")).toBe("\\*bold\\* \\[x\\]\\(y\\)");
    expect(escapeHtml(`<a href="x">'&'</a>`)).toBe(
      "&#60;a href=&#34;x&#34;&#62;&#39;&#38;&#39;&#60;/a&#62;",
    );
    expect(sanitizePreview("a".repeat(3000))).toMatch(/… \(truncated\)$/);
    expect(sanitizePreview("ok\nline\u0000‮")).toBe("ok\nline");
  });
});

describe("approval: hardening", () => {
  it("treats unannotated tools as needing approval (MCP defaults)", async () => {
    const server = newServer();
    const g = gantry(server, { logger: quiet, use: [approval({})] });
    const handler = vi.fn(async () => ok("ran"));
    g.tool("mystery", {}, handler);
    g.tool("safe_write", { annotations: { destructiveHint: false } }, handler);
    const t = await gantryTest(g);
    await expect(t.call("mystery")).resolves.toBeGantryError("APPROVAL_REQUIRED");
    await expect(t.call("safe_write")).resolves.toBeGantryOk();
  });

  it("refuses to ask a human about a truncated preview", async () => {
    const { g, handler } = setup({});
    const t = await gantryTest(g, { clientCapabilities: clientProfiles.elicitation });
    const r = await t.call("delete_client", { clientId: "x".repeat(3000) });
    expect(getGantryPayload(r)?.reason).toBe("preview_too_long");
    expect(t.elicitation.requests).toHaveLength(0);
    expect(handler).not.toHaveBeenCalled();
    const sent: ApprovalRequest[] = [];
    const o = setup({ mode: "out-of-band", secret: SECRET, notifier: (q) => void sent.push(q) });
    const t2 = await gantryTest(o.g);
    await expect(t2.call("delete_client", { clientId: "x".repeat(3000) })).resolves.toBeGantryError(
      "APPROVAL_REQUIRED",
    );
    expect(sent).toHaveLength(0);
  });

  it("strips invisible characters and line separators from previews", () => {
    expect(sanitizePreview("a​b﻿c d⁦e")).toBe("abc\nde");
  });

  it("does not run when the approval arrives after a timeout", async () => {
    const server = newServer();
    const handler = vi.fn(async () => ok("ran"));
    const { timeout } = await import("../src/modules/timeout.js");
    const g = gantry(server, { logger: quiet, use: [timeout({ default: "1s" }), approval({})] });
    g.tool("drop", { annotations: { destructiveHint: true } }, handler);
    let answer!: (r: { action: "accept"; content: { approve: boolean } }) => void;
    g._testing.elicit = () => new Promise((r) => (answer = r));
    const t = await gantryTest(g);
    const pending = t.call("drop");
    await t.clock.advance(1000);
    await expect(pending).resolves.toBeGantryError("TIMEOUT");
    answer({ action: "accept", content: { approve: true } });
    await t.clock.advance(10);
    expect(handler).not.toHaveBeenCalled();
  });
});
