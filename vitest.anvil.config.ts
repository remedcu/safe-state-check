import path from "node:path"
import { defineConfig } from "vitest/config"

// `npm run test:anvil`: every docs/SPEC.md 11.3 case through startCheck against a local anvil. Needs Foundry (anvil, forge).
export default defineConfig({
  resolve: {
    alias: {
      "@": path.resolve(import.meta.dirname, "./src"),
    },
  },
  test: {
    environment: "node",
    include: ["test/anvil/**/*.test.ts"],
    globalSetup: ["test/anvil/setup.ts"],
    testTimeout: 60_000,
    hookTimeout: 180_000,
  },
})
