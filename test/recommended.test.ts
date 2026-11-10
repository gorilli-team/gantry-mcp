import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { gantry, recommended } from "../src/index.js";
import { clientProfiles, gantryTest } from "../src/testing/index.js";
import { newServer } from "./helpers.js";

const SECRET = "x9F!kq2LmP0zR7vB4nT8wY1cH6jD3sGa";
const ok = (t: string) => ({ content: [{ type: "text", text: t }] });

describe("recommended()", () => {
  it("returns the stack in the recommended order", () => {
    const names = recommended({ audit: { sink: () => {} }, secret: SECRET }).map(
      (m) => m.gantryName,
    );
    expect(names).toEqual([
      "audit",
      "rateLimit",
      "timeout",
      "idempotency",
      "approval",
      "annotations",
      "outputLimit",
    ]);
    expect(gantry.recommended).toBe(recommended);
  });

  it("lets every module be turned off", () => {
    expect(
      recommended({
        rateLimit: false,
        timeout: false,
        idempotency: false,
        approval: false,
        annotations: false,
        outputLimit: false,
      }),
    ).toEqual([]);
  });

  it("asks for approval on destructive tools by default and refuses without a channel", async () => {
    const server = newServer();
    const handler = vi.fn(async () => ok("deleted"));
    const g = gantry(server, { use: recommended() });
    g.tool(
      "delete_client",
      { inputSchema: { id: z.string() }, annotations: { destructiveHint: true } },
      handler,
    );
    const bare = await gantryTest(g);
    await expect(bare.call("delete_client", { id: "1" })).resolves.toBeGantryError(
      "APPROVAL_REQUIRED",
    );
    expect(handler).not.toHaveBeenCalled();
  });

  it("falls back to token approval when given a secret", async () => {
    const server = newServer();
    const g = gantry(server, { use: recommended({ secret: SECRET }) });
    g.tool(
      "delete_client",
      { inputSchema: { id: z.string() }, annotations: { destructiveHint: true } },
      async () => ok("deleted"),
    );
    const t = await gantryTest(g, { clientCapabilities: clientProfiles.bare });
    const r = await t.call("delete_client", { id: "1" });
    expect(r).toBeGantryError("APPROVAL_REQUIRED");
    const token = (r.structuredContent as { gantry: { approvalToken: string } }).gantry
      .approvalToken;
    await expect(
      t.call("delete_client", { id: "1", _approvalToken: token }),
    ).resolves.toBeGantryOk();
  });
});
