import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport, McpServer } from "@modelcontextprotocol/server";
import type { CallToolResult } from "../src/types.js";

export function newServer() {
  return new McpServer({ name: "test", version: "1.0.0" });
}

export async function connect(
  server: McpServer,
  opts: { capabilities?: Record<string, unknown>; onElicit?: (req: unknown) => unknown } = {},
) {
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client(
    { name: "test-client", version: "1.0.0" },
    { capabilities: opts.capabilities ?? {} },
  );
  if (opts.onElicit) {
    // biome-ignore lint/suspicious/noExplicitAny: SDK overloads
    (client as any).setRequestHandler("elicitation/create", async (req: unknown) =>
      opts.onElicit!(req),
    );
  }
  await server.connect(a);
  await client.connect(b);
  return {
    client,
    call: (name: string, args?: Record<string, unknown>) =>
      client.callTool({ name, arguments: args ?? {} }) as Promise<CallToolResult>,
  };
}

export const text = (r: CallToolResult) =>
  (r.content[0] as { text?: string } | undefined)?.text ?? "";
