# approval

Propose, a human approves, execute.

```ts
approval({
  when: (tool) => tool.annotations.destructiveHint === true, // default
  mode: "elicit", // "elicit" | "token" | "out-of-band"
  fallback: ["token"], // tried in order when the mode is unavailable
  secret: process.env.GANTRY_SECRET, // required for token and out-of-band
  ttl: "5m",
  preview: (ctx) => `Delete client ${ctx.args.clientId}`,
  notifier: async (request) => {
    /* out-of-band only */
  },
  wait: "0s", // out-of-band: wait for the decision inside the call
});
```

## Modes

**elicit.** Asks in the client (MCP elicitation). The human answers in their own UI; the agent cannot answer for them. If the session's client does not support elicitation, the next mode in `fallback` runs. If the prompt itself fails, the call is refused: Gantry never falls back to a weaker mode because asking failed. Capabilities negotiated for the session take precedence over per-request `_meta`, so a request cannot hide elicitation to force a fallback.

**token.** Two calls. The first returns `APPROVAL_REQUIRED` with a token and a preview to show the user. The second call carries `_approvalToken` (added to the schema automatically). The token is HMAC-SHA256 over proposal id, tool, `argsHash`, principal, session and expiry; it is verified in constant time and consumed atomically, so it works once, for exactly that call, for that principal and session, before it expires.

Token mode proves the call was proposed and then confirmed with identical arguments. **It does not prove a human saw it**: an agent can pass the token straight back. Use it with clients that show tool calls to the user for confirmation, or as a fallback. See [SECURITY.md](../../SECURITY.md).

**out-of-band.** The notifier sends the request to a human elsewhere (chat, email, an admin page) with signed `approveToken` and `denyToken`. Your webhook calls `appr.decide(token, { by })`, or `appr.approve(id)` / `appr.deny(id)` if you authenticate the human yourself. The agent gets `APPROVAL_REQUIRED` and retries the same call; it never sees a token. Decisions are single use and bound to principal, session, tool and arguments. See [examples/telegram-approval](../../examples/telegram-approval/server.ts).

```ts
const appr = approval({ mode: "out-of-band", secret, notifier });
gantry(server, { use: [appr] });
app.post("/approve", async (req, res) =>
  res.json(await appr.decide(req.body.token, { by: req.user.email })),
);
```

Following MCP annotation semantics, the default applies to every tool that is not `readOnlyHint: true` and not `destructiveHint: false`: an unannotated tool is treated as destructive.

## Previews

The preview is built from agent-supplied arguments, so it is untrusted. Gantry strips control, zero-width and bidi-override characters, normalizes line separators and caps the length at 2000 characters. If the preview would be cut, Gantry refuses (`APPROVAL_REQUIRED`, `reason: "preview_too_long"`) instead of asking a human to approve a partial view. Notifiers must still escape it for their format (`escapeHtml`, `escapeMarkdown` are exported).

## Failure behavior

No available mode, store errors, notifier errors: the call is refused. Nothing runs without an approval.

## When you don't need this

The tool cannot do lasting harm, or the client already asks the user before every tool call and you trust that client.
