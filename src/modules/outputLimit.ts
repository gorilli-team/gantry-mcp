import { GantryCode, gantryError } from "../errors.js";
import { defineMiddleware } from "../pipeline.js";
import type { CallContext, CallToolResult, ContentBlock, Middleware } from "../types.js";

export type OutputStrategy = "truncate-with-notice" | "error" | "summarize";

export interface OutputLimitOptions {
  /** Budget for the whole result. Default 8000. */
  maxTokens?: number;
  /** What to do over budget. Default "truncate-with-notice". */
  strategy?: OutputStrategy;
  /** Required for "summarize". Falls back to truncation when it throws or is still too long. */
  summarize?: (text: string, ctx: CallContext) => Promise<string> | string;
  /** Per-tool budgets. */
  perTool?: Record<string, number>;
  /** Token estimator. Default: characters / 4, rounded up. */
  estimate?: (text: string) => number;
}

const defaultEstimate = (text: string) => Math.ceil(text.length / 4);

/** Text a block contributes to the model's context. Binary blocks (images, audio) are not counted. */
function blockText(block: ContentBlock): string {
  if (block.type === "text" && typeof block.text === "string") return block.text;
  const resource = block.resource as { text?: unknown } | undefined;
  if (block.type === "resource" && typeof resource?.text === "string") return resource.text;
  return "";
}

/** Cuts a string to at most `chars` characters without splitting a surrogate pair. */
function cut(text: string, chars: number): string {
  if (text.length <= chars) return text;
  let end = Math.max(0, chars);
  const code = text.charCodeAt(end - 1);
  if (code >= 0xd800 && code <= 0xdbff) end -= 1;
  return text.slice(0, end);
}

/**
 * Keeps large results from flooding the agent's context: truncates (with a
 * notice so the agent knows), summarizes through your callback, or errors.
 */
export function outputLimit(options: OutputLimitOptions = {}): Middleware {
  const maxTokens = options.maxTokens ?? 8000;
  const strategy = options.strategy ?? "truncate-with-notice";
  const estimate = options.estimate ?? defaultEstimate;
  if (!Number.isInteger(maxTokens) || maxTokens < 100) {
    throw new TypeError("outputLimit: maxTokens must be an integer of at least 100");
  }
  if (strategy === "summarize" && typeof options.summarize !== "function") {
    throw new TypeError('outputLimit: strategy "summarize" needs a summarize callback');
  }

  const sizeOf = (result: CallToolResult) => {
    let tokens = 0;
    for (const block of result.content ?? []) tokens += estimate(blockText(block));
    if (result.structuredContent) tokens += estimate(JSON.stringify(result.structuredContent));
    return tokens;
  };

  const notice = (original: number, kept: number, how: string) =>
    `[Gantry: output ${how} from about ${original} to ${kept} tokens. Ask for less (filters, pagination, a narrower query) to see the rest.]`;

  const truncate = (result: CallToolResult, budget: number, original: number): CallToolResult => {
    const noticeTokens = estimate(notice(original, budget, "truncated"));
    const structuredTokens = result.structuredContent
      ? estimate(JSON.stringify(result.structuredContent))
      : 0;
    let remaining = budget - noticeTokens - structuredTokens;
    if (remaining <= 0) return tooLarge(original, budget);
    const content: ContentBlock[] = [];
    for (const block of result.content ?? []) {
      const text = blockText(block);
      if (!text) {
        content.push(block);
        continue;
      }
      const cost = estimate(text);
      if (cost <= remaining) {
        content.push(block);
        remaining -= cost;
        continue;
      }
      if (remaining > 0 && block.type === "text") {
        // Estimate is per character on average; scale the cut to the remaining budget.
        const chars = Math.floor((text.length * remaining) / cost);
        content.push({ ...block, text: cut(text, chars) });
      }
      remaining = 0;
    }
    const kept = budget - Math.max(0, remaining);
    content.push({ type: "text", text: notice(original, kept, "truncated") });
    return {
      ...result,
      content,
      _meta: {
        ...(result._meta ?? {}),
        gantry: { code: GantryCode.OUTPUT_TRUNCATED, originalTokens: original, keptTokens: kept },
      },
    };
  };

  const tooLarge = (original: number, budget: number) =>
    gantryError(
      GantryCode.OUTPUT_TOO_LARGE,
      `The result was about ${original} tokens, over the ${budget} token limit, so it was not returned. Ask for less: add filters, use pagination or a narrower query.`,
      { originalTokens: original, maxTokens: budget },
    );

  return defineMiddleware(
    async (ctx, next) => {
      const result = await next();
      const budget = options.perTool?.[ctx.tool.name] ?? maxTokens;
      const size = sizeOf(result);
      if (size <= budget) return result;
      ctx.emit({
        type: "output_limited",
        code: GantryCode.OUTPUT_TRUNCATED,
        originalTokens: size,
        maxTokens: budget,
        strategy,
      });

      if (strategy === "error") return tooLarge(size, budget);
      if (strategy === "summarize") {
        try {
          const full = (result.content ?? []).map(blockText).filter(Boolean).join("\n\n");
          const summary = String(await options.summarize!(full, ctx));
          const summarized: CallToolResult = {
            ...result,
            content: [
              ...(result.content ?? []).filter((b) => !blockText(b)),
              { type: "text", text: summary },
            ],
          };
          const summarizedSize = sizeOf(summarized);
          if (summarizedSize + estimate(notice(size, summarizedSize, "summarized")) <= budget) {
            summarized.content.push({
              type: "text",
              text: notice(size, summarizedSize, "summarized"),
            });
            summarized._meta = {
              ...(result._meta ?? {}),
              gantry: {
                code: GantryCode.OUTPUT_TRUNCATED,
                originalTokens: size,
                keptTokens: summarizedSize,
                summarized: true,
              },
            };
            return summarized;
          }
          return truncate(summarized, budget, size);
        } catch {
          return truncate(result, budget, size);
        }
      }
      return truncate(result, budget, size);
    },
    { gantryName: "outputLimit" },
  );
}
