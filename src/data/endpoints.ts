// The endpoint pool of a chain and the pair rules (docs/ARCHITECTURE.md section 6.1).
import { chainSettings } from "@/data/settings"
import type { ChainInfo, DefaultRpc, Endpoint, ProviderPolicy, Settings } from "@/data/types"
import { hostOf, operatorOf, teamOperatorName } from "@/data/operators"

// `proofs`: what the refresh probe saw for a default RPC; null for the user's own RPCs (not probed yet).
export type PoolEntry = { endpoint: Endpoint; proofs: boolean | null }

function sameUrl(a: string, b: string): boolean {
  return a.replace(/\/+$/, "").toLowerCase() === b.replace(/\/+$/, "").toLowerCase()
}

export function userEndpoint(url: string, chain: ChainInfo, providers: readonly ProviderPolicy[]): Endpoint {
  const operator = operatorOf(url, chain, providers)
  return {
    url,
    host: hostOf(url) ?? url,
    operator: operator.id,
    operatorName: operator.name,
    aggregator: operator.aggregator,
    origin: "user",
  }
}

export function defaultEndpoint(rpc: DefaultRpc, chain: ChainInfo, providers: readonly ProviderPolicy[]): Endpoint {
  const provider = providers.find((p) => p.id === rpc.operator)
  const host = hostOf(rpc.url) ?? rpc.url
  return {
    url: rpc.url,
    host,
    operator: rpc.operator,
    operatorName: provider?.name ?? teamOperatorName(chain.name, rpc.operator.replace(/^team:/, "")),
    aggregator: rpc.aggregator,
    origin: "default",
  }
}

// The user's primary and cross-check first, then the defaults in rank order unless the user turned them off.
export function buildPool(chain: ChainInfo, settings: Settings, providers: readonly ProviderPolicy[]): PoolEntry[] {
  const own = chainSettings(settings, chain.chainId)
  const pool: PoolEntry[] = []
  for (const url of [own.primary, own.crossCheck]) {
    if (url && !pool.some((e) => sameUrl(e.endpoint.url, url))) {
      const endpoint = userEndpoint(url, chain, providers)
      if (url === own.primary && own.ownNode) endpoint.ownNode = true
      pool.push({ endpoint, proofs: null })
    }
  }
  if (own.useDefaults) {
    for (const rpc of chain.rpcs) {
      if (!pool.some((e) => sameUrl(e.endpoint.url, rpc.url))) {
        pool.push({ endpoint: defaultEndpoint(rpc, chain, providers), proofs: rpc.proofs })
      }
    }
  }
  return pool
}

// Primary candidates: the user's own RPCs, then the defaults that proved recent blocks, then the rest (tip-only and
// header-only RPCs, which may still anchor in tip mode).
export function primaryOrder(pool: readonly PoolEntry[]): PoolEntry[] {
  const rank = (e: PoolEntry) => (e.proofs === null ? 0 : e.proofs ? 1 : 2)
  return [...pool].sort((a, b) => rank(a) - rank(b))
}

// Another operator, and never two aggregators: dRPC and 1RPC forward to upstreams they do not name, so two of them may
// reach the same node.
export function canPair(
  primary: Pick<Endpoint, "operator" | "aggregator">,
  candidate: Pick<Endpoint, "operator" | "aggregator">,
): boolean {
  return candidate.operator !== primary.operator && !(primary.aggregator && candidate.aggregator)
}

// Cross-check candidates for a primary: the user's cross-check first, then the pool order.
export function crossOrder(
  pool: readonly PoolEntry[],
  primary: Endpoint,
  settings: Settings,
  chainId: number,
): Endpoint[] {
  const own = chainSettings(settings, chainId).crossCheck
  const endpoints = pool.map((e) => e.endpoint)
  const first = own ? endpoints.filter((e) => sameUrl(e.url, own)) : []
  return [...first, ...endpoints.filter((e) => !first.includes(e))].filter(
    (e) => e.url !== primary.url && canPair(primary, e),
  )
}

// Why there is no cross-check, in plain words.
export function crossMissingReason(pool: readonly PoolEntry[], primary: Endpoint, tried: number): string {
  const others = pool.filter((e) => e.endpoint.operator !== primary.operator)
  if (pool.length === 1)
    return "Only one RPC is configured for this chain. Add a cross-check RPC run by another operator."
  if (others.length === 0) {
    return `Every RPC for this chain is run by ${primary.operatorName}. Add a cross-check RPC run by another operator.`
  }
  if (others.every((e) => e.endpoint.aggregator) && primary.aggregator) {
    return "The other RPCs are aggregators like the primary and may reach the same node. Add a cross-check RPC run by another operator."
  }
  return `None of the ${tried} RPCs of other operators answered for this block. Add a cross-check RPC run by another operator.`
}
