import { type Address, getAddress, type Hex, isAddressEqual, size, slice } from "viem"
import type { Identification, KnownRef } from "@/core/report"
import type { ContractKind, KnownContract, KnownContractsFile, KnownFlag, ReviewedContract } from "@/data/types"

export type RegistryEntry = {
  ref: KnownRef
  kind: ContractKind
  roles: readonly ContractKind[]
  flags: readonly KnownFlag[]
  address: Address | null
  codeHash: Hex | null
}

// Lookup tables over the generated known-contracts file and the reviewed list, built once per session.
export type Registry = {
  byId: ReadonlyMap<string, RegistryEntry>
  // Package entries only: they match on code hash alone.
  byCodeHash: ReadonlyMap<Hex, RegistryEntry[]>
  // Lowercase address to every entry listed there, package and reviewed.
  byAddress: ReadonlyMap<Hex, RegistryEntry[]>
  // Reviewed entries match on chain, address and code hash together (contracts with immutables differ per deployment).
  reviewed: readonly { chainId: number; entry: RegistryEntry }[]
  // Supported singleton versions deployed per chain, for `version-behind`.
  singletons: readonly { version: string; chains: readonly number[] | "any-evm" }[]
}

export const SUPPORTED_VERSIONS: readonly string[] = ["1.3.0", "1.4.1", "1.5.0"]

function lower(value: Hex): Hex {
  return value.toLowerCase() as Hex
}

function push<K, V>(map: Map<K, V[]>, key: K, value: V) {
  const list = map.get(key)
  if (list === undefined) map.set(key, [value])
  else list.push(value)
}

function packageEntry(contract: KnownContract): RegistryEntry {
  return {
    ref: {
      id: contract.id,
      name: contract.name,
      version: contract.version,
      origin: contract.source.origin,
      reviewed: null,
    },
    kind: contract.kind,
    roles: contract.roles,
    flags: contract.flags,
    address: contract.address,
    codeHash: contract.codeHash === null ? null : lower(contract.codeHash),
  }
}

function reviewedEntry(contract: ReviewedContract): RegistryEntry {
  return {
    ref: {
      id: `reviewed/${contract.name}/${contract.chainId}/${getAddress(contract.address)}`,
      name: contract.name,
      version: contract.version ?? "",
      origin: "reviewed",
      reviewed: { url: contract.sourceUrl, on: contract.reviewedOn },
    },
    kind: contract.kind,
    roles: [],
    flags: [],
    address: contract.address,
    codeHash: lower(contract.codeHash),
  }
}

export function buildRegistry(
  known: Pick<KnownContractsFile, "contracts">,
  reviewedContracts: readonly ReviewedContract[] = [],
): Registry {
  const byId = new Map<string, RegistryEntry>()
  const byCodeHash = new Map<Hex, RegistryEntry[]>()
  const byAddress = new Map<Hex, RegistryEntry[]>()
  const singletons: { version: string; chains: readonly number[] | "any-evm" }[] = []

  for (const contract of known.contracts) {
    const entry = packageEntry(contract)
    byId.set(entry.ref.id, entry)
    if (entry.codeHash !== null) push(byCodeHash, entry.codeHash, entry)
    if (entry.address !== null) push(byAddress, lower(entry.address), entry)
    if (contract.kind === "singleton" && SUPPORTED_VERSIONS.includes(contract.version)) {
      singletons.push({ version: contract.version, chains: contract.chains })
    }
  }
  const reviewed = reviewedContracts.map((contract) => {
    const entry = reviewedEntry(contract)
    byId.set(entry.ref.id, entry)
    push(byAddress, lower(contract.address), entry)
    return { chainId: contract.chainId, entry }
  })
  return { byId, byCodeHash, byAddress, reviewed, singletons }
}

const EIP1167_PREFIX = "0x363d3d373d3d3d363d73"
const EIP1167_SUFFIX = "5af43d82803e903d91602b57fd5bf3"

// Implementation address of an EIP-1167 minimal proxy, or null for any other code.
export function parseEip1167(code: Hex): Address | null {
  const hex = code.toLowerCase()
  if (size(code) !== 45 || !hex.startsWith(EIP1167_PREFIX) || !hex.endsWith(EIP1167_SUFFIX)) return null
  return getAddress(slice(code, 10, 30))
}

