// The committed generated files: schema and trust policy. Reproducibility (invariant 12) is the CI step
// `npm run registry:build -- --offline --check`.
import zodiacPackage from "@gnosis-guild/zodiac/package.json"
import deploymentsPackage from "@safe-global/safe-deployments/package.json"
import modulesPackage from "@safe-global/safe-modules-deployments/package.json"
import { describe, expect, it } from "vitest"
import { chainByPrefix, getChain, listChains, providers } from "@/data/chains"
import chainsJson from "@/data/generated/chains.json"
import knownJson from "@/data/generated/known-contracts.json"
import reviewedJson from "@/data/reviewed-contracts.json"
import { isSignedOff, reviewedContracts, signedOff } from "@/data/reviewed"
import type { ChainsFile, KnownContractsFile, ReviewedContract } from "@/data/types"

const chains = chainsJson as unknown as ChainsFile
const known = knownJson as unknown as KnownContractsFile
const INSTALLED: Record<string, string> = Object.fromEntries(
  [deploymentsPackage, modulesPackage, zodiacPackage].map((p) => [p.name, p.version]),
)
const installed = (name: string) => INSTALLED[name]

describe("chains.json", () => {
  const all = Object.values(chains.chains)

  it("lists every safe-deployments chain, selectable even without an RPC", () => {
    expect(chains.safeDeploymentsVersion).toBe(installed("@safe-global/safe-deployments"))
    expect(all.length).toBe(566)
    expect(listChains()).toHaveLength(566)
    expect(getChain(1)?.name).toBe("Ethereum Mainnet")
    expect(chainByPrefix("matic")?.chainId).toBe(137)
  })

  it("keeps only https RPCs without key templates or embedded keys", () => {
    for (const rpc of all.flatMap((c) => c.rpcs)) {
      expect(rpc.url).toMatch(/^https:\/\//)
      expect(rpc.url).not.toMatch(/[{}$<>]|%7B|api[_-]?key|apikey|access[_-]?token|[?&](key|token|auth)=/i)
    }
  })

  it("marks operators the way the provider policy says, so the pair rules hold", () => {
    const policy = new Map(providers().map((p) => [p.id, p]))
    for (const rpc of all.flatMap((c) => c.rpcs)) {
      if (rpc.operatorKind === "provider") {
        const provider = policy.get(rpc.operator)
        expect(provider).toBeDefined()
        expect(rpc.aggregator).toBe(provider?.aggregator)
        expect(provider?.hostSuffixes.some((s) => new URL(rpc.url).hostname.endsWith(s))).toBe(true)
      } else {
        expect(rpc.operator).toMatch(/^team:/)
        expect(rpc.aggregator).toBe(false)
      }
    }
  })

  it("ranks proof-capable RPCs first and says why a chain has no root check", () => {
    for (const chain of all) {
      const firstHeaderOnly = chain.rpcs.findIndex((r) => !r.proofs)
      if (firstHeaderOnly >= 0) expect(chain.rpcs.slice(firstHeaderOnly).every((r) => !r.proofs)).toBe(true)
      expect(["supported", "unsupported", "no-proof-rpc", "no-rpc"]).toContain(chain.rootCheck.status)
      expect(chain.rootCheck.reason.length).toBeGreaterThan(10)
      if (chain.rootCheck.status === "no-rpc") expect(chain.rpcs).toHaveLength(0)
    }
  })

  it("holds only what the app reads: no timestamps, sources or per-RPC probe times", () => {
    expect(Object.keys(chains).sort()).toEqual(["chains", "providers", "safeDeploymentsVersion", "schema"])
    for (const chain of Object.values(chains.chains)) {
      expect(chain).not.toHaveProperty("nativeCurrency")
      expect(chain).not.toHaveProperty("isTestnet")
      for (const rpc of chain.rpcs) expect(rpc).not.toHaveProperty("probedAt")
      if (chain.explorer) expect(chain.explorer.addressUrl).toMatch(/^https:\/\/.*\{address\}/)
    }
  })

  it("explains every root check in a plain sentence, never in an RPC's or a library's words", () => {
    for (const chain of Object.values(chains.chains)) {
      expect(chain.rootCheck.reason).toMatch(/^[A-Z].*\.$/)
      expect(chain.rootCheck.reason).not.toMatch(/viem|RLP|0x[0-9a-f]|team:|drpc|eth_getProof at|Version:/)
    }
    expect(getChain(8217)?.rootCheck.reason).toBe("This chain's proofs use a different account format.")
  })

  it("keeps the Transaction Service segment from the Config Service", () => {
    expect(getChain(137)?.safeTxServiceApi).toBe("https://api.safe.global/tx-service/pol/api/v1")
    expect(getChain(10200)?.safeTxServiceApi).toBe("https://api.safe.global/tx-service/chi/api/v1")
    expect(getChain(100)?.blockscoutApi).toBe("https://gnosisscan.io/api/v2")
  })
})

describe("known-contracts.json", () => {
  it("was built from the installed package versions", () => {
    expect(known.packages).toEqual(known.packages.map((p) => ({ name: p.name, version: installed(p.name) })))
  })

  it("has a code hash for every entry and every SafeProxy runtime", () => {
    expect(known.contracts.filter((c) => c.codeHash === null).map((c) => c.id)).toEqual([])
    const proxies = known.contracts.filter((c) => c.kind === "proxy").map((c) => c.id)
    expect(proxies).toEqual(
      expect.arrayContaining(["SafeProxy@1.3.0", "SafeProxy@1.4.1", "SafeProxy@1.5.0", "SafeProxy@1.4.1/zksync"]),
    )
    // The B1 Safe's proxy, proven at block 26176126.
    expect(known.contracts.find((c) => c.id === "SafeProxy@1.4.1")?.codeHash).toBe(
      "0xd7d408ebcd99b2b70be43e20253d6d92a8ea8fab29bd3be7f55b10032331fb4c",
    )
  })

  it("is sorted by id", () => {
    const ids = known.contracts.map((c) => c.id)
    expect(ids).toEqual([...ids].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)))
  })
})

describe("reviewed-contracts.json", () => {
  it("names chain, address, code hash and source; unreviewed entries leave the reviewer and date empty", () => {
    for (const entry of reviewedJson as ReviewedContract[]) {
      expect(getChain(entry.chainId)).not.toBeNull()
      expect(entry.codeHash).toMatch(/^0x[0-9a-f]{64}$/)
      expect(entry.sourceUrl).toMatch(/^https:\/\//)
      expect(entry.reviewedBy === "").toBe(entry.reviewedOn === "")
    }
  })

  it("counts an entry only once a maintainer signed it off", async () => {
    const entry = (reviewedJson as ReviewedContract[])[0]

    expect(isSignedOff(entry)).toBe(false)
    expect(await reviewedContracts()).toEqual([])
    expect(isSignedOff({ reviewedBy: "A Maintainer", reviewedOn: "2026-10-13" })).toBe(true)
    expect(isSignedOff({ reviewedBy: "A Maintainer", reviewedOn: "soon" })).toBe(false)
    expect(isSignedOff({ reviewedBy: " ", reviewedOn: "2026-10-13" })).toBe(false)
    expect(signedOff([entry, { ...entry, reviewedBy: "A Maintainer", reviewedOn: "2026-10-13" }])).toHaveLength(1)
  })
})
