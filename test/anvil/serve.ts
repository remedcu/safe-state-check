// The chain id 1 Safes of the anvil suite for e2e/anvil.spec.ts: prints `{ url, built }` as one JSON line, then serves
// until stdin closes. npx tsx --tsconfig tsconfig.node.json test/anvil/serve.ts
import type { Built } from "./cases"
import { prepare } from "./setup"

const built: Record<string, Built> = {}
const anvil = await prepare("l1", built)
console.log(JSON.stringify({ url: anvil.url, built }))
process.stdin.on("end", () => void anvil.stop().then(() => process.exit(0)))
process.stdin.resume()
