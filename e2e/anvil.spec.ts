// The clean and shadow-owner Safes of the anvil suite through the real app, with the anvil as the user's own RPC
// (own node, defaults and the Transaction Service off). Needs Foundry, so it runs only on request:
// ANVIL_E2E=1 npx playwright test e2e/anvil.spec.ts --project light
import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process"
import path from "node:path"
import { createInterface } from "node:readline"
import { expect, test } from "@playwright/test"
import { encodeAbiParameters, keccak256 } from "viem"
import { build, preview, type PreviewServer } from "vite"
import config from "./vite.config"

const ROOT = path.resolve(import.meta.dirname, "..")
// anvil's default account 2, the shadow owner the suite writes.
const SHADOW = "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC"

test.skip(!process.env.ANVIL_E2E, "needs Foundry (anvil, forge): run with ANVIL_E2E=1")

let chain: ChildProcessWithoutNullStreams
let app: PreviewServer
let rpc: string
let safes: Record<string, { safe: string }>

test.beforeAll(async () => {
  test.setTimeout(240_000)
  chain = spawn("npx", ["tsx", "--tsconfig", "tsconfig.node.json", "test/anvil/serve.ts"], { cwd: ROOT })
  const line = await new Promise<string>((resolve, reject) => {
    createInterface({ input: chain.stdout }).once("line", resolve)
    chain.once("exit", (code) => reject(new Error(`test/anvil/serve.ts exited with ${code}`)))
  })
  ;({ url: rpc, built: safes } = JSON.parse(line))

  // The real app (index.html), served with the host's headers from public/_headers like the smoke test.
  const outDir = path.join(ROOT, "node_modules/.cache/anvil-suite/app")
  await build({ ...config, configFile: false, logLevel: "warn", build: { outDir, emptyOutDir: true } })
  app = await preview({ ...config, configFile: false, build: { outDir }, preview: { ...config.preview, port: 0 } })
})

test.afterAll(async () => {
  await app?.close()
  chain?.stdin.end()
})

const CASES = [
  { name: "clean", banner: "Storage fully explained", root: "matches" },
  { name: "shadow owner", banner: "Unexplained storage", root: "does not match" },
] as const

for (const c of CASES) {
  test(`${c.name}: banner and storage table`, async ({ page }) => {
    const settings = {
      schema: 1,
      rpcs: { "1": { primary: rpc, crossCheck: null, useDefaults: false, ownNode: true } },
      safeTxService: { enabled: false, apiKey: null },
      etherscan: { apiKey: null },
    }
    await page.addInitScript(
      (text) => localStorage.setItem("safe-state-check:settings:v1", text),
      JSON.stringify(settings),
    )
    // Offline: only the app and the anvil.
    await page.route(
      (url) => url.hostname !== "127.0.0.1",
      (route) => route.abort(),
    )
    await page.goto(`${app.resolvedUrls!.local[0]}#/1/${safes[`${c.name} 1.5.0`].safe}`)

    await expect(page.getByRole("heading", { level: 2, name: c.banner, exact: true })).toBeVisible({ timeout: 60_000 })
    await expect(page.getByText("Rebuilt from configuration slots", { exact: false })).toContainText(c.root)
    await expect(page.getByRole("region", { name: "Storage slots" })).toContainText("Owner list start")
    if (c.name === "shadow owner") {
      const key = keccak256(encodeAbiParameters([{ type: "address" }, { type: "uint256" }], [SHADOW, 2n]))
      await expect(page.getByRole("region", { name: "Unexplained slots" })).toContainText(key)
    }
  })
}
