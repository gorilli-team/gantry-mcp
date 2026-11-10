import { createHash, randomUUID } from "node:crypto";
import { type Clock, sleep } from "../../clock.js";
import { type Duration, parseDuration } from "../../duration.js";
import { GantryCode, GantryConfigError, gantryError } from "../../errors.js";
import { defineMiddleware } from "../../pipeline.js";
import type { Store } from "../../store/types.js";
import type {
  CallContext,
  CallToolResult,
  GantryApi,
  Middleware,
  Next,
  ToolInfo,
} from "../../types.js";
import { assertStrongSecret, deriveKey, sign, verify } from "./crypto.js";
import { defaultPreview, sanitizePreview } from "./preview.js";

export { escapeHtml, escapeMarkdown, sanitizePreview } from "./preview.js";

export type ApprovalMode = "elicit" | "token" | "out-of-band";

/** What a notifier receives in out-of-band mode. Send it to a human, never to the agent. */
export interface ApprovalRequest {
  proposalId: string;
  tool: string;
  principal: string;
  sessionId?: string;
  /** Untrusted text derived from the arguments, already sanitized. Escape it for your channel. */
  preview: string;
  expiresAt: number;
  /** Single-use decision tokens for links or buttons. Pass them to `decide()`. */
  approveToken: string;
  denyToken: string;
}

export interface ApprovalOptions {
  /** Which calls need approval. Default: tools with `destructiveHint: true`. */
  when?: (tool: ToolInfo, ctx: CallContext) => boolean;
  /** Preferred mode. Default "elicit". */
  mode?: ApprovalMode;
  /** Modes to try, in order, when the preferred one is unavailable. Default none. */
  fallback?: ApprovalMode[];
  /** HMAC secret (32+ random characters). Required for "token" and "out-of-band". */
  secret?: string;
  /** How long a proposal stays valid. Default "5m". */
  ttl?: Duration;
  /** What the human sees. Default: tool name and canonical args. Sanitized before use. */
  preview?: (ctx: CallContext) => string | Promise<string>;
  /** Delivers out-of-band requests (chat, webhook, email). */
  notifier?: (request: ApprovalRequest) => Promise<void> | void;
  /** Out-of-band: how long a call waits for the decision before returning APPROVAL_REQUIRED. Default 0. */
  wait?: Duration;
  /** Key prefix in the store. Default "gantry:approval". */
  prefix?: string;
}

interface Proposal {
  id: string;
  tool: string;
  argsHash: string;
  principal: string;
  sessionId: string | null;
  exp: number;
  status: "pending" | "approved" | "denied";
  decidedBy?: string;
}

export interface DecisionResult {
  ok: boolean;
  status?: "approved" | "denied";
  tool?: string;
  reason?: "invalid" | "expired" | "already_decided" | "unknown";
}

export interface ApprovalMiddleware extends Middleware {
  /** Applies a decision token from a notifier link or button. */
  decide(token: string, options?: { by?: string }): Promise<DecisionResult>;
  /** Approves a proposal directly, for servers that authenticate the human themselves. */
  approve(proposalId: string, options?: { by?: string }): Promise<DecisionResult>;
  /** Denies a proposal directly. */
  deny(proposalId: string, options?: { by?: string }): Promise<DecisionResult>;
}

export const APPROVAL_TOKEN_ARG = "_approvalToken";
const TOKEN_PREFIX = "gat_";
const DECISION_PREFIX = "gad_";

const sha256 = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");
const minutes = (ms: number) =>
  ms >= 60_000 ? `${Math.round(ms / 60_000)} minutes` : `${Math.round(ms / 1000)} seconds`;

/**
 * Propose, a human approves, then execute.
 *
 * - `elicit`: asks the human in the client.
 * - `token`: two calls; the second carries a single-use HMAC token bound to
 *   the tool, args, principal and session. It proves the exact call was
 *   proposed and confirmed; it does not prove a human saw it (see SECURITY.md).
 * - `out-of-band`: a notifier asks the human elsewhere; the agent never sees a token.
 */
