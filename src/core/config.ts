import { type Address, encodeAbiParameters, type Hex, isAddressEqual, keccak256, toHex } from "viem"
import { LEGACY_DOMAIN_SEPARATOR_TYPEHASH, SENTINEL, SLOTS } from "@/core/constants"
import { finding } from "@/core/findings"
import type { ListWalk } from "@/core/linkedList"
import type { Finding } from "@/core/report"
import { slotKey } from "@/core/slots"

// The domain separator Safe 1.0.0 to 1.2.0 wrote to slot 6, which upgraded Safes keep.
export function legacyDomainSeparator(safe: Address): Hex {
  return keccak256(
    encodeAbiParameters([{ type: "bytes32" }, { type: "address" }], [LEGACY_DOMAIN_SEPARATOR_TYPEHASH, safe]),
  )
}

export type Slot6 = "zero" | "legacy" | "unexpected"

export function classifySlot6(value: bigint, safe: Address): Slot6 {
  if (value === 0n) return "zero"
  return toHex(value, { size: 32 }) === legacyDomainSeparator(safe) ? "legacy" : "unexpected"
}

// Where the next `getModulesPaginated` page starts: after the last module returned. On 1.3.0 `next` is the first
// module not returned and starting there skips it; from 1.4.1 on `next` is the last one returned. Null: last page.
export function nextModulesStart(page: readonly Address[], next: Address): Address | null {
  if (isAddressEqual(next, SENTINEL) || page.length === 0) return null
  return page[page.length - 1]
}

export type ConfigInput = {
  safe: Address
  // Proven values of the Safe's base slots, lowercase 32-byte keys.
  values: ReadonlyMap<Hex, bigint>
  owners: ListWalk
  modules: ListWalk
  // What the Safe's getters returned; null when the call failed or was not made.
  getters: {
    owners: readonly Address[] | null
    threshold: bigint | null
    nonce: bigint | null
    modules: readonly Address[] | null
  }
}

export type ConfigResult = {
  owners: Address[]
  modules: Address[]
  ownerCount: bigint
  threshold: bigint
  nonce: bigint
  slot6: Slot6
  findings: Finding[]
}

function sameList(a: readonly Address[], b: readonly Address[]): boolean {
  return a.length === b.length && a.every((entry, index) => isAddressEqual(entry, b[index]))
}

function listProblem(list: "owners" | "modules", walk: ListWalk): string | null {
  const problem = walk.problem
  if (problem === undefined || problem.kind === "mismatch") return null
  switch (problem.kind) {
    case "unread":
      return `the ${list} entry of ${problem.at} could not be read`
    case "broken":
      return `${list}[${problem.at}] holds ${toHex(problem.value)}, which is not a list pointer`
    case "cycle":
      return `the ${list} list reaches ${problem.at} twice`
    case "tooLong":
      return `the ${list} list has more than ${problem.limit} entries`
  }
}

// Rules over the proven slots, the walked lists and the getters. The walk from raw storage is authoritative; the
// getters are only compared with it.
export function checkConfig({ safe, values, owners, modules, getters }: ConfigInput): ConfigResult {
  const findings: Finding[] = []
  const read = (slot: bigint) => values.get(slotKey(slot)) ?? 0n
  const ownerCount = read(SLOTS.ownerCount)
  const threshold = read(SLOTS.threshold)
  const nonce = read(SLOTS.nonce)
  const slot6Value = read(SLOTS.deprecatedDomainSeparator)

  for (const [list, walk] of [
    ["owners", owners],
    ["modules", modules],
  ] as const) {
    const problem = listProblem(list, walk)
    if (problem !== null) {
      findings.push(finding("list-corrupt", list, { technical: `Walking ${list} from storage: ${problem}` }))
    }
  }

  const getterChecks: [string, string, string, boolean][] = []
  if (getters.owners !== null) {
    getterChecks.push([
      "getOwners()",
      getters.owners.join(", "),
      owners.entries.join(", "),
      sameList(getters.owners, owners.entries),
    ])
  }
  if (getters.modules !== null) {
    getterChecks.push([
      "getModulesPaginated()",
      getters.modules.join(", "),
      modules.entries.join(", "),
      sameList(getters.modules, modules.entries),
    ])
  }
  if (getters.threshold !== null) {
    getterChecks.push(["getThreshold()", `${getters.threshold}`, `${threshold}`, getters.threshold === threshold])
  }
  if (getters.nonce !== null) getterChecks.push(["nonce()", `${getters.nonce}`, `${nonce}`, getters.nonce === nonce])
  for (const [fn, returned, stored, same] of getterChecks) {
    if (same) continue
    findings.push(
      finding("getter-mismatch", fn.startsWith("getModules") ? "modules" : "owners", {
        subject: safe,
        technical: `${fn} returned [${returned}], storage holds [${stored}]`,
        evidence: [{ kind: "call", to: safe, fn, result: returned }],
      }),
    )
  }

  if (ownerCount !== BigInt(owners.entries.length)) {
    findings.push(
      finding("owner-count-mismatch", "owners", {
        subject: safe,
        technical: `ownerCount (slot 3) is ${ownerCount}, the owner list has ${owners.entries.length} entries`,
        evidence: [{ kind: "slot", key: slotKey(SLOTS.ownerCount), value: toHex(ownerCount, { size: 32 }) }],
      }),
    )
  }
  if (threshold < 1n || threshold > ownerCount) {
    findings.push(
      finding("threshold-invalid", "owners", {
        subject: safe,
        technical: `threshold (slot 4) is ${threshold} with ownerCount ${ownerCount}`,
        evidence: [{ kind: "slot", key: slotKey(SLOTS.threshold), value: toHex(threshold, { size: 32 }) }],
      }),
    )
  }

  const slot6 = classifySlot6(slot6Value, safe)
  const slot6Evidence = [
    { kind: "slot" as const, key: slotKey(SLOTS.deprecatedDomainSeparator), value: toHex(slot6Value, { size: 32 }) },
  ]
  if (slot6 === "legacy") {
    findings.push(
      finding("legacy-domain-separator", "storage", {
        subject: safe,
        technical: "Slot 6 equals keccak256(abi.encode(0x035aff83...4749, safe)), the 1.0.0 to 1.2.0 domain separator",
        evidence: slot6Evidence,
      }),
    )
  } else if (slot6 === "unexpected") {
    findings.push(
      finding("slot6-unexpected", "storage", {
        subject: safe,
        technical: `Slot 6 holds ${toHex(slot6Value, { size: 32 })}; expected 0 or ${legacyDomainSeparator(safe)}`,
        evidence: slot6Evidence,
      }),
    )
  }

  return {
    owners: owners.entries,
    modules: modules.entries,
    ownerCount,
    threshold,
    nonce,
    slot6,
    findings,
  }
}
