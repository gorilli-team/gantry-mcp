/**
 * Builds the Gorilli-styled brand SVGs from the mascot images in assets/gorilli.
 * Run: npm run brand
 */
import { readFileSync, writeFileSync } from "node:fs";

const asset = (p: string) => new URL(`./${p}`, import.meta.url);
const dataUri = (p: string) =>
  `data:image/webp;base64,${readFileSync(asset(p)).toString("base64")}`;

/** Gorilli palette, sampled from the mascot renders. */
export const brand = {
  navy: "#141A33", // hoodie
  navyDeep: "#0B0F20",
  blue: "#2F4FA0", // headphones and fur
  blueBright: "#4C72CF",
  mist: "#B4BACE", // studio background
  mistLight: "#E4E8F2",
  banana: "#F2C94C",
  bananaDeep: "#D9A21B",
  ink: "#141A33",
  muted: "#4A5372",
};

const font = "Inter, -apple-system, 'Segoe UI', Helvetica, Arial, sans-serif";
const MODULES = [
  "approval",
  "idempotency",
  "rateLimit",
  "audit",
  "timeout",
  "annotations",
  "outputLimit",
];

function banner(mode: "light" | "dark", height = 420): string {
  const dy = (height - 420) / 2;
  const dark = mode === "dark";
  const bg1 = dark ? brand.navyDeep : brand.mistLight;
  const bg2 = dark ? "#1A2346" : brand.mist;
  const ink = dark ? "#F5F7FC" : brand.ink;
  const muted = dark ? "#AEB6CF" : brand.muted;
  const chipFill = dark ? "#1C2547" : "#FFFFFF";
  const chipInk = dark ? "#E4E8F2" : brand.ink;
  const leg = dark ? brand.blueBright : brand.blue;

  // Chips wrap before the gorilla frame.
  let x = 96;
  let cy = 300;
  const chips = MODULES.map((m) => {
    const w = m.length * 10 + 40;
    if (x + w > 880) {
      x = 96;
      cy += 48;
    }
    const chip = `<g><rect x="${x}" y="${cy}" width="${w}" height="38" rx="19" fill="${chipFill}" stroke="${leg}" stroke-opacity="0.35"/><circle cx="${x + 17}" cy="${cy + 19}" r="4.5" fill="${brand.bananaDeep}"/><text x="${x + 28}" y="${cy + 25}" font-size="17" font-weight="600" fill="${chipInk}">${m}</text></g>`;
    x += w + 10;
    return chip;
  }).join("\n    ");

  // The gantry frame carries the gorilla: banana beam, blue legs, mascot card in between.
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1280 ${height}" width="1280" height="${height}" role="img" aria-label="Gantry by Gorilli: production middleware for MCP servers">
  <title>Gantry by Gorilli: production middleware for MCP servers</title>
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1" gradientUnits="objectBoundingBox"><stop offset="0" stop-color="${bg1}"/><stop offset="1" stop-color="${bg2}"/></linearGradient>
    <clipPath id="card"><rect x="968" y="92" width="236" height="272" rx="28"/></clipPath>
  </defs>
  <rect width="1280" height="${height}" fill="url(#bg)"/>
  <g transform="translate(0 ${dy})">
  <g font-family="${font}">
    <text x="96" y="92" font-size="20" font-weight="700" fill="${leg}" letter-spacing="3">GORILLI PRESENTS</text>
    <text x="92" y="190" font-size="104" font-weight="800" fill="${ink}" letter-spacing="-3">Gantry</text>
    <text x="96" y="242" font-size="30" font-weight="500" fill="${muted}">Production middleware for MCP servers.</text>
    <text x="96" y="276" font-size="22" font-weight="500" fill="${muted}">Strong enough to carry every tool call.</text>
    ${chips}
  </g>
  <rect x="930" y="48" width="312" height="30" rx="9" fill="${brand.banana}"/>
  <rect x="944" y="78" width="16" height="300" rx="7" fill="${leg}"/>
  <rect x="1212" y="78" width="16" height="300" rx="7" fill="${leg}"/>
  <rect x="1078" y="78" width="4" height="14" fill="${muted}"/>
  <rect x="966" y="90" width="240" height="276" rx="30" fill="${brand.mist}" stroke="${brand.banana}" stroke-width="4"/>
  <image href="${dataUri("gorilli/wave.webp")}" x="952" y="92" width="272" height="272" clip-path="url(#card)" preserveAspectRatio="xMidYMid slice"/>
  </g>
</svg>
`;
}

function logo(): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128" width="128" height="128" role="img" aria-label="Gantry by Gorilli">
  <title>Gantry by Gorilli</title>
  <defs><clipPath id="c"><circle cx="64" cy="70" r="50"/></clipPath></defs>
  <rect width="128" height="128" rx="28" fill="${brand.navy}"/>
  <rect x="12" y="10" width="104" height="12" rx="5" fill="${brand.banana}"/>
  <circle cx="64" cy="70" r="50" fill="${brand.mist}"/>
  <image href="${dataUri("gorilli/wave-160.webp")}" x="2" y="8" width="132" height="132" clip-path="url(#c)" preserveAspectRatio="xMidYMid slice"/>
  <circle cx="64" cy="70" r="50" fill="none" stroke="${brand.banana}" stroke-width="4"/>
</svg>
`;
}

/** 1280x640 social preview card (upload it in the repository settings). */
function social(): string {
  return banner("dark", 640);
}

