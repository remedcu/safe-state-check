import { defineConfig, devices } from "@playwright/test"
import { E2E_PORT } from "./e2e/port"

const viewport = { width: 400, height: 800 }

// The smoke test runs the built fixture page at 400 px in both color schemes.
export default defineConfig({
  testDir: "e2e",
  timeout: 60_000,
  forbidOnly: !!process.env.CI,
  reporter: process.env.CI ? "github" : "list",
  use: { baseURL: `http://127.0.0.1:${E2E_PORT}`, trace: "retain-on-failure" },
  projects: [
    { name: "light", use: { ...devices["Desktop Chrome"], viewport, colorScheme: "light" } },
    { name: "dark", use: { ...devices["Desktop Chrome"], viewport, colorScheme: "dark" } },
  ],
  webServer: {
    command: "npx vite build --config e2e/vite.config.ts && npx vite preview --config e2e/vite.config.ts",
    url: `http://127.0.0.1:${E2E_PORT}/e2e/fixture.html`,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
})
