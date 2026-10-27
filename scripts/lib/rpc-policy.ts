// The trust policy for default RPCs, in one place for review. Use an RPC only if the chain's own team, the Ethereum
// Foundation or an established provider runs it, over https, with no embedded or template key, not flagged for
// tracking, and never a relay or MEV endpoint.
import {
  hostMatches,
  hostOf,
  type Operator,
  providerFor,
  providerOperator,
  registrableDomain,
  teamOperatorName,
} from "@/data/operators"
import type { ProviderPolicy } from "@/data/types"

export type Tracking = "none" | "limited" | "yes" | "unlabelled"
export type RuleId = "https" | "key" | "tracking" | "relay" | "operator" | "duplicate"

// Established providers, matched by host suffix. `aggregator`: forwards to third-party nodes it does not name (dRPC
// docs "How it works", 1RPC docs "Web3 relay overview"), so two aggregators may reach the same node. `rank` orders
// passing operators: node operators first; 1RPC after dRPC because its public quota ran out after a few hundred
// requests from one IP (2026-10-12); Blast last because Blast API is shutting down.
export const PROVIDERS: (ProviderPolicy & { defaultTracking: Tracking; rank: number })[] = [
  {
    id: "publicnode",
    name: "PublicNode (Allnodes)",
    hostSuffixes: ["publicnode.com"],
    aggregator: false,
    defaultTracking: "none",
    rank: 1,
  },
  {
    id: "ethpandaops",
    name: "ethPandaOps (Ethereum Foundation)",
    hostSuffixes: ["ethpandaops.io"],
    aggregator: false,
    defaultTracking: "unlabelled",
    rank: 1,
  },
  { id: "drpc", name: "dRPC", hostSuffixes: ["drpc.org"], aggregator: true, defaultTracking: "none", rank: 2 },
  {
    id: "1rpc",
    name: "1RPC (Automata)",
    hostSuffixes: ["1rpc.io"],
    aggregator: true,
    defaultTracking: "none",
    rank: 3,
  },
  {
    id: "blast",
    name: "Blast API (Bware Labs, now Alchemy)",
    hostSuffixes: ["blastapi.io"],
    aggregator: false,
    defaultTracking: "limited",
    rank: 4,
  },
]

// Relays, MEV and private-order-flow endpoints. Never used for reads.
export const RELAY_HOST_SUFFIXES = [
  "flashbots.net",
  "mevblocker.io",
  "merkle.io",
  "securerpc.com",
  "blxrbdn.com",
  "bloxroute.com",
  "blocknative.com",
  "blockrazor.xyz",
  "0xblockswap.com",
  "mev-x.com",
  "mev-commit.xyz",
  "payload.de",
  "builder0x69.io",
  "lokibuilder.xyz",
  "edennetwork.io",
]
const RELAY_URL_PATTERN = /(^|[./-])(mev|flashbots|bundler|backrun|maxbackrun|private|protect|boost)([./-]|$)/i

// Team RPC domains that differ from the chain's infoURL domain. Each entry needs a source.
export const TEAM_DOMAIN_ALIASES: Record<number, string[]> = {
  // infoURL hyperfoundation.org; the HyperEVM docs (hyperliquid.gitbook.io, "HyperEVM") give
  // https://rpc.hyperliquid.xyz/evm, and the Safe Config Service uses the same URL.
  999: ["hyperliquid.xyz"],
}

// Infrastructure and hosting domains: an RPC on a chain whose infoURL sits here is run by the platform, not the team.
const NOT_A_TEAM_DOMAIN = new Set([
  "github.com",
  "github.io",
  "gitbook.io",
  "medium.com",
  "mirror.xyz",
  "notion.site",
  "linktr.ee",
  "x.com",
  "twitter.com",
  "t.me",
  "discord.gg",
  "google.com",
  "youtube.com",
  "vercel.app",
  "netlify.app",
  "pages.dev",
  "workers.dev",
  "herokuapp.com",
  "web.app",
  "firebaseapp.com",
  "chainlist.org",
  "chainid.network",
  "blockscout.com",
  "routescan.io",
  "etherscan.io",
  "defillama.com",
  "l2beat.com",
  "conduit.xyz",
  "caldera.xyz",
  "calderachain.xyz",
  "gelato.digital",
  "gelato.cloud",
  "alt.technology",
  "altlayer.io",
  "ankr.com",
  "alchemy.com",
  "quiknode.pro",
  "quicknode.com",
  "thirdweb.com",
  "tenderly.co",
  "gateway.fm",
  "zeeve.io",
  "chainstack.com",
  "infura.io",
  "blockpi.network",
  "nodereal.io",
  "getblock.io",
  "onfinality.io",
  "dwellir.com",
  "tatum.io",
  "sentio.xyz",
  "routeme.sh",
  "therpc.io",
  "4everland.org",
  "nodies.app",
  "owlracle.info",
  "swiftnodes.io",
  "zan.top",
  "pocket.network",
  "omniatech.io",
  "lava.build",
])

// Hand-tested archive RPCs win for these chains, if they pass the probe.
export const CURATED_PRIMARY: Record<number, string> = {
  1: "https://eth.drpc.org",
  100: "https://rpc.gnosischain.com",
  11155111: "https://rpc.sepolia.ethpandaops.io",
}

