// Capabilities per (chainId, url), probed lazily the first time a step needs them and cached for the page session
// (docs/ARCHITECTURE.md section 6.3). The reader records most of them as a side effect of real reads.
import { hexToNumber, type Hex } from "viem"
import type { CapabilityName, IssueKind, ReportIssue } from "@/core/report"
import type { Capability, CapabilityReport, Endpoint, EndpointCapabilities } from "@/data/types"
import type { Transport } from "@/data/transport"

// Kinds that say the endpoint cannot do this at all, as opposed to failing this once.
const GAP_KINDS: ReadonlySet<IssueKind> = new Set<IssueKind>([
  "method-unsupported",
  "proof-window",
  "not-archive",
  "non-mpt",
  "plan-unsupported",
  "access-denied",
])

export function isCapabilityGap(issue: ReportIssue): boolean {
  return GAP_KINDS.has(issue.kind)
}

const CAPABILITY_NAMES: CapabilityName[] = [
  "proofs",
  "archiveCall",
  "storageAt",
  "logs",
  "prestateTrace",
  "callTrace",
  "storageRange",
]

function unknownCapabilities(): EndpointCapabilities {
  return {
    chainId: { status: "unknown" },
    clientVersion: null,
    proofs: { status: "unknown" },
    archiveCall: { status: "unknown" },
    storageAt: { status: "unknown" },
    logs: { status: "unknown" },
    prestateTrace: { status: "unknown" },
    callTrace: { status: "unknown" },
    storageRange: { status: "unknown" },
  }
}

export class CapabilityCache {
  private readonly entries = new Map<string, EndpointCapabilities>()

  get(chainId: number, url: string): EndpointCapabilities {
    const key = `${chainId} ${url}`
    let entry = this.entries.get(key)
    if (!entry) this.entries.set(key, (entry = unknownCapabilities()))
    return entry
  }

  set<K extends keyof EndpointCapabilities>(
    chainId: number,
    url: string,
    name: K,
    value: EndpointCapabilities[K],
  ): void {
    this.get(chainId, url)[name] = value
  }

  // A failure marks the capability missing only when it is a gap, not a transient problem.
  fail(chainId: number, url: string, name: CapabilityName, issue: ReportIssue): void {
    if (isCapabilityGap(issue)) this.set(chainId, url, name, { status: "no", issue })
  }

  report(chainId: number, endpoints: readonly Endpoint[]): CapabilityReport[] {
    return endpoints.map((endpoint) => {
      const caps = this.get(chainId, endpoint.url)
      const status = (name: CapabilityName) => (caps[name] as Capability<unknown>).status
      return {
        host: endpoint.host,
        available: CAPABILITY_NAMES.filter((name) => status(name) === "yes"),
        missing: CAPABILITY_NAMES.filter((name) => status(name) === "no"),
        clientVersion: caps.clientVersion,
      }
    })
  }
}

// One cache for the page session; tests and the CLI pass their own.
export const sessionCapabilities = new CapabilityCache()

// eth_chainId once per (chainId, url), and web3_clientVersion with it, which `report()` hands to the verification
// section. Throws the IoError of a failed call; on a wrong chain it returns the chain the endpoint serves.
export async function probeChainId(
  transport: Transport,
  endpoint: Endpoint,
  chainId: number,
  cache: CapabilityCache,
  ctx: { role: "primary" | "cross-check" | "fallback" | "detection"; timeoutMs?: number },
): Promise<{ ok: true } | { ok: false; actual: number | null }> {
  const caps = cache.get(chainId, endpoint.url)
  if (caps.chainId.status === "yes") {
    return caps.chainId.value === chainId ? { ok: true } : { ok: false, actual: caps.chainId.value }
  }
  const result = await transport.rpc(endpoint, "eth_chainId", [], {
    role: ctx.role,
    operation: "check which chain it serves",
    timeoutMs: ctx.timeoutMs,
  })
  const actual = typeof result === "string" && /^0x[0-9a-f]+$/i.test(result) ? hexToNumber(result as Hex) : null
  if (actual !== null) cache.set(chainId, endpoint.url, "chainId", { status: "yes", value: actual })
  if (caps.clientVersion === null) {
    transport
      .rpc(endpoint, "web3_clientVersion", [], { role: ctx.role, operation: "read its client version", attempts: 1 })
      .then((version) => {
        if (typeof version === "string") caps.clientVersion = version.slice(0, 80)
      })
      // Best effort: the version is only shown.
      .catch(() => undefined)
  }
  return actual === chainId ? { ok: true } : { ok: false, actual }
}
