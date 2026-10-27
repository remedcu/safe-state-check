// Chain metadata and default RPCs from src/data/generated/chains.json (scripts/refresh-rpcs.ts). The UI can load this
// module lazily to keep the JSON out of the first chunk.
import chainsJson from "@/data/generated/chains.json"
import type { ChainInfo, ChainsFile, ProviderPolicy } from "@/data/types"

const file = chainsJson as unknown as ChainsFile

const byPrefix = new Map<string, ChainInfo>()
for (const chain of Object.values(file.chains)) {
  for (const prefix of [chain.shortName, ...chain.shortNameAliases]) {
    if (prefix && !byPrefix.has(prefix.toLowerCase())) byPrefix.set(prefix.toLowerCase(), chain)
  }
}

// Every chain safe-deployments knows, most used first (detectRank), so pickers and detection share one order.
const ordered = Object.values(file.chains).sort((a, b) => a.detectRank - b.detectRank || a.chainId - b.chainId)

export function listChains(): ChainInfo[] {
  return ordered
}

export function getChain(chainId: number): ChainInfo | null {
  return file.chains[String(chainId)] ?? null
}

// EIP-3770 short names and the Safe{Wallet} aliases, case-insensitive.
export function chainByPrefix(prefix: string): ChainInfo | null {
  return byPrefix.get(prefix.trim().toLowerCase()) ?? null
}

export function providers(): ProviderPolicy[] {
  return file.providers
}
