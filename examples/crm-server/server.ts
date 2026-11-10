/**
 * A write-heavy CRM server: every module configured explicitly, a database
 * client exposed through Gantry so read-only tools cannot write, and audit
 * events written as JSON lines.
 */

import {
  type GantryEvent,
  gantry,
  memoryStore,
  type Store,
  type WithGantry,
} from "@gorilli/gantry-mcp";
import {
  annotations,
  approval,
  audit,
  idempotency,
  outputLimit,
  rateLimit,
  timeout,
} from "@gorilli/gantry-mcp/modules";
import { McpServer } from "@modelcontextprotocol/server";
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import { z } from "zod";

export interface Client {
  id: string;
  name: string;
  email: string;
}

/** Stand-in for a real database client. */
export class CrmDb {
  readonly clients = new Map<string, Client>();
  sent: string[] = [];
  list(): Client[] {
    return [...this.clients.values()];
  }
  get(id: string): Client | undefined {
    return this.clients.get(id);
  }
  insert(client: Client): void {
    this.clients.set(client.id, client);
  }
  delete(id: string): boolean {
    return this.clients.delete(id);
  }
  sendEmail(to: string, subject: string): void {
    this.sent.push(`${to}: ${subject}`);
  }
}

type Ctx = WithGantry<object>;

export function createServer(opts: {
  secret: string;
  db?: CrmDb;
  store?: Store;
  onAudit?: (e: GantryEvent) => void;
}) {
  const db = opts.db ?? new CrmDb();
  const server = new McpServer({ name: "crm", version: "1.0.0" });
  const g = gantry(server, {
    store: opts.store ?? memoryStore(),
    principal: (req) => req.authInfo?.clientId ?? "anonymous",
    clients: { db },
    use: [
      audit({
        sink: opts.onAudit ?? ((e) => process.stderr.write(`${JSON.stringify(e)}\n`)),
        redact: ["email"],
        includeArgs: true,
      }),
      rateLimit({ perPrincipal: "60/min", perTool: { send_email: "10/hour" } }),
      timeout({ default: "30s", perTool: { delete_client: "5m" } }),
      idempotency({ ttl: "24h" }),
      approval({ mode: "elicit", fallback: ["token"], secret: opts.secret }),
      annotations({ enforce: true, strict: true }),
      outputLimit({ maxTokens: 8_000 }),
    ],
  });

  const crm = (ctx: Ctx) => ctx.gantry.clients.db as CrmDb;
  const text = (t: string) => ({ content: [{ type: "text" as const, text: t }] });

  g.tool(
    "list_clients",
    { description: "List all clients", annotations: { readOnlyHint: true } },
    async (ctx: Ctx) => text(JSON.stringify(crm(ctx).list())),
  );

  g.tool(
    "create_client",
    {
      description: "Create a client",
      inputSchema: z.object({ name: z.string().min(1), email: z.email() }),
      annotations: { destructiveHint: false, idempotentHint: false },
    },
    async ({ name, email }: { name: string; email: string }, ctx: Ctx) => {
      const id = `c${crm(ctx).clients.size + 1}`;
      crm(ctx).insert({ id, name, email });
      return text(`Created ${id}`);
    },
  );

  g.tool(
    "delete_client",
    {
      description: "Delete a client and all its data",
      inputSchema: z.object({ clientId: z.string() }),
      annotations: { destructiveHint: true },
    },
    async ({ clientId }: { clientId: string }, ctx: Ctx) =>
      text(crm(ctx).delete(clientId) ? `Deleted ${clientId}` : `No client ${clientId}`),
  );

  g.tool(
    "send_email",
    {
      description: "Send an email to a client",
      inputSchema: z.object({ clientId: z.string(), subject: z.string() }),
      annotations: { destructiveHint: false, openWorldHint: true },
    },
    async ({ clientId, subject }: { clientId: string; subject: string }, ctx: Ctx) => {
      const client = crm(ctx).get(clientId);
      if (!client) return { ...text(`No client ${clientId}`), isError: true };
      crm(ctx).sendEmail(client.email, subject);
      return text(`Sent "${subject}" to ${client.name}`);
    },
  );

  return { server, g, db };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const secret = process.env.GANTRY_SECRET;
  if (!secret) throw new Error("Set GANTRY_SECRET to 32+ random characters");
  await createServer({ secret }).server.connect(new StdioServerTransport());
}
