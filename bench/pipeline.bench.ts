/**
 * Pipeline overhead benchmark. Calls the wrapped handler directly (no
 * transport) so the numbers are Gantry's own cost.
 * Run: npm run bench   (writes bench/results.json)
 */
import { writeFileSync } from "node:fs";
import { gantry, type Middleware } from "@gorilli/gantry-mcp";
import {
  annotations,
  approval,
  audit,
  idempotency,
  outputLimit,
  rateLimit,
  timeout,
} from "@gorilli/gantry-mcp/modules";
import { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";

const SECRET = "bench-secret-0123456789-abcdefghijklmnop";
const ITERATIONS = 20_000;
const WARMUP = 2_000;

type Callback = (args: unknown, ctx: unknown) => Promise<unknown>;

function build(use: Middleware[]): Callback {
  const server = new McpServer({ name: "bench", version: "1.0.0" });
  const g = gantry(server, { use, logger: { warn: () => {}, error: () => {} } });
  g.tool(
    "write_row",
    { inputSchema: z.object({ i: z.number() }) },
    async ({ i }: { i: number }) => ({
      content: [{ type: "text", text: `row ${i}` }],
    }),
  );
  const tools = (server as unknown as { _registeredTools: Record<string, { handler: Callback }> })
    ._registeredTools;
  return tools.write_row!.handler;
}

const sdkCtx = () => ({
  sessionId: "s1",
  mcpReq: { id: 1, signal: new AbortController().signal, _meta: {} },
});

async function measure(cb: Callback): Promise<{ p50: number; p95: number; p99: number }> {
  for (let i = 0; i < WARMUP; i++) await cb({ i: -i - 1 }, sdkCtx());
  const samples = new Float64Array(ITERATIONS);
  for (let i = 0; i < ITERATIONS; i++) {
    const t0 = process.hrtime.bigint();
    await cb({ i }, sdkCtx());
    samples[i] = Number(process.hrtime.bigint() - t0) / 1e6;
  }
  samples.sort();
  const q = (p: number) => samples[Math.floor(p * (samples.length - 1))]!;
  return { p50: q(0.5), p95: q(0.95), p99: q(0.99) };
}

const scenarios: Array<[string, () => Middleware[]]> = [
  ["no middleware", () => []],
  ["audit", () => [audit({ sink: () => {} })]],
  ["rateLimit", () => [rateLimit({ perPrincipal: "1000000/min" })]],
  ["timeout", () => [timeout({ default: "30s" })]],
  ["idempotency", () => [idempotency()]],
  ["approval (pass-through)", () => [approval({ mode: "token", secret: SECRET })]],
  ["annotations", () => [annotations()]],
  ["outputLimit", () => [outputLimit()]],
  [
    "full stack",
    () => [
      audit({ sink: () => {} }),
      rateLimit({ perPrincipal: "1000000/min" }),
      timeout({ default: "30s" }),
      idempotency(),
      approval({ mode: "token", secret: SECRET }),
      annotations(),
      outputLimit(),
    ],
  ],
];

const results: Record<string, { p50: number; p95: number; p99: number }> = {};
for (const [name, make] of scenarios) {
  results[name] = await measure(build(make()));
  const r = results[name]!;
  console.log(
    `${name.padEnd(26)} p50 ${r.p50.toFixed(4)} ms  p95 ${r.p95.toFixed(4)} ms  p99 ${r.p99.toFixed(4)} ms`,
  );
}
const overhead = results["full stack"]!.p50 - results["no middleware"]!.p50;
console.log(`\nFull-stack overhead (p50): ${overhead.toFixed(4)} ms  (target < 0.5 ms)`);
writeFileSync(
  new URL("./results.json", import.meta.url),
  `${JSON.stringify({ node: process.version, iterations: ITERATIONS, results, overheadP50: overhead }, null, 2)}\n`,
);
if (overhead >= 0.5) process.exitCode = 1;
