// Records, once, the mainnet runtime code of the canonical contracts the anvil suite places with anvil_setCode, and
// checks each code hash against the generated registry. Network, read-only:
// npx tsx --tsconfig tsconfig.node.json test/anvil/record.ts
import { writeFileSync } from "node:fs"
import { createPublicClient, http, keccak256 } from "viem"
import { mainnet } from "viem/chains"
import known from "@/data/generated/known-contracts.json" with { type: "json" }

const SOURCE = "https://eth.drpc.org"
const BLOCK = 26176126n
const NAMES = [
  "GnosisSafe",
  "GnosisSafeL2",
  "Safe",
  "SafeL2",
  "GnosisSafeProxyFactory",
  "SafeProxyFactory",
  "CompatibilityFallbackHandler",
  "MultiSend",
  "MultiSendCallOnly",
  "SignMessageLib",
  "SafeToL2Setup",
]

const wanted = known.contracts.filter(
  (c) =>
    (NAMES.includes(c.name) &&
      ["1.3.0", "1.4.1", "1.5.0"].includes(c.version) &&
      c.source.deploymentType === "canonical") ||
    c.id === "zodiac/scopeGuard@1.0.0",
)
const client = createPublicClient({ chain: mainnet, transport: http(SOURCE) })
const contracts = []
for (const c of wanted) {
  const code = await client.getCode({ address: c.address as `0x${string}`, blockNumber: BLOCK })
  if (!code || keccak256(code) !== c.codeHash) throw new Error(`${c.id}: code hash differs from the registry`)
  contracts.push({ name: c.name, version: c.version, address: c.address, codeHash: c.codeHash, code })
}
const out = { source: SOURCE, chainId: 1, block: Number(BLOCK), contracts }
writeFileSync(new URL("fixtures/canonical.json", import.meta.url), JSON.stringify(out, null, 2) + "\n")
console.log(`${contracts.length} contracts recorded at block ${BLOCK}`)
