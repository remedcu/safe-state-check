// Builds e2e/fixture.html (the app on the fixture player) and serves it with the host's security headers from
// public/_headers, so the smoke test runs under the real CSP. The output stays out of dist/, which is what deploys.
import { readFileSync } from "node:fs"
import path from "node:path"
import tailwindcss from "@tailwindcss/vite"
import react from "@vitejs/plugin-react"
import { defineConfig } from "vite"
import { preloadFonts } from "../scripts/lib/preload-fonts"
import { E2E_PORT } from "./port"

const root = path.resolve(import.meta.dirname, "..")

// The headers of the `/*` rule, which applies to every page.
function hostHeaders(): Record<string, string> {
  const headers: Record<string, string> = {}
  let rule = ""
  for (const line of readFileSync(path.join(root, "public/_headers"), "utf8").split("\n")) {
    if (/^\//.test(line)) rule = line.trim()
    const header = /^\s+([A-Za-z-]+):\s*(.+)$/.exec(line)
    if (header && rule === "/*") headers[header[1]] = header[2]
  }
  return headers
}

export default defineConfig({
  root,
  plugins: [react(), tailwindcss(), preloadFonts()],
  resolve: { alias: { "@": path.join(root, "src") } },
  build: {
    outDir: path.join(root, "node_modules/.cache/e2e-dist"),
    emptyOutDir: true,
    rollupOptions: { input: path.join(root, "e2e/fixture.html") },
  },
  preview: { host: "127.0.0.1", port: E2E_PORT, strictPort: true, headers: hostHeaders() },
})
