/**
 * Renders bench/results.json as assets/benchmark.svg (p50 per scenario).
 * Run: node bench/chart.ts
 */
import { readFileSync, writeFileSync } from "node:fs";

type Row = { p50: number; p95: number; p99: number };
const data = JSON.parse(readFileSync(new URL("./results.json", import.meta.url), "utf8")) as {
  node: string;
  results: Record<string, Row>;
  overheadP50: number;
};

const rows = Object.entries(data.results);
const avatar = `data:image/webp;base64,${readFileSync(new URL("../assets/gorilli/hype-160.webp", import.meta.url)).toString("base64")}`;
const us = (ms: number) => ms * 1000;
const max = Math.max(...rows.map(([, r]) => us(r.p50)));
const niceMax = Math.ceil(max / 2) * 2 + 2;

const W = 760;
const left = 200;
const right = 90;
const top = 92;
const barH = 18;
const step = 32;
const plotW = W - left - right;
const H = top + rows.length * step + 64;
const x = (v: number) => left + (v / niceMax) * plotW;

const ticks = Array.from({ length: niceMax / 2 + 1 }, (_, i) => i * 2);
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;");

const bars = rows
  .map(([name, r], i) => {
    const y = top + i * step;
    const v = us(r.p50);
    const w = Math.max(2, x(v) - left);
    const cls = name === "full stack" ? "hl" : "bar";
    // 4px rounded data end, square baseline end.
    const path = `M${left} ${y}h${Math.max(0, w - 4)}a4 4 0 0 1 4 4v${barH - 8}a4 4 0 0 1 -4 4h${-Math.max(0, w - 4)}z`;
    return [
      `<text class="label" x="${left - 12}" y="${y + 13}" text-anchor="end">${esc(name)}</text>`,
      `<path class="${cls}" d="${path}"><title>${esc(name)}: p50 ${v.toFixed(1)} µs, p95 ${us(r.p95).toFixed(1)} µs</title></path>`,
      `<text class="value" x="${left + w + 8}" y="${y + 13}">${v.toFixed(1)} µs</text>`,
    ].join("\n");
  })
  .join("\n");

const grid = ticks
  .map(
    (t) =>
      `<line class="grid" x1="${x(t)}" y1="${top - 8}" x2="${x(t)}" y2="${top + rows.length * step - 6}"/>` +
      `<text class="tick" x="${x(t)}" y="${top + rows.length * step + 12}" text-anchor="middle">${t}</text>`,
  )
  .join("\n");

const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="Pipeline overhead per module, p50 in microseconds. Full stack ${us(data.results["full stack"]!.p50).toFixed(1)} microseconds.">
<title>Gantry pipeline overhead (p50, microseconds)</title>
<style>
  .bg{fill:#E4E8F2} .title{fill:#141A33;font-weight:800;font-size:17px} .sub,.tick{fill:#4A5372;font-size:12px}
  .label{fill:#141A33;font-size:13px} .value{fill:#141A33;font-size:12px;font-weight:700}
  .bar{fill:#3557B0} .hl{fill:#D9A21B} .grid{stroke:#C9CFDF;stroke-width:1}
  @media (prefers-color-scheme: dark) {
    .bg{fill:#0B0F20} .title{fill:#F5F7FC} .sub,.tick{fill:#AEB6CF} .label{fill:#E4E8F2} .value{fill:#F5F7FC}
    .bar{fill:#4C72CF} .hl{fill:#B98410} .grid{stroke:#232B4A}
  }
  text{font-family:Inter,-apple-system,'Segoe UI',Helvetica,Arial,sans-serif}
</style>
<rect class="bg" width="${W}" height="${H}" rx="18"/>
<rect x="0" y="0" width="${W}" height="8" rx="4" fill="#F2C94C"/>
<defs><clipPath id="av"><circle cx="${W - 52}" cy="48" r="30"/></clipPath></defs>
<circle cx="${W - 52}" cy="48" r="30" fill="#B4BACE"/>
<image href="${avatar}" x="${W - 86}" y="14" width="68" height="68" clip-path="url(#av)"><title>Gorilli is happy about this</title></image>
<circle cx="${W - 52}" cy="48" r="30" fill="none" stroke="#F2C94C" stroke-width="3"/>
<text class="title" x="24" y="36">Pipeline overhead per call (p50, µs)</text>
<text class="sub" x="24" y="58">All seven modules add ${us(data.overheadP50).toFixed(1)} µs over a bare handler. Budget: 500 µs. memoryStore, Node ${esc(data.node)}.</text>
${grid}
${bars}
<text class="sub" x="${left + plotW / 2}" y="${H - 16}" text-anchor="middle">microseconds, lower is better</text>
</svg>
`;
writeFileSync(new URL("../assets/benchmark.svg", import.meta.url), svg);
console.log("wrote assets/benchmark.svg");
