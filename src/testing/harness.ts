import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import type { Gantry } from "../gantry.js";
import type { CallToolResult, ClientCapabilities, ElicitResult, GantryEvent } from "../types.js";
import { type FakeClock, fakeClock } from "./clock.js";

export interface GantryTestOptions {
  /** Principal for every call, overriding the configured resolver. */
  principal?: string;
  /**
   * Capabilities the simulated client advertises. Default: none, i.e. a
   * client without elicitation, sampling or roots.
   */
  clientCapabilities?: ClientCapabilities;
  /** Client name reported to the server. */
  clientName?: string;
  /** A fake clock (default), `false` to keep the real clock, or your own fake clock. */
  clock?: FakeClock | false;
}

export interface ElicitationRequestRecord {
  message: string;
  requestedSchema: Record<string, unknown>;
}

export interface GantryTest {
  /** Calls a tool through a real in-process MCP client. */
  call(
    name: string,
    args?: Record<string, unknown>,
    options?: { meta?: Record<string, unknown> },
  ): Promise<CallToolResult>;
  /** Every Gantry event emitted since the harness started. */
  readonly events: GantryEvent[];
  /** The fake clock, when enabled. */
  readonly clock: FakeClock;
  readonly client: Client;
  elicitation: {
    /** Queues the next answer the simulated human gives. Unanswered requests are cancelled. */
    respond(result: ElicitResult): void;
    /** Elicitation requests the server sent, in order. */
    readonly requests: ElicitationRequestRecord[];
  };
  close(): Promise<void>;
}

/** Profiles for testing fallbacks. */
export const clientProfiles = {
  bare: {} as ClientCapabilities,
  elicitation: { elicitation: {} } as ClientCapabilities,
  full: { elicitation: {}, sampling: {}, roots: { listChanged: true } } as ClientCapabilities,
};

/** In-process client and server pair for asserting pipeline behavior. */
export async function gantryTest(g: Gantry, options: GantryTestOptions = {}): Promise<GantryTest> {
  const clock = options.clock === false ? undefined : (options.clock ?? fakeClock());
  if (clock) g.useClock(clock);
  if (options.principal !== undefined) g._testing.principal = options.principal;

  const events: GantryEvent[] = [];
  const off = g.on((e) => events.push(e));
  const answers: ElicitResult[] = [];
  const requests: ElicitationRequestRecord[] = [];
  const capabilities = options.clientCapabilities ?? clientProfiles.bare;

  const client = new Client(
    { name: options.clientName ?? "gantry-test", version: "0.0.0" },
    { capabilities: capabilities as Record<string, unknown> },
  );
  // biome-ignore lint/suspicious/noExplicitAny: the SDK overloads are keyed by method literal.
  const c = client as any;
  if (capabilities.elicitation) {
    c.setRequestHandler("elicitation/create", async (req: { params: ElicitationRequestRecord }) => {
      requests.push({ message: req.params.message, requestedSchema: req.params.requestedSchema });
      return answers.shift() ?? { action: "cancel" };
    });
  }
  if (capabilities.roots) c.setRequestHandler("roots/list", async () => ({ roots: [] }));
  if (capabilities.sampling) {
    c.setRequestHandler("sampling/createMessage", async () => ({
      role: "assistant",
      content: { type: "text", text: "" },
      model: "gantry-test",
    }));
  }

  const [serverSide, clientSide] = InMemoryTransport.createLinkedPair();
  if (typeof g.server.connect !== "function")
    throw new Error("gantryTest: server has no connect()");
  await g.server.connect(serverSide);
  await client.connect(clientSide);

  return {
    call: (name, args, callOptions) =>
      client.callTool({
        name,
        arguments: args ?? {},
        ...(callOptions?.meta ? { _meta: callOptions.meta } : {}),
      }) as Promise<CallToolResult>,
    events,
    get clock() {
      if (!clock) throw new Error("gantryTest: started with clock: false");
      return clock;
    },
    client,
    elicitation: {
      respond: (result) => void answers.push(result),
      requests,
    },
    async close() {
      off();
      g._testing = {};
      await client.close();
    },
  };
}
