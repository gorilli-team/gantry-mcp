import { describe, expect, it } from "vitest";
import { gantry, getGantryPayload } from "../src/index.js";
import { outputLimit } from "../src/modules/index.js";
import { gantryTest } from "../src/testing/index.js";
import type { CallToolResult } from "../src/types.js";
import { newServer } from "./helpers.js";

const quiet = { warn: () => {}, error: () => {} };
const big = (chars: number) => "x".repeat(chars);

async function run(opts: Parameters<typeof outputLimit>[0], result: CallToolResult) {
  const server = newServer();
  const g = gantry(server, { logger: quiet, use: [outputLimit(opts)] });
  g.tool("t", {}, async () => result);
  const t = await gantryTest(g);
  return { res: await t.call("t"), t };
}

const textLen = (r: CallToolResult) =>
  r.content.reduce((n, b) => n + (typeof b.text === "string" ? (b.text as string).length : 0), 0);

describe("outputLimit", () => {
  it("passes small results through untouched", async () => {
    const { res } = await run({ maxTokens: 100 }, { content: [{ type: "text", text: "small" }] });
    expect(res.content).toEqual([{ type: "text", text: "small" }]);
  });

  it("truncates with a notice and metadata", async () => {
    const { res, t } = await run(
      { maxTokens: 200 },
      {
        content: [
          { type: "text", text: big(400) },
          { type: "text", text: big(2000) },
          { type: "image", data: "AA", mimeType: "image/png" },
        ],
      },
    );
    expect(res.isError).toBeFalsy();
    expect(textLen(res)).toBeLessThanOrEqual(800);
    expect((res.content.at(-1) as unknown as { text: string }).text).toMatch(
      /output truncated from about 600/,
    );
    expect(res.content.some((b) => b.type === "image")).toBe(true);
    expect(getGantryPayload(res)).toMatchObject({ code: "OUTPUT_TRUNCATED", originalTokens: 600 });
    expect(t.events).toContainEvent({ type: "output_limited" });
  });

  it("never splits surrogate pairs", async () => {
    const { res } = await run(
      { maxTokens: 100 },
      { content: [{ type: "text", text: "😀".repeat(400) }] },
    );
    const first = (res.content[0] as unknown as { text: string }).text;
    expect(first).not.toMatch(/[\ud800-\udbff]$/);
  });

  it("errors with the error strategy, or when structured content alone is too big", async () => {
    const a = await run(
      { maxTokens: 100, strategy: "error" },
      { content: [{ type: "text", text: big(1000) }] },
    );
    expect(a.res).toBeGantryError("OUTPUT_TOO_LARGE");
    const b = await run(
      { maxTokens: 100 },
      { content: [], structuredContent: { rows: big(1000) } },
    );
    expect(b.res).toBeGantryError("OUTPUT_TOO_LARGE");
  });

  it("counts embedded resource text and honours per-tool budgets", async () => {
    const { res } = await run(
      { maxTokens: 100_000, perTool: { t: 100 } },
      { content: [{ type: "resource", resource: { uri: "file:///a", text: big(2000) } }] },
    );
    expect(getGantryPayload(res)?.code).toBe("OUTPUT_TRUNCATED");
  });

  it("summarizes, and falls back to truncation", async () => {
    const ok = await run(
      {
        maxTokens: 100,
        strategy: "summarize",
        summarize: (text) => `summary of ${text.length} chars`,
      },
      { content: [{ type: "text", text: big(2000) }] },
    );
    expect((ok.res.content[0] as unknown as { text: string }).text).toBe("summary of 2000 chars");
    expect(getGantryPayload(ok.res)).toMatchObject({ summarized: true });

    const tooLong = await run(
      { maxTokens: 100, strategy: "summarize", summarize: () => big(5000) },
      { content: [{ type: "text", text: big(2000) }] },
    );
    expect(textLen(tooLong.res)).toBeLessThan(600);

    const throws = await run(
      {
        maxTokens: 100,
        strategy: "summarize",
        summarize: () => {
          throw new Error("llm down");
        },
      },
      { content: [{ type: "text", text: big(2000) }] },
    );
    expect(getGantryPayload(throws.res)?.code).toBe("OUTPUT_TRUNCATED");
  });

  it("validates options", () => {
    expect(() => outputLimit({ maxTokens: 10 })).toThrow(TypeError);
    expect(() => outputLimit({ strategy: "summarize" })).toThrow(TypeError);
  });
});
