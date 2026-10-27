// Who runs an RPC: a known provider by host suffix, the chain's own team by registrable domain, or the user's own
// operator. Shared by the RPC refresh script (which writes the policy into chains.json) and the endpoint pool.
import type { ChainInfo, ProviderPolicy } from "@/data/types"

// Labels with a two-part public suffix, enough for the hosts in chainlist. Not a full Public Suffix List.
const TWO_PART_SUFFIXES = new Set([
  "co.uk",
  "org.uk",
  "com.au",
  "com.br",
  "com.cn",
  "net.cn",
  "org.cn",
  "co.jp",
  "co.kr",
  "com.tw",
  "com.sg",
  "co.in",
  "co.za",
  "com.mx",
  "com.tr",
  "com.hk",
  "co.id",
  "com.vn",
  "com.ar",
  "co.nz",
  "github.io",
  "gitbook.io",
  "vercel.app",
  "netlify.app",
  "pages.dev",
  "workers.dev",
  "herokuapp.com",
])

export function hostOf(url: string): string | null {
  try {
    return new URL(url).hostname.toLowerCase()
  } catch {
    return null
  }
}

export function registrableDomain(host: string): string {
  if (/^[\d.]+$/.test(host) || host.includes(":") || !host.includes(".")) return host
  const labels = host.split(".")
  return labels.slice(TWO_PART_SUFFIXES.has(labels.slice(-2).join(".")) ? -3 : -2).join(".")
}

export function hostMatches(host: string, suffix: string): boolean {
  return host === suffix || host.endsWith(`.${suffix}`)
}

export function providerFor(host: string, providers: readonly ProviderPolicy[]): ProviderPolicy | null {
  return providers.find((p) => p.hostSuffixes.some((suffix) => hostMatches(host, suffix))) ?? null
}

export type Operator = { id: string; name: string; aggregator: boolean; kind: "provider" | "team" | "user" }

export function providerOperator(provider: ProviderPolicy): Operator {
  return { id: provider.id, name: provider.name, aggregator: provider.aggregator, kind: "provider" }
}

export function teamOperatorName(chainName: string, domain: string): string {
  return `${chainName} team (${domain})`
}

const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]", "::1"])

// A user URL on a provider's host counts as that provider; on the chain team's domain as the team; anything else is
// "user:<registrable domain>", so two URLs on one domain never count as two operators.
export function operatorOf(url: string, chain: ChainInfo, providers: readonly ProviderPolicy[]): Operator {
  const host = hostOf(url) ?? url
  // Every name for this computer is one machine, so one operator.
  if (LOOPBACK.has(host)) return { id: "user:loopback", name: "this computer", aggregator: false, kind: "user" }
  const provider = providerFor(host, providers)
  if (provider) return providerOperator(provider)
  const domain = registrableDomain(host)
  // Matched on the default RPC's own domain: a team can run RPCs on a domain other than its operator id.
  const team = chain.rpcs.find(
    (rpc) => rpc.operatorKind === "team" && registrableDomain(hostOf(rpc.url) ?? "") === domain,
  )
  if (team) return { id: team.operator, name: teamOperatorName(chain.name, domain), aggregator: false, kind: "team" }
  return { id: `user:${domain}`, name: domain, aggregator: false, kind: "user" }
}