function pipeline(): string {
  const mods: Array<[string, string]> = [
    ["audit", "log it"],
    ["rateLimit", "cap it"],
    ["timeout", "stop it"],
    ["idempotency", "once only"],
    ["approval", "ask a human"],
    ["annotations", "guard it"],
    ["outputLimit", "trim it"],
  ];
  const W = 1200;
  const H = 340;
  const bw = 118;
  const gap = 12;
  const x0 = 150;
  const y = 136;
  const boxes = mods
    .map(([m, v], i) => {
      const x = x0 + i * (bw + gap);
      const hl = m === "approval";
      return `<rect class="${hl ? "modhl" : "mod"}" x="${x}" y="${y}" width="${bw}" height="76" rx="14" stroke-width="1.5"/>
<text class="modtext" x="${x + bw / 2}" y="${y + 34}" font-size="14" font-weight="700" text-anchor="middle">${m}</text>
<text class="muted" x="${x + bw / 2}" y="${y + 55}" font-size="12" text-anchor="middle">${v}</text>`;
    })
    .join("\n");
  const hx = x0 + 7 * (bw + gap) + 8;
  const starts = [126, ...mods.map((_, i) => x0 + i * (bw + gap) + bw)];
  const ends = [...mods.map((_, i) => x0 + i * (bw + gap)), hx];
  const arrows = starts
    .map(
      (a, i) =>
        `<line class="line" x1="${a + 1}" y1="${y + 38}" x2="${ends[i]! - 2}" y2="${y + 38}" stroke-width="1.5" marker-end="url(#a)"/>`,
    )
    .join("\n");
  const ax = x0 + 4 * (bw + gap) + bw / 2;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="Gantry pipeline: an agent's tool call passes audit, rateLimit, timeout, idempotency, approval, annotations and outputLimit before the handler; any module can return a refusal the agent can act on">
<title>Gantry pipeline</title>
<style>
  .bg{fill:${brand.mistLight}} .ink{fill:${brand.ink}} .muted{fill:${brand.muted}} .box{fill:#FFFFFF;stroke:#C5CBDD}
  .mod{fill:#FFFFFF;stroke:${brand.blue}} .modhl{fill:#FFF7DD;stroke:${brand.bananaDeep}} .modtext{fill:${brand.navy}} .line{stroke:${brand.muted}} .ref{stroke:${brand.bananaDeep}}
  @media (prefers-color-scheme: dark) {
    .bg{fill:${brand.navyDeep}} .ink{fill:#F5F7FC} .muted{fill:#AEB6CF} .box{fill:#161D38;stroke:#2B3560}
    .mod{fill:#141B36;stroke:${brand.blueBright}} .modhl{fill:#2A2410;stroke:${brand.banana}} .modtext{fill:#E4E8F2} .line{stroke:#AEB6CF}
  }
  text{font-family:${font}}
</style>
<defs>
  <marker id="a" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M0 0L10 5L0 10z" fill="#7A84A3"/></marker>
  <marker id="r" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M0 0L10 5L0 10z" fill="${brand.bananaDeep}"/></marker>
  <clipPath id="av"><circle cx="1136" cy="58" r="38"/></clipPath>
</defs>
<rect class="bg" width="${W}" height="${H}" rx="18"/>
<rect x="0" y="0" width="${W}" height="8" rx="4" fill="${brand.banana}"/>
<text class="ink" x="40" y="54" font-size="21" font-weight="800">One pipeline around every tools/call</text>
<text class="muted" x="40" y="82" font-size="14">Each module calls next() or returns its own result. Refusals come back to the agent as tool results it can act on.</text>
<circle cx="1136" cy="58" r="38" fill="${brand.mist}"/>
<image href="${dataUri("gorilli/think-160.webp")}" x="1094" y="18" width="84" height="84" clip-path="url(#av)"/>
<circle cx="1136" cy="58" r="38" fill="none" stroke="${brand.banana}" stroke-width="3"/>
<rect class="box" x="30" y="${y}" width="96" height="76" rx="14"/>
<text class="ink" x="78" y="${y + 34}" font-size="16" font-weight="700" text-anchor="middle">Agent</text>
<text class="muted" x="78" y="${y + 55}" font-size="12" text-anchor="middle">tools/call</text>
${boxes}
<rect class="box" x="${hx}" y="${y}" width="${W - 30 - hx}" height="76" rx="14"/>
<text class="ink" x="${(hx + W - 30) / 2}" y="${y + 34}" font-size="16" font-weight="700" text-anchor="middle">Handler</text>
<text class="muted" x="${(hx + W - 30) / 2}" y="${y + 55}" font-size="12" text-anchor="middle">your tool</text>
${arrows}
<path class="ref" d="M${ax} ${y + 78} V${y + 132} H78 V${y + 80}" fill="none" stroke-width="2.5" stroke-dasharray="7 5" marker-end="url(#r)"/>
<text class="ink" x="200" y="${y + 160}" font-size="14" font-weight="700">Refusal: isError + structuredContent.gantry.code</text>
<text class="muted" x="200" y="${y + 182}" font-size="13">APPROVAL_REQUIRED, RATE_LIMITED, TIMEOUT, DUPLICATE_IN_FLIGHT, ANNOTATION_VIOLATION, UNAVAILABLE ...</text>
</svg>
`;
}

writeFileSync(asset("pipeline.svg"), pipeline());
writeFileSync(asset("banner-light.svg"), banner("light"));
writeFileSync(asset("banner-dark.svg"), banner("dark"));
writeFileSync(asset("logo.svg"), logo());
writeFileSync(asset("social-preview.svg"), social());
console.log("wrote pipeline.svg, banner-light.svg, banner-dark.svg, logo.svg, social-preview.svg");
