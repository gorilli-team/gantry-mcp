/**
 * Out-of-band approval through a Telegram bot. The agent never sees a token:
 * the human taps Approve or Deny in Telegram, the webhook calls `decide()`,
 * and the agent's retry runs the tool.
 *
 * Env: GANTRY_SECRET, TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID, TELEGRAM_WEBHOOK_SECRET
 */
import { createHash, timingSafeEqual } from "node:crypto";
import { createServer as createHttpServer } from "node:http";
import { gantry } from "@gorilli/gantry-mcp";
import { type ApprovalRequest, approval, escapeHtml } from "@gorilli/gantry-mcp/modules";
import { McpServer } from "@modelcontextprotocol/server";
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import { z } from "zod";

type Send = (method: string, body: Record<string, unknown>) => Promise<void>;

/** Telegram Bot API caller. The bot token stays server side. */
export function telegramApi(botToken: string): Send {
  return async (method, body) => {
    const res = await fetch(`https://api.telegram.org/bot${botToken}/${method}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`Telegram ${method} failed: ${res.status}`);
  };
}

export function createServer(opts: { secret: string; chatId: string; send: Send }) {
  // Telegram limits callback_data to 64 bytes, so buttons carry a short
  // handle and the signed decision tokens stay on the server.
  const pending = new Map<string, { approve: string; deny: string }>();

  const appr = approval({
    mode: "out-of-band",
    secret: opts.secret,
    ttl: "10m",
    preview: (ctx) => `${ctx.tool.name} for ${ctx.principal}: ${JSON.stringify(ctx.args)}`,
    notifier: async (req: ApprovalRequest) => {
      const handle = req.proposalId.replaceAll("-", "").slice(0, 32);
      pending.set(handle, { approve: req.approveToken, deny: req.denyToken });
      await opts.send("sendMessage", {
        chat_id: opts.chatId,
        parse_mode: "HTML",
        // Previews are untrusted: escape before rendering.
        text: `<b>Approval needed</b>\n<pre>${escapeHtml(req.preview)}</pre>`,
        reply_markup: {
          inline_keyboard: [
            [
              { text: "Approve", callback_data: `a:${handle}` },
              { text: "Deny", callback_data: `d:${handle}` },
            ],
          ],
        },
      });
    },
  });

  const server = new McpServer({ name: "ops", version: "1.0.0" });
  const g = gantry(server, { use: [appr] });

  g.tool(
    "restart_service",
    {
      description: "Restart a production service",
      inputSchema: z.object({ service: z.string() }),
      annotations: { destructiveHint: true },
    },
    async ({ service }: { service: string }) => ({
      content: [{ type: "text", text: `Restarted ${service}` }],
    }),
  );

  /** Handles a Telegram callback query (from the webhook). Only the configured chat may decide. */
  async function onCallback(update: {
    callback_query?: {
      id: string;
      data?: string;
      from?: { username?: string };
      message?: { chat?: { id?: number | string } };
    };
  }) {
    const q = update.callback_query;
    if (!q?.data) return { ok: false as const };
    if (String(q.message?.chat?.id) !== String(opts.chatId)) return { ok: false as const };
    const [kind, handle] = q.data.split(":");
    const tokens = handle ? pending.get(handle) : undefined;
    if (!tokens || (kind !== "a" && kind !== "d")) return { ok: false as const };
    pending.delete(handle!);
    const result = await appr.decide(kind === "a" ? tokens.approve : tokens.deny, {
      by: q.from?.username ?? "telegram",
    });
    await opts.send("answerCallbackQuery", {
      callback_query_id: q.id,
      text: result.ok ? `Done: ${result.status}` : "Expired",
    });
    return result;
  }

  return { server, g, appr, onCallback };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const env = (k: string) => {
    const v = process.env[k];
    if (!v) throw new Error(`Missing ${k}`);
    return v;
  };
  const webhookDigest = createHash("sha256").update(env("TELEGRAM_WEBHOOK_SECRET")).digest();
  const validSecret = (header: unknown) =>
    typeof header === "string" &&
    timingSafeEqual(createHash("sha256").update(header).digest(), webhookDigest);
  const app = createServer({
    secret: env("GANTRY_SECRET"),
    chatId: env("TELEGRAM_CHAT_ID"),
    send: telegramApi(env("TELEGRAM_BOT_TOKEN")),
  });

  // Telegram sends X-Telegram-Bot-Api-Secret-Token on every webhook call.
  createHttpServer(async (req, res) => {
    if (req.method !== "POST" || !validSecret(req.headers["x-telegram-bot-api-secret-token"])) {
      res.writeHead(403).end();
      return;
    }
    let body = "";
    for await (const chunk of req) {
      body += chunk;
      if (body.length > 64_000) {
        res.writeHead(413).end();
        return;
      }
    }
    try {
      await app.onCallback(JSON.parse(body));
      res.writeHead(200).end();
    } catch {
      res.writeHead(400).end();
    }
  }).listen(Number(process.env.PORT ?? 8787), "127.0.0.1");

  await app.server.connect(new StdioServerTransport());
}
