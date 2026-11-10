import { describe, expect, it } from "vitest";
import { createServer as createCrm } from "../examples/crm-server/server.js";
import { createServer as createQuickstart } from "../examples/quickstart/server.js";
import { createServer as createTelegram } from "../examples/telegram-approval/server.js";
import { getGantryPayload } from "../src/index.js";
import { clientProfiles, gantryTest } from "../src/testing/index.js";
import type { GantryEvent } from "../src/types.js";

const SECRET = "x9F!kq2LmP0zR7vB4nT8wY1cH6jD3sGa";
const txt = (r: { content: unknown[] }) => (r.content[0] as { text?: string }).text;

describe("examples/quickstart", () => {
  it("reads freely and asks before deleting", async () => {
    const { g } = createQuickstart(SECRET);
    const t = await gantryTest(g, { clientCapabilities: clientProfiles.elicitation });
    expect(txt(await t.call("read_note", { id: "welcome" }))).toBe("Hello from Gantry");
    t.elicitation.respond({ action: "accept", content: { approve: true } });
    expect(txt(await t.call("delete_note", { id: "welcome" }))).toBe("Deleted");
    expect(txt(await t.call("read_note", { id: "welcome" }))).toBe("Not found");
  });
});

describe("examples/crm-server", () => {
  it("runs the full stack end to end", async () => {
    const events: GantryEvent[] = [];
    const { g, db } = createCrm({ secret: SECRET, onAudit: (e) => void events.push(e) });
    const t = await gantryTest(g, { principal: "agent-1" });

    await expect(
      t.call("create_client", { name: "Acme", email: "ops@acme.test" }),
    ).resolves.toBeGantryOk();
    // Retried create is replayed, not duplicated.
    await t.call("create_client", { name: "Acme", email: "ops@acme.test" });
    expect(db.list()).toHaveLength(1);
    expect(txt(await t.call("list_clients"))).toContain("Acme");

    // No elicitation in this client: token fallback.
    const proposal = await t.call("delete_client", { clientId: "c1" });
    expect(proposal).toBeGantryError("APPROVAL_REQUIRED");
    const token = String(getGantryPayload(proposal)?.approvalToken);
    expect(txt(await t.call("delete_client", { clientId: "c1", _approvalToken: token }))).toBe(
      "Deleted c1",
    );

    // Emails are redacted in audit logs.
    expect(JSON.stringify(events)).not.toContain("ops@acme.test");
    expect(events.some((e) => e.type === "approved")).toBe(true);
  });

  it("rate limits send_email per principal", async () => {
    const { g, db } = createCrm({ secret: SECRET, onAudit: () => {} });
    db.insert({ id: "c1", name: "Acme", email: "a@acme.test" });
    const t = await gantryTest(g);
    for (let i = 0; i < 10; i++)
      await expect(
        t.call("send_email", { clientId: "c1", subject: `s${i}` }),
      ).resolves.toBeGantryOk();
    await expect(t.call("send_email", { clientId: "c1", subject: "s10" })).resolves.toBeGantryError(
      "RATE_LIMITED",
    );
  });
});

describe("examples/telegram-approval", () => {
  it("approves through a Telegram callback", async () => {
    const sent: Array<{ method: string; body: Record<string, unknown> }> = [];
    const app = createTelegram({
      secret: SECRET,
      chatId: "42",
      send: async (method, body) => void sent.push({ method, body }),
    });
    const t = await gantryTest(app.g, { principal: "agent" });

    await expect(t.call("restart_service", { service: "<api>" })).resolves.toBeGantryError(
      "APPROVAL_REQUIRED",
    );
    const msg = sent[0]!.body as {
      text: string;
      reply_markup: { inline_keyboard: { callback_data: string }[][] };
    };
    expect(msg.text).toContain("&#60;api&#62;");
    const approveData = msg.reply_markup.inline_keyboard[0]![0]!.callback_data;
    expect(Buffer.byteLength(approveData)).toBeLessThanOrEqual(64);

    // Wrong chat is ignored.
    expect(
      await app.onCallback({
        callback_query: { id: "q0", data: approveData, message: { chat: { id: 7 } } },
      }),
    ).toEqual({ ok: false });
    const res = await app.onCallback({
      callback_query: {
        id: "q1",
        data: approveData,
        from: { username: "paolo" },
        message: { chat: { id: 42 } },
      },
    });
    expect(res).toMatchObject({ ok: true, status: "approved" });
    expect(txt(await t.call("restart_service", { service: "<api>" }))).toBe("Restarted <api>");
    expect(t.events).toContainEvent({ type: "approved", by: "paolo" });
    // Handles are single use.
    expect(
      await app.onCallback({
        callback_query: { id: "q2", data: approveData, message: { chat: { id: 42 } } },
      }),
    ).toEqual({ ok: false });
    expect(await app.onCallback({})).toEqual({ ok: false });
  });
});