// Delegate of an EIP-7702 delegated account (code `0xef0100` plus the address), or null for any other code.
export function parseEip7702(code: Hex): Address | null {
  if (size(code) !== 23 || !code.toLowerCase().startsWith("0xef0100")) return null
  return getAddress(slice(code, 3))
}

export type CodeFacts = {
  address: Address
  // Proven code hash of the account.
  codeHash: Hex
  // The EIP-1167 implementation and its proven code hash, when the account is a minimal proxy.
  implementation?: { address: Address; codeHash: Hex } | null
}

function matchesFor(registry: Registry, chainId: number, address: Address, codeHash: Hex): RegistryEntry[] {
  const hash = lower(codeHash)
  const reviewed = registry.reviewed
    .filter(
      ({ chainId: chain, entry }) =>
        chain === chainId &&
        entry.codeHash === hash &&
        entry.address !== null &&
        isAddressEqual(entry.address, address),
    )
    .map(({ entry }) => entry)
  return [...(registry.byCodeHash.get(hash) ?? []), ...reviewed]
}

function addressHint(registry: Registry, facts: CodeFacts, known: boolean): Identification["address"] {
  const listed = (registry.byAddress.get(lower(facts.address)) ?? []).filter((entry) => entry.codeHash !== null)
  if (listed.some((entry) => entry.codeHash === lower(facts.codeHash))) return "listed"
  if (listed.length > 0) return "listed-code-differs"
  return known ? "other-address" : null
}

// Identifies an account by its proven code hash, then by its EIP-1167 implementation's proven code hash. The address
// only adds a hint; it never makes a contract known.
export function identify(registry: Registry, chainId: number, facts: CodeFacts): Identification {
  let via: Identification["via"] = "codehash"
  let matches = matchesFor(registry, chainId, facts.address, facts.codeHash)
  if (matches.length === 0 && facts.implementation) {
    const viaImplementation = matchesFor(registry, chainId, facts.implementation.address, facts.implementation.codeHash)
    if (viaImplementation.length > 0) {
      via = "eip1167"
      matches = viaImplementation
    }
  }
  const status =
    matches.length === 0 ? "unknown" : matches.some((m) => m.ref.origin !== "reviewed") ? "known" : "reviewed"
  return {
    status,
    codeHash: lower(facts.codeHash),
    via,
    implementation: facts.implementation?.address ?? null,
    matches: matches.map((entry) => entry.ref),
    address: addressHint(registry, facts, status !== "unknown"),
    sourcify: "not-checked",
  }
}

export function entriesOf(registry: Registry, identification: Identification | null): RegistryEntry[] {
  if (identification === null) return []
  return identification.matches.flatMap((ref) => registry.byId.get(ref.id) ?? [])
}

// True when the identification names a contract made for one of `kinds` (its kind or one of its roles).
export function knownAs(
  registry: Registry,
  identification: Identification | null,
  kinds: readonly ContractKind[],
): boolean {
  return entriesOf(registry, identification).some(
    (entry) => kinds.includes(entry.kind) || entry.roles.some((role) => kinds.includes(role)),
  )
}

export function hasFlag(registry: Registry, identification: Identification | null, flag: KnownFlag): boolean {
  return entriesOf(registry, identification).some((entry) => entry.flags.includes(flag))
}

export function named(registry: Registry, identification: Identification | null, name: string): boolean {
  return entriesOf(registry, identification).some((entry) => entry.ref.name === name)
}

// Display name of the first match, for example "Safe 1.4.1" or "zodiac/realityETH 2.0.0 (reviewed list)".
export function displayName(identification: Identification | null): string | null {
  const first = identification?.matches[0]
  if (first === undefined) return null
  const label = first.version === "" ? first.name : `${first.name} ${first.version}`
  return first.origin === "reviewed" ? `${label} (reviewed list)` : label
}

// "1.4.1" < "1.5.0". Versions here are plain x.y.z.
export function compareVersions(a: string, b: string): number {
  const pa = a.split(".").map(Number)
  const pb = b.split(".").map(Number)
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0)
    if (diff !== 0) return diff
  }
  return 0
}

// Newest supported singleton version deployed on `chainId`, or null if none is.
export function latestVersion(registry: Registry, chainId: number): string | null {
  const versions = registry.singletons
    .filter(({ chains }) => chains === "any-evm" || chains.includes(chainId))
    .map(({ version }) => version)
  return versions.sort(compareVersions).at(-1) ?? null
}