// Chains whose state is documented as not a Merkle Patricia trie, beyond what a probe shows. ZK Stack (EraVM) chains
// come from safe-deployments' `zksync` deployment type instead.
export const NOT_MPT: Record<number, string> = {
  1101: "Polygon zkEVM: state is a Poseidon sparse Merkle tree (0xPolygon/zkevm-commonjs src/smt.js).",
  2442: "Polygon zkEVM Cardona testnet: same state tree as Polygon zkEVM.",
}
export const ZK_STACK_REASON =
  "ZK Stack (EraVM): eth_getProof is not served; state is a Blake2s binary Merkle tree read with zks_getProof (docs.zksync.io)."

// Chain detection tries these first, a judgement of where most Safes live; then Safe{Wallet}'s own order.
export const DETECT_FIRST = [
  1, 8453, 42161, 10, 137, 100, 56, 11155111, 59144, 534352, 43114, 42220, 5000, 146, 130, 480, 324,
]

export type ChainlistChain = {
  chainId: number
  name: string
  shortName: string
  infoURL?: string
  isTestnet?: boolean
  nativeCurrency: { name: string; symbol: string; decimals: number }
  explorers?: { name: string; url: string; standard?: string }[]
  rpc: ({ url: string; tracking?: Exclude<Tracking, "unlabelled"> } | string)[]
  status?: string
}

export type Candidate = {
  url: string
  operator: Operator
  tracking: Tracking
  source: "chainlist" | "curated"
}

export type Rejection = { chainId: number; url: string; rule: RuleId; why: string }

export function hasKeyOrTemplate(url: string): boolean {
  if (/[{}$<>]|%7B|%24/i.test(url)) return true
  if (/your[_-]?(api)?[_-]?key|api[_-]?key|apikey|access[_-]?token/i.test(url)) return true
  const parsed = new URL(url)
  if (/^\/ext\/bc\/\w+\/rpc$/.test(parsed.pathname)) return false // Avalanche L1 path: the id is a blockchain id
  for (const name of parsed.searchParams.keys()) if (/key|token|auth|secret|jwt/i.test(name)) return true
  return parsed.pathname.split("/").some((segment) => {
    if (/(^|[_-])demo([_-]|$)/i.test(segment)) return true
    // A long mixed letter and digit segment is almost always an account key.
    const digits = (segment.match(/\d/g) ?? []).length
    const letters = (segment.match(/[a-z]/gi) ?? []).length
    return segment.length >= 16 && /^[\w-]+$/.test(segment) && digits >= 3 && letters >= 3
  })
}

export function classifyOperator(host: string, chain: ChainlistChain): Operator | null {
  const provider = providerFor(host, PROVIDERS)
  if (provider) return providerOperator(provider)
  const info = chain.infoURL ? hostOf(chain.infoURL) : null
  const infoDomain = info ? registrableDomain(info) : null
  const teamDomains = [
    ...(infoDomain && !NOT_A_TEAM_DOMAIN.has(infoDomain) ? [infoDomain] : []),
    ...(TEAM_DOMAIN_ALIASES[chain.chainId] ?? []),
  ]
  const teamDomain = teamDomains.find((d) => registrableDomain(host) === d)
  if (!teamDomain) return null
  // One team, one operator id, even across several domains.
  return {
    id: `team:${teamDomains[0]}`,
    kind: "team",
    name: teamOperatorName(chain.name, teamDomain),
    aggregator: false,
  }
}

// Applies the rules in order; the first failing rule is recorded. `failing` counts every rule an entry fails.
export function filterChain(
  chain: ChainlistChain,
  rejections: Rejection[],
  failing: Record<RuleId, number>,
): Candidate[] {
  const kept: Candidate[] = []
  const seen = new Set<string>()
  for (const raw of chain.rpc) {
    const entry = typeof raw === "string" ? { url: raw } : raw
    const url = entry.url.trim().replace(/\/+$/, "")
    const host = hostOf(url)
    const https = host !== null && url.toLowerCase().startsWith("https://")
    const operator = host ? classifyOperator(host, chain) : null
    const labelled = "tracking" in entry ? entry.tracking : undefined
    const tracking: Tracking =
      labelled ??
      (operator?.kind === "provider"
        ? (PROVIDERS.find((p) => p.id === operator.id)?.defaultTracking ?? "unlabelled")
        : "unlabelled")
    // `limited` only from an allowlisted provider; `yes` never. Unlabelled stays: chain-team URLs come from
    // ethereum-lists, which has no tracking field, and the operator rule decides those.
    const trackingBad = tracking === "yes" || (tracking === "limited" && operator?.kind !== "provider")
    const relay =
      host !== null &&
      (RELAY_HOST_SUFFIXES.some((s) => hostMatches(host, s)) || RELAY_URL_PATTERN.test(host + new URL(url).pathname))
    const checks: [RuleId, boolean, string][] = [
      ["https", !https, "not https"],
      ["key", https && hasKeyOrTemplate(url), "key template or embedded key"],
      ["tracking", trackingBad, `tracking ${tracking}`],
      ["relay", relay, "relay or MEV endpoint"],
      ["operator", operator === null, "operator not allowlisted and not the chain team"],
    ]
    for (const [rule, failed] of checks) if (failed) failing[rule]++
    const first = checks.find(([, failed]) => failed)
    if (first) {
      rejections.push({ chainId: chain.chainId, url, rule: first[0], why: first[2] })
      continue
    }
    if (seen.has(url.toLowerCase())) {
      rejections.push({ chainId: chain.chainId, url, rule: "duplicate", why: "listed twice" })
      continue
    }
    seen.add(url.toLowerCase())
    kept.push({ url, operator: operator as Operator, tracking, source: "chainlist" })
  }
  return kept
}
