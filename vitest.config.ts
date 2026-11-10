import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const src = (p: string) => fileURLToPath(new URL(`./src/${p}`, import.meta.url));

export default defineConfig({
  resolve: {
    // Examples import the package by name; map it to the sources under test.
    alias: [
      { find: /^@gorilli\/gantry-mcp\/modules\/(.+)$/, replacement: src("modules/$1.ts") },
      { find: /^@gorilli\/gantry-mcp\/modules$/, replacement: src("modules/index.ts") },
      { find: /^@gorilli\/gantry-mcp\/testing$/, replacement: src("testing/index.ts") },
      { find: /^@gorilli\/gantry-mcp$/, replacement: src("index.ts") },
    ],
  },
  test: {
    include: ["test/**/*.test.ts"],
    setupFiles: ["test/setup.ts"],
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      thresholds: { lines: 90, statements: 90, functions: 90, branches: 85 },
    },
  },
});
