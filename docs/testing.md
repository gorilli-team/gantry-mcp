# Testing

`@gorilli/gantry-mcp/testing` runs your server with a real MCP client in process: no network, a fake clock, simulated client profiles.

```ts
import { expect, it } from "vitest";
import { gantryMatchers, gantryTest, clientProfiles } from "@gorilli/gantry-mcp/testing";

expect.extend(gantryMatchers);

it("asks before deleting and replays retries", async () => {
  const t = await gantryTest(g, { principal: "alice", clientCapabilities: clientProfiles.elicitation });

  t.elicitation.respond({ action: "accept", content: { approve: true } });
  const res = await t.call("delete_client", { clientId: "c1" });

  expect(res).toBeGantryOk();
  expect(t.events).toContainEvent({ type: "approved", tool: "delete_client" });
  await expect(t.call("delete_client", { clientId: "c1" })).resolves.toBeGantryOk(); // idempotent replay
});
```

- `t.call(name, args, { meta })` calls through the client.
- `t.clock.advance(ms)` moves the fake clock and fires timers (rate-limit windows, TTLs, timeouts).
- `t.elicitation.respond(result)` queues the human's next answer; unanswered prompts are cancelled. `t.elicitation.requests` records what was asked.
- `clientProfiles.bare | elicitation | full` simulate clients with and without capabilities, to test fallbacks.
- Matchers: `toBeGantryOk()`, `toBeGantryError(code?)`, `toContainEvent(partial)`. They work with Vitest and Jest.

For TypeScript, augment your test runner's matcher types:

```ts
import type { GantryMatchers } from "@gorilli/gantry-mcp/testing";
declare module "vitest" {
  interface Matchers<R extends void | Promise<void> = void | Promise<void>, T = unknown> extends GantryMatchers<R> {}
}
```

The harness needs `@modelcontextprotocol/client` (v2) as a dev dependency.
