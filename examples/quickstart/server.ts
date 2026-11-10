/**
 * Quickstart: an MCP server with the recommended Gantry stack.
 * Run: npm run example:quickstart
 */

import { gantry, memoryStore } from "@gorilli/gantry-mcp";
import { McpServer } from "@modelcontextprotocol/server";
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import { z } from "zod";

const notes = new Map<string, string>([["welcome", "Hello from Gantry"]]);

export function createServer() {
  const server = new McpServer({ name: "notes", version: "1.0.0" });
  const g = gantry(server, {
    store: memoryStore(),
    use: gantry.recommended({ audit: { sink: (e) => console.error(JSON.stringify(e)) } }),
  });

  g.tool(
    "read_note",
    {
      description: "Read a note",
      inputSchema: z.object({ id: z.string() }),
      annotations: { readOnlyHint: true },
    },
    async ({ id }) => ({ content: [{ type: "text", text: notes.get(id) ?? "Not found" }] }),
  );

  g.tool(
    "delete_note",
    {
      description: "Delete a note",
      inputSchema: z.object({ id: z.string() }),
      annotations: { destructiveHint: true },
    },
    async ({ id }) => ({
      content: [{ type: "text", text: notes.delete(id) ? "Deleted" : "Not found" }],
    }),
  );

  return { server, g };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await createServer().server.connect(new StdioServerTransport());
}