export function approval(options: ApprovalOptions = {}): ApprovalMiddleware {
  const chain: ApprovalMode[] = [options.mode ?? "elicit", ...(options.fallback ?? [])];
  for (const m of chain) {
    if (m !== "elicit" && m !== "token" && m !== "out-of-band") {
      throw new GantryConfigError(`approval: unknown mode "${String(m)}"`);
    }
  }
  const needsSecret = chain.some((m) => m !== "elicit");
  if (needsSecret) assertStrongSecret(options.secret);
  if (chain.includes("out-of-band") && typeof options.notifier !== "function") {
    throw new GantryConfigError('approval: "out-of-band" mode needs a notifier');
  }
  const ttl = parseDuration(options.ttl ?? "5m", "approval.ttl");
  const waitMs = options.wait === undefined ? 0 : parseDuration(options.wait, "approval.wait");
  const prefix = options.prefix ?? "gantry:approval";
  const when = options.when ?? ((tool: ToolInfo) => tool.annotations.destructiveHint === true);
  const tokenKey = needsSecret ? deriveKey(options.secret!, "approval-token") : undefined;
  const decisionKey = needsSecret ? deriveKey(options.secret!, "approval-decision") : undefined;

  let store: Store | undefined;
  let clock: Clock | undefined;
  let api: GantryApi | undefined;

  const proposalKey = (id: string) => `${prefix}:p:${id}`;
  const bindingKey = (ctx: CallContext) =>
    `${prefix}:b:${sha256([ctx.principal, ctx.sessionId ?? "", ctx.tool.name, ctx.argsHash].join("\u0000"))}`;

  const previewFor = async (ctx: CallContext) => {
    try {
      return sanitizePreview(String(await (options.preview ?? defaultPreview)(ctx)));
    } catch {
      return sanitizePreview(defaultPreview(ctx));
    }
  };

  const approved = (ctx: CallContext, next: Next, mode: ApprovalMode, by?: string) => {
    ctx.emit({ type: "approved", mode, ...(by ? { by } : {}) });
    return next();
  };

  const denied = (ctx: CallContext, mode: ApprovalMode, why: string) => {
    ctx.emit({ type: "denied", mode, code: GantryCode.APPROVAL_DENIED });
    return gantryError(
      GantryCode.APPROVAL_DENIED,
      `The user did not approve ${ctx.tool.name}${why}. Do not retry; ask the user what they want instead.`,
      { mode },
    );
  };

  // --- elicit -------------------------------------------------------------
  const viaElicit = async (ctx: CallContext, next: Next): Promise<CallToolResult | undefined> => {
    if (!ctx.elicit) return undefined;
    const preview = await previewFor(ctx);
    let answer: Awaited<ReturnType<NonNullable<CallContext["elicit"]>>>;
    try {
      answer = await ctx.elicit({
        message: `The assistant wants to run "${ctx.tool.name}". Approve?\n\n${preview}`,
        requestedSchema: {
          type: "object",
          properties: {
            approve: {
              type: "boolean",
              title: "Approve",
              description: `Run ${ctx.tool.name} with these arguments`,
            },
          },
          required: ["approve"],
        },
      });
    } catch {
      // The client advertised elicitation but cannot do it here (e.g. a
      // 2026-era request): let the next mode in the chain handle it.
      return undefined;
    }
    if (answer?.action === "accept" && answer.content?.approve === true)
      return approved(ctx, next, "elicit");
    return denied(ctx, "elicit", answer?.action === "cancel" ? " (the request was dismissed)" : "");
  };

  // --- token --------------------------------------------------------------
  const viaToken = async (ctx: CallContext, next: Next): Promise<CallToolResult> => {
    const s = store!;
    const now = clock!.now();
    const given = ctx.reserved[APPROVAL_TOKEN_ARG];

    if (given !== undefined) {
      const payload = verify(tokenKey!, TOKEN_PREFIX, given);
      if (!payload) return invalid(ctx, "The approval token is not valid.");
      if (typeof payload.exp !== "number" || payload.exp <= now) {
        ctx.emit({ type: "approval_expired", mode: "token", code: GantryCode.APPROVAL_EXPIRED });
        return gantryError(
          GantryCode.APPROVAL_EXPIRED,
          `The approval for ${ctx.tool.name} expired. Call it again without ${APPROVAL_TOKEN_ARG} to get a new one, and confirm with the user again.`,
        );
      }
      if (
        payload.tool !== ctx.tool.name ||
        payload.argsHash !== ctx.argsHash ||
        payload.principal !== ctx.principal ||
        payload.sessionId !== (ctx.sessionId ?? null)
      ) {
        return invalid(
          ctx,
          "The approval token was issued for a different call. Arguments must be exactly the same.",
        );
      }
      let consumed: Proposal | undefined;
      try {
        consumed = (await s.consume(proposalKey(String(payload.id)))) as Proposal | undefined;
      } catch {
        return unavailable();
      }
      if (!consumed || consumed.argsHash !== ctx.argsHash || consumed.tool !== ctx.tool.name) {
        return invalid(ctx, "The approval token was already used.");
      }
      return approved(ctx, next, "token");
    }

    const id = randomUUID();
    const exp = now + ttl;
    const proposal: Proposal = {
      id,
      tool: ctx.tool.name,
      argsHash: ctx.argsHash,
      principal: ctx.principal,
      sessionId: ctx.sessionId ?? null,
      exp,
      status: "pending",
    };
    try {
      await s.set(proposalKey(id), proposal, ttl);
    } catch {
      return unavailable();
    }
    const token = sign(tokenKey!, TOKEN_PREFIX, {
      id,
      tool: proposal.tool,
      argsHash: proposal.argsHash,
      principal: proposal.principal,
      sessionId: proposal.sessionId,
      exp,
    });
    const preview = await previewFor(ctx);
    ctx.emit({
      type: "approval_requested",
      mode: "token",
      proposalId: id,
      code: GantryCode.APPROVAL_REQUIRED,
    });
    return gantryError(
      GantryCode.APPROVAL_REQUIRED,
      [
        `${ctx.tool.name} needs the user's approval before it runs.`,
        `Show the user exactly what will happen and ask them to confirm:`,
        "",
        preview,
        "",
        `Only if the user explicitly approves, call ${ctx.tool.name} again with the same arguments plus "${APPROVAL_TOKEN_ARG}": "${token}".`,
        `The token works once and expires in ${minutes(ttl)}.`,
      ].join("\n"),
      { mode: "token", proposalId: id, approvalToken: token, expiresAt: exp, preview },
    );
  };

  // --- out-of-band ---------------------------------------------------------
  const viaOutOfBand = async (ctx: CallContext, next: Next): Promise<CallToolResult> => {
    const s = store!;
    const bKey = bindingKey(ctx);
    try {
      const existingId = (await s.get(bKey)) as string | undefined;
      let proposal = existingId
        ? ((await s.get(proposalKey(existingId))) as Proposal | undefined)
        : undefined;

      if (proposal?.status === "pending" && waitMs > 0) {
        const deadline = clock!.now() + waitMs;
        let delay = 250;
        while (proposal?.status === "pending" && clock!.now() < deadline && !ctx.signal.aborted) {
          await sleep(clock!, Math.min(delay, deadline - clock!.now()), ctx.signal).catch(() => {});
          delay = Math.min(delay * 2, 2000);
          proposal = (await s.get(proposalKey(proposal.id))) as Proposal | undefined;
        }
      }

      if (proposal && proposal.status !== "pending") {
        const consumed = (await s.consume(proposalKey(proposal.id))) as Proposal | undefined;
        await s.consume(bKey);
        if (!consumed)
          return invalid(ctx, "This approval was already used. Call again to request a new one.");
        if (consumed.status === "approved")
          return approved(ctx, next, "out-of-band", consumed.decidedBy);
        return denied(ctx, "out-of-band", "");
      }

      if (proposal) {
        return gantryError(
          GantryCode.APPROVAL_REQUIRED,
          `${ctx.tool.name} is still waiting for the user's approval. Tell the user, wait for them to approve, then call again with the same arguments.`,
          { mode: "out-of-band", proposalId: proposal.id, expiresAt: proposal.exp, pending: true },
        );
      }

      const id = randomUUID();
      const exp = clock!.now() + ttl;
      const fresh: Proposal = {
        id,
        tool: ctx.tool.name,
        argsHash: ctx.argsHash,
        principal: ctx.principal,
        sessionId: ctx.sessionId ?? null,
        exp,
        status: "pending",
      };
      await s.set(proposalKey(id), fresh, ttl);
      await s.set(bKey, id, ttl);
      try {
        await options.notifier!({
          proposalId: id,
          tool: fresh.tool,
          principal: fresh.principal,
          ...(ctx.sessionId ? { sessionId: ctx.sessionId } : {}),
          preview: await previewFor(ctx),
          expiresAt: exp,
          approveToken: sign(decisionKey!, DECISION_PREFIX, { id, d: "approve", exp }),
          denyToken: sign(decisionKey!, DECISION_PREFIX, { id, d: "deny", exp }),
        });
      } catch (error) {
        await s.consume(proposalKey(id)).catch(() => {});
        await s.consume(bKey).catch(() => {});
        api?.logger.error("approval notifier failed", error);
        return unavailable();
      }
      ctx.emit({
        type: "approval_requested",
        mode: "out-of-band",
        proposalId: id,
        code: GantryCode.APPROVAL_REQUIRED,
      });
      return gantryError(
        GantryCode.APPROVAL_REQUIRED,
        `${ctx.tool.name} needs the user's approval. A request was sent to them outside this chat. Tell the user, wait for them to approve, then call ${ctx.tool.name} again with the same arguments. The request expires in ${minutes(ttl)}.`,
        { mode: "out-of-band", proposalId: id, expiresAt: exp },
      );
    } catch {
      return unavailable();
    }
  };

  const invalid = (ctx: CallContext, why: string) => {
    ctx.emit({ type: "approval_invalid", code: GantryCode.APPROVAL_INVALID });
    return gantryError(
      GantryCode.APPROVAL_INVALID,
      `${why} Call ${ctx.tool.name} again without ${APPROVAL_TOKEN_ARG} to request a new approval.`,
    );
  };

  const unavailable = () =>
    gantryError(
      GantryCode.UNAVAILABLE,
      "Approval is unavailable right now, so nothing was run. Try again later.",
    );

  const middleware = defineMiddleware(
    async (ctx, next) => {
      if (!when(ctx.tool, ctx)) return next();
      if (!store) return unavailable();
      // A token on the call means the token flow, if enabled; otherwise refuse it.
      if (ctx.reserved[APPROVAL_TOKEN_ARG] !== undefined) {
        if (chain.includes("token")) return viaToken(ctx, next);
        return invalid(ctx, "This server does not accept approval tokens.");
      }
      for (const mode of chain) {
        if (mode === "elicit") {
          const result = await viaElicit(ctx, next);
          if (result) return result;
        } else if (mode === "token") {
          return viaToken(ctx, next);
        } else {
          return viaOutOfBand(ctx, next);
        }
      }
      ctx.emit({ type: "approval_unavailable", code: GantryCode.APPROVAL_REQUIRED });
      return gantryError(
        GantryCode.APPROVAL_REQUIRED,
        `${ctx.tool.name} needs human approval, but this client cannot ask the user and no other approval channel is configured. Nothing was run. Tell the user to use a client that supports approval prompts.`,
        { reason: "no_channel" },
      );
    },
    {
      gantryName: "approval",
      init(a) {
        api = a;
        store = a.store;
        // Read through `a` so a clock swapped in later (tests) is honoured.
        clock = {
          now: () => a.clock.now(),
          setTimeout: (f, ms) => a.clock.setTimeout(f, ms),
          clearTimeout: (h) => a.clock.clearTimeout(h),
        };
      },
      reservedArgs: (tool): Record<string, Record<string, unknown>> =>
        chain.includes("token") && safeWhen(when, tool)
          ? {
              [APPROVAL_TOKEN_ARG]: {
                type: "string",
                description:
                  "Only set this when a previous call returned APPROVAL_REQUIRED and the user approved.",
              },
            }
          : {},
    },
  );

  const setDecision = async (
    id: string,
    status: "approved" | "denied",
    by?: string,
  ): Promise<DecisionResult> => {
    if (!store || !clock) return { ok: false, reason: "unknown" };
    let release: (() => Promise<void>) | undefined;
    try {
      release = await store.lock(proposalKey(id), 5_000);
      const proposal = (await store.get(proposalKey(id))) as Proposal | undefined;
      if (!proposal) return { ok: false, reason: "unknown" };
      if (proposal.exp <= clock.now()) return { ok: false, reason: "expired" };
      if (proposal.status !== "pending")
        return { ok: false, reason: "already_decided", status: proposal.status };
      const updated: Proposal = {
        ...proposal,
        status,
        ...(by ? { decidedBy: String(by).slice(0, 200) } : {}),
      };
      await store.set(proposalKey(id), updated, Math.max(1, proposal.exp - clock.now()));
      return { ok: true, status, tool: proposal.tool };
    } catch {
      return { ok: false, reason: "unknown" };
    } finally {
      await release?.().catch(() => {});
    }
  };

  return Object.assign(middleware, {
    async decide(token: string, opts: { by?: string } = {}): Promise<DecisionResult> {
      if (!decisionKey) return { ok: false, reason: "invalid" };
      const payload = verify(decisionKey, DECISION_PREFIX, token);
      if (
        !payload ||
        typeof payload.id !== "string" ||
        (payload.d !== "approve" && payload.d !== "deny")
      ) {
        return { ok: false, reason: "invalid" };
      }
      if (typeof payload.exp !== "number" || payload.exp <= (clock?.now() ?? Date.now())) {
        return { ok: false, reason: "expired" };
      }
      return setDecision(payload.id, payload.d === "approve" ? "approved" : "denied", opts.by);
    },
    approve: (id: string, opts: { by?: string } = {}) => setDecision(id, "approved", opts.by),
    deny: (id: string, opts: { by?: string } = {}) => setDecision(id, "denied", opts.by),
  });
}

function safeWhen(when: (tool: ToolInfo, ctx: CallContext) => boolean, tool: ToolInfo): boolean {
  try {
    return when(tool, { tool } as CallContext);
  } catch {
    // A `when` that needs call data may apply; advertise the argument to be safe.
    return true;
  }
}
