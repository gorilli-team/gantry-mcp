# Error contract

Refusals come back as tool results, not protocol errors, so every client shows them to the model:

```json
{
  "isError": true,
  "content": [
    {
      "type": "text",
      "text": "Rate limit reached for send_email (10 per 3600s, tool:send_email). Retry after 412s."
    }
  ],
  "structuredContent": { "gantry": { "code": "RATE_LIMITED", "retryAfterSeconds": 412 } }
}
```

The text is written for the model: what happened and what to do next.

| Code                   | Module      | Meaning                                                                                          |
| ---------------------- | ----------- | ------------------------------------------------------------------------------------------------ |
| `APPROVAL_REQUIRED`    | approval    | A human must approve first. Includes the token (token mode) or a pending proposal (out-of-band). |
| `APPROVAL_DENIED`      | approval    | The human said no or dismissed the prompt.                                                       |
| `APPROVAL_EXPIRED`     | approval    | The token is past its TTL.                                                                       |
| `APPROVAL_INVALID`     | approval    | The token is forged, used, or for a different call.                                              |
| `RATE_LIMITED`         | rateLimit   | Includes `retryAfterSeconds`.                                                                    |
| `TIMEOUT`              | timeout     | The call was aborted. It may have partly run.                                                    |
| `OUTPUT_TRUNCATED`     | outputLimit | Not an error: in `_meta.gantry` of a successful, truncated result.                               |
| `OUTPUT_TOO_LARGE`     | outputLimit | The result could not be cut safely.                                                              |
| `ANNOTATION_VIOLATION` | annotations | A read-only tool tried to write.                                                                 |
| `DUPLICATE_IN_FLIGHT`  | idempotency | An identical call is still running.                                                              |
| `IDEMPOTENCY_CONFLICT` | idempotency | An explicit key was reused with different arguments.                                             |
| `UNAVAILABLE`          | any         | A dependency (store, audit sink, notifier, principal resolver) failed, so the call was refused.  |

Read the payload with `getGantryPayload(result)`.
