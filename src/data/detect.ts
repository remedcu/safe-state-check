// detectChains: finds the chains where an address is a Safe, when the input names no chain (docs/ARCHITECTURE.md
// section 8). Phase "popular" asks the Safe{Wallet} chains that have a default RPC; phase "all" asks every chain
// with one and runs only after a user action, because the address then goes to each chain's RPC. These reads are
// unproven: detection only picks the chain, and the run proves everything again.
import { type Address, getAddress, type Hex, hexToBigInt, isHex, keccak256, maxUint160, maxUint256, toHex } from "viem"
import { SLOTS } from "@/core/constants"
import type { ReportIssue } from "@/core/report"
import { slotKey } from "@/core/slots"
import { listChains, providers } from "@/data/chains"
import { defaultEndpoint } from "@/data/endpoints"
import { ioErrorOf } from "@/data/errors"
import { TIMEOUTS, Transport } from "@/data/transport"
import { type ChainInfo, type DetectOptions, type DetectResult, IoError, type KnownContractsFile } from "@/data/types"

export const DETECT_CONCURRENCY = 6

type Registry = { proxyHashes: ReadonlySet<string>; singletons: ReadonlyMap<string, string> }

// Loaded on first use, in the same lazy chunk the check pipeline loads.
let registry: Promise<Registry> | null = null
function loadRegistry(): Promise<Registry> {
  registry ??= import("@/data/generated/known-contracts.json").then(({ default: json }) => {
    const known = json as unknown as KnownContractsFile
    return {
      proxyHashes: new Set(
        known.contracts.filter((c) => c.kind === "proxy" && c.codeHash).map((c) => (c.codeHash as Hex).toLowerCase()),
      ),
      // Singletons by address; chain lists are incomplete, so any listed address counts on every chain.
      singletons: new Map(
        known.contracts
          .filter((c) => c.kind === "singleton" && c.address)
          .map((c) => [(c.address as Address).toLowerCase(), c.version] as const),
      ),
    }
  })
  return registry
}

// The chains a phase asks, most used first.
export function detectionChains(scope: DetectOptions["scope"]): ChainInfo[] {
  return listChains().filter((chain) => chain.rpcs.length > 0 && (scope === "all" || chain.safeWallet))
}

async function detectOne(
  transport: Transport,
  chain: ChainInfo,
  address: Address,
  { proxyHashes, singletons }: Registry,
): Promise<DetectResult> {
  let issue: ReportIssue | null = null
  // The first two default RPCs; each call already retries once.
  for (const rpc of chain.rpcs.slice(0, 2)) {
    const endpoint = defaultEndpoint(rpc, chain, providers())
    const ctx = { role: "detection" as const, timeoutMs: TIMEOUTS.detection, attempts: 2 }
    try {
      const code = await transport.rpc(endpoint, "eth_getCode", [address, "latest"], {
        ...ctx,
        operation: "check whether the address has code",
      })
      if (!isHex(code))
        throw new IoError(
          transport.issue("invalid-response", endpoint, "eth_getCode", {
            ...ctx,
            operation: "check whether the address has code",
          }),
        )
      if (code === "0x") return { chainId: chain.chainId, status: "empty", singleton: null, version: null, issue: null }
      const slot0 = await transport.rpc(endpoint, "eth_getStorageAt", [address, slotKey(SLOTS.singleton), "latest"], {
        ...ctx,
        operation: "read the Safe's singleton",
      })
      // Some RPCs answer "0x" or a short word for an empty slot; anything over 32 bytes is not a storage word.
      const word = isHex(slot0) ? (slot0 === "0x" ? 0n : hexToBigInt(slot0)) : null
      if (word === null || word > maxUint256) {
        throw new IoError(
          transport.issue("invalid-response", endpoint, "eth_getStorageAt", {
            ...ctx,
            operation: "read the Safe's singleton",
          }),
        )
      }
      const singleton = word <= maxUint160 ? getAddress(toHex(word, { size: 20 })) : null
      const version = singleton ? (singletons.get(singleton.toLowerCase()) ?? null) : null
      const isSafe = proxyHashes.has(keccak256(code)) || version !== null
      return {
        chainId: chain.chainId,
        status: isSafe ? "safe" : "contract",
        singleton: isSafe ? singleton : null,
        version,
        issue: null,
      }
    } catch (error) {
      const io = ioErrorOf(error)
      if (!io) throw error
      issue = io.issue
      if (io.kind === "cancelled") break
    }
  }
  return { chainId: chain.chainId, status: "error", singleton: null, version: null, issue }
}

export async function detectChains(address: Address, options: DetectOptions): Promise<DetectResult[]> {
  const transport = new Transport({ fetch: options.fetch, signal: options.signal })
  const chains = detectionChains(options.scope)
  const known = await loadRegistry()
  const results: DetectResult[] = []
  let next = 0
  const worker = async () => {
    while (next < chains.length && !options.signal?.aborted) {
      const chain = chains[next++]
      const result = await detectOne(transport, chain, getAddress(address), known)
      results.push(result)
      options.onResult?.(result)
    }
  }
  await Promise.all(Array.from({ length: DETECT_CONCURRENCY }, worker))
  const rank = new Map(chains.map((c, i) => [c.chainId, i]))
  return results.sort((a, b) => (rank.get(a.chainId) ?? 0) - (rank.get(b.chainId) ?? 0))
}
