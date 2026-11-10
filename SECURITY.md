# Security

## Reporting a vulnerability

Please report vulnerabilities privately through [GitHub private vulnerability reporting](https://github.com/gorilli-team/gantry-mcp/security/advisories/new). Do not open a public issue.

We aim to acknowledge reports within 3 business days and to ship a fix for confirmed high-severity issues within 14 days. We credit reporters in the advisory unless you ask us not to.

## Supported versions

| Version          | Supported |
| ---------------- | --------- |
| latest 0.x minor | yes       |
| older            | no        |

## Trust model

| Party                                                              | Trust                                                                                      |
| ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------ |
| Server operator (your code, your config, the `secret`)             | trusted                                                                                    |
| Human approver (elicitation answers, out-of-band decisions)        | trusted                                                                                    |
| Agent / model, tool arguments, request `_meta`, reserved arguments | **untrusted**; may be prompt-injected                                                      |
| MCP client                                                         | trusted to relay elicitation honestly; untrusted for everything it forwards from the model |
| Store (Redis, MongoDB)                                             | trusted for integrity; Gantry fails closed when it is unavailable                          |

Principles that apply to every module:

- **Fail closed.** A store, audit sink, notifier or principal resolver that fails produces a refusal (`UNAVAILABLE`), never an execution.
- **Refusals are results**, not exceptions, so the model sees them and cannot mistake an error for success.
- **No secrets in events.** Tokens never appear in events; audit redacts configured and default keys before any sink, and scrubs Gantry tokens from string values.
- **Startup checks.** Weak secrets, unknown modes, missing notifiers and invalid durations stop the server at startup, not on the first call.
- **No runtime dependencies** beyond the MCP SDK (peer). Releases are published with npm provenance.

## Threat model per module

### approval

| Threat                                                | Mitigation                                                                                                                      |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| Agent forges a token                                  | HMAC-SHA256 with a purpose-derived key from a secret of 32+ characters; constant-time comparison.                               |
| Agent replays a token                                 | Proposals are consumed atomically (`Store.consume`); a token works once. Concurrency tested.                                    |
| Agent swaps arguments after approval                  | Token and out-of-band decisions are bound to `argsHash` (SHA-256 of RFC 8785 canonical JSON), tool name, principal and session. |
| Another principal or session reuses an approval       | Principal and session are part of the binding.                                                                                  |
| Stale approval                                        | Default TTL 5 minutes, enforced by expiry in the signed payload and store TTL.                                                  |
| Burning a valid token with forged attempts            | Signature and binding are checked before consumption.                                                                           |
| Token for one purpose used for another                | Approval tokens and decision tokens use separate derived keys and prefixes.                                                     |
| Misleading preview (control characters, RTL override) | Previews are sanitized and length-capped; notifiers must still escape for their format.                                         |
| Approval channel down                                 | Refusal, never a silent pass. No available mode means `APPROVAL_REQUIRED`.                                                      |

**What `token` mode does not protect against.** Token mode proves that the exact call was proposed and then confirmed with identical arguments within the TTL. It does **not** prove a human saw or approved it: the token is returned to the agent, and an agent (or prompt injection) can pass it straight back. It is meaningful only when the client shows tool calls to the user and asks before running them, or as a deliberate two-step speed bump. For real human-in-the-loop guarantees use `elicit` (the client asks the human) or `out-of-band` (the agent never sees a token). If you configure `fallback: ["token"]`, clients without elicitation get the weaker guarantee.

**What `elicit` mode relies on.** The client must present the prompt to the human and not let the model answer it. A malicious or buggy client can approve on the user's behalf.

**What `out-of-band` mode relies on.** Your webhook must authenticate the channel (for Telegram: the `X-Telegram-Bot-Api-Secret-Token` header and the chat id) and must not expose decision tokens to the agent.

### idempotency

| Threat                                                                 | Mitigation                                                                  |
| ---------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| Reading another principal's stored result                              | Keys include the scope (principal by default) and are hashed.               |
| Replaying a result for different arguments under the same explicit key | Stored results carry `argsHash`; a mismatch returns `IDEMPOTENCY_CONFLICT`. |
| Duplicate execution under concurrency                                  | Store lock per key; duplicates wait, then get `DUPLICATE_IN_FLIGHT`.        |
| Caching failures                                                       | Only successful results are stored.                                         |

Stored results live in the store for the TTL: treat the store as holding tool output. With `scope: "global"`, results are shared across principals by design; use it only for tools whose output is not per user.

### rateLimit

| Threat                                             | Mitigation                                                                         |
| -------------------------------------------------- | ---------------------------------------------------------------------------------- |
| Key injection through principal or session strings | Identifiers are URL-encoded into keys.                                             |
| Exhausting quota with refused calls                | Refusals roll back their increments.                                               |
| Bypass across instances                            | Atomic `incr` on a shared store; Gantry warns when `memoryStore` runs behind HTTP. |

A sliding window is an estimate: short bursts at window edges can exceed the nominal rate slightly.

### audit

| Threat                     | Mitigation                                                                                        |
| -------------------------- | ------------------------------------------------------------------------------------------------- |
| Secrets in logs            | Default redaction list always applies; args and results are opt-in; tokens scrubbed from strings. |
| Silent loss of audit trail | `failClosed` (default) refuses calls when the `received` event cannot be recorded.                |
| Log injection              | Events are structured objects; sinks should serialize them as JSON, not interpolate.              |

### timeout

The handler receives an aborted signal. Work that ignores it keeps running; the refusal text warns the model about partial side effects so it checks state before retrying.

### annotations

Only I/O through `ctx.gantry.fetch` and `ctx.gantry.clients` is enforced. A handler that uses its own client or the global `fetch` bypasses it. This catches mistakes, it is not a sandbox: give read-only tools read-only credentials.

### outputLimit

Bounds what reaches the model's context. It does not inspect content for prompt injection.

## Deployment checklist

- Generate the secret with `crypto.randomBytes(32)` and keep it in a secret manager. Rotating it invalidates outstanding approvals.
- Use a shared store (Redis, MongoDB) for more than one instance.
- Supply a `principal` resolver backed by real authentication on HTTP transports.
- Prefer `elicit` or `out-of-band` approval for anything that matters.
- Set per-tool timeouts long enough for a human to approve.
