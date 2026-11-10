import { describe, expect, it } from "vitest";
import { GantryConfigError, gantry } from "../src/index.js";
import { annotations } from "../src/modules/index.js";
import { gantryTest } from "../src/testing/index.js";
import type { CallContext } from "../src/types.js";
import { newServer } from "./helpers.js";

const ok = (t: string) => ({ content: [{ type: "text", text: t }] });
type Ctx = { gantry: CallContext };

class Db {
  #rows = ["a"];
  clients = {
    find: () => [...this.#rows],
    deleteOne: () => this.#rows.pop(),
  };
  list() {
    return this.#rows;
  }
  insert(row: string) {
    this.#rows.push(row);
  }
}

function setup(opts: Parameters<typeof annotations>[0] = {}) {
  const db = new Db();
  const server = newServer();
  const g = gantry(server, { clients: { db }, use: [annotations(opts)] });
  return { db, g };
}

describe("annotations: enforcement", () => {
  it("blocks writes through wrapped clients in read-only tools", async () => {
    const { db, g } = setup();
    g.tool("read", { annotations: { readOnlyHint: true } }, async (c: Ctx) => {
      const d = c.gantry.clients.db as Db;
      const rows = d.list().length + d.clients.find().length;
      d.insert("evil");
      return ok(String(rows));
    });
    g.tool("nested", { annotations: { readOnlyHint: true } }, async (c: Ctx) => {
      (c.gantry.clients.db as Db).clients.deleteOne();
      return ok("x");
    });
    g.tool("assign", { annotations: { readOnlyHint: true } }, async (c: Ctx) => {
      (c.gantry.clients.db as unknown as Record<string, unknown>).x = 1;
      return ok("x");
    });
    g.tool("del", { annotations: { readOnlyHint: true } }, async (c: Ctx) => {
      delete (c.gantry.clients.db as unknown as Record<string, unknown>).clients;
      return ok("x");
    });
    g.tool("write", { annotations: { destructiveHint: false } }, async (c: Ctx) => {
      (c.gantry.clients.db as Db).insert("fine");
      return ok("written");
    });
    const t = await gantryTest(g);
    for (const name of ["read", "nested", "assign", "del"]) {
      await expect(t.call(name)).resolves.toBeGantryError("ANNOTATION_VIOLATION");
    }
    expect(db.list()).toEqual(["a"]);
    await expect(t.call("write")).resolves.toBeGantryOk();
    expect(db.list()).toEqual(["a", "fine"]);
  });

  it("blocks unsafe HTTP methods via ctx.fetch", async () => {
    const { g } = setup();
    const calls: string[] = [];
    g.tool("read", { annotations: { readOnlyHint: true } }, async (c: Ctx) => {
      const f = c.gantry.fetch;
      return ok(String(await f("data:text/plain,hi").then((r) => r.text())));
    });
    g.tool("post", { annotations: { readOnlyHint: true } }, async (c: Ctx) => {
      calls.push("before");
      await c.gantry.fetch("data:text/plain,hi", { method: "post" });
      return ok("sent");
    });
    g.tool("req", { annotations: { readOnlyHint: true } }, async (c: Ctx) => {
      await c.gantry.fetch(new Request("https://example.invalid", { method: "DELETE" }));
      return ok("sent");
    });
    const t = await gantryTest(g, { clock: false });
    expect((await t.call("read")).content[0]).toMatchObject({ text: "hi" });
    await expect(t.call("post")).resolves.toBeGantryError("ANNOTATION_VIOLATION");
    await expect(t.call("req")).resolves.toBeGantryError("ANNOTATION_VIOLATION");
  });

  it("can be disabled", async () => {
    const { db, g } = setup({ enforce: false });
    g.tool("read", { annotations: { readOnlyHint: true } }, async (c: Ctx) => {
      (c.gantry.clients.db as Db).insert("b");
      return ok("x");
    });
    const t = await gantryTest(g);
    await expect(t.call("read")).resolves.toBeGantryOk();
    expect(db.list()).toEqual(["a", "b"]);
  });

  it("accepts custom write method lists", async () => {
    const { g } = setup({ writeMethods: ["list"] });
    g.tool("read", { annotations: { readOnlyHint: true } }, async (c: Ctx) => {
      (c.gantry.clients.db as Db).list();
      return ok("x");
    });
    const t = await gantryTest(g);
    await expect(t.call("read")).resolves.toBeGantryError("ANNOTATION_VIOLATION");
  });
});

describe("annotations: guard coverage", () => {
  it("guards awaited results, callback arguments and common write names", async () => {
    const writes: string[] = [];
    const conn = { deleteAll: () => writes.push("deleteAll"), findAll: () => ["row"] };
    const db = {
      connect: async () => conn,
      transaction: (fn: (tx: typeof conn) => unknown) => fn(conn),
      findOneAndDelete: () => writes.push("findOneAndDelete"),
      $executeRaw: () => writes.push("$executeRaw"),
    };
    const server = newServer();
    const g = gantry(server, { clients: { db }, use: [annotations()] });
    const ro = { annotations: { readOnlyHint: true } };
    g.tool("awaited", ro, async (c: Ctx) => {
      const d = c.gantry.clients.db as typeof db;
      const cn = await d.connect();
      const rows = cn.findAll().length;
      cn.deleteAll();
      return ok(String(rows));
    });
    g.tool("tx", ro, async (c: Ctx) => {
      (c.gantry.clients.db as typeof db).transaction((tx) => tx.deleteAll());
      return ok("x");
    });
    g.tool("fo", ro, async (c: Ctx) => {
      (c.gantry.clients.db as typeof db).findOneAndDelete();
      return ok("x");
    });
    g.tool("raw", ro, async (c: Ctx) => {
      (c.gantry.clients.db as typeof db).$executeRaw();
      return ok("x");
    });
    const t = await gantryTest(g);
    for (const name of ["awaited", "tx", "fo", "raw"]) {
      await expect(t.call(name)).resolves.toBeGantryError("ANNOTATION_VIOLATION");
    }
    expect(writes).toEqual([]);
  });
});

describe("annotations: strict registration", () => {
  it("refuses write-looking tools without annotations and contradictions", () => {
    const { g } = setup({ strict: true });
    expect(() => g.tool("delete_client", {}, async () => ok(""))).toThrow(GantryConfigError);
    expect(() => g.tool("send-email", {}, async () => ok(""))).toThrow(/looks like a write/);
    expect(() =>
      g.tool("x", { annotations: { readOnlyHint: true, destructiveHint: true } }, async () =>
        ok(""),
      ),
    ).toThrow(/both/);
    expect(() =>
      g.tool("delete_ok", { annotations: { destructiveHint: true } }, async () => ok("")),
    ).not.toThrow();
    expect(() => g.tool("get_client", {}, async () => ok(""))).not.toThrow();
  });

  it("is off by default", () => {
    const { g } = setup();
    expect(() => g.tool("delete_client", {}, async () => ok(""))).not.toThrow();
  });
});
