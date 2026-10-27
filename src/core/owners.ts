import { type Address, type Hex, hexToBigInt } from "viem"
import { EMPTY_CODE_HASH } from "@/core/constants"
import { finding } from "@/core/findings"
import { parseEip7702 } from "@/core/registry"
import type {
  AccountKind,
  DecString,
  Finding,
  FindingCode,
  Identification,
  OwnerRow,
  OwnersSection,
} from "@/core/report"

// 0x01 to 0x11 are the Ethereum precompiles (Prague), 0x100 is the P-256 verifier (RIP-7212 / EIP-7951). A Safe owner
// at one of them can never sign; 0x...02 is the usual inert owner.
export function isPrecompile(address: Address): boolean {
  const value = hexToBigInt(address)
  return (value >= 0x01n && value <= 0x11n) || value === 0x100n
}

export type AccountFacts = {
  address: Address
  // Proven code hash; null when the proof shows there is no account.
  codeHash: Hex | null
  // Runtime code, when it was read (it is needed only for code the registry does not know).
  code: Hex | null
  // A known SafeProxy whose singleton is a supported Safe.
  safe: boolean
}

export function accountKind({ address, codeHash, code, safe }: AccountFacts): {
  kind: AccountKind
  delegate: Address | null
} {
  if (isPrecompile(address)) return { kind: "precompile", delegate: null }
  if (codeHash === null || codeHash.toLowerCase() === EMPTY_CODE_HASH) return { kind: "eoa", delegate: null }
  const delegate = code === null ? null : parseEip7702(code)
  if (delegate !== null) return { kind: "delegated-eoa", delegate }
  return { kind: safe ? "safe" : "contract", delegate: null }
}

export type OwnerFacts = {
  address: Address
  kind: AccountKind
  delegate: Address | null
  identification: Identification | null
  safe: OwnerRow["safe"]
}

export function checkOwners(
  owners: readonly OwnerFacts[],
  { threshold, ownerCount }: { threshold: DecString; ownerCount: DecString },
): { section: OwnersSection; findings: Finding[] } {
  const findings: Finding[] = []
  const rows = owners.map((owner): OwnerRow => {
    const flags: FindingCode[] = []
    if (owner.kind === "delegated-eoa") {
      flags.push("delegated-owner")
      findings.push(
        finding("delegated-owner", "owners", {
          subject: owner.address,
          technical: `${owner.address} has code 0xef0100 + ${owner.delegate}: an EIP-7702 delegation to ${owner.delegate}`,
        }),
      )
    }
    if (owner.kind === "contract") {
      flags.push("contract-owner")
      findings.push(
        finding("contract-owner", "owners", {
          subject: owner.address,
          technical: `${owner.address} has code (code hash ${owner.identification?.codeHash ?? "unknown"}) and is not a Safe`,
          evidence:
            owner.identification === null
              ? []
              : [{ kind: "code", address: owner.address, codeHash: owner.identification.codeHash }],
        }),
      )
    }
    return { ...owner, flags }
  })

  const inertOnly = rows.length > 0 && rows.every((row) => row.kind === "precompile")
  if (inertOnly) {
    findings.push(
      finding("inert-owners", "owners", {
        technical: `Owners: ${rows.map((row) => row.address).join(", ")}; all are precompile addresses`,
      }),
    )
    for (const row of rows) row.flags.push("inert-owners")
  }
  return { section: { owners: rows, threshold, ownerCount, inertOnly }, findings }
}
