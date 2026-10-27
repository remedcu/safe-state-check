import { type Address, type Hex, toHex } from "viem"
import { FALLBACK_HANDLER_SLOT, GUARD_SLOT, MODULE_GUARD_SLOT, SENTINEL, SLOTS } from "@/core/constants"
import type { Slot6 } from "@/core/config"
import type {
  Comparison,
  RootMatch,
  RootPass,
  SlotSource,
  SlotStatus,
  StorageSection,
  StorageSlotRow,
} from "@/core/report"
import { approvedHashSlot, moduleSlot, ownerSlot, sharedSignerSlot, signedMessageSlot, slotKey } from "@/core/slots"
import { storageRoot } from "@/core/trie"

// Labels of the formula line, in the order docs/SPEC.md section 5.4 lists them.
const PART_LABELS = [
  "singleton",
  "owner count",
  "threshold",
  "nonce",
  "owner entries",
  "module entries",
  "fallback handler",
  "guard",
  "module guard",
  "legacy domain separator",
  "passkey signer",
  "approved hashes",
  "signed messages",
  "other",
] as const
const SINGULAR: Partial<Record<string, string>> = {
  "owner entries": "owner entry",
  "module entries": "module entry",
  "approved hashes": "approved hash",
  "signed messages": "signed message",
}
export type PartLabel = (typeof PART_LABELS)[number]

export type ExpectedSlot = {
  key: Hex
  meaning: string
  technical: string
  source: SlotSource
  // Status if the slot is non-zero.
  status: SlotStatus
  part: PartLabel
}

export type Pass1Input = {
  version: string | null
  owners: readonly Address[]
  modules: readonly Address[]
  slot6: Slot6
  // Owners whose address the registry lists as the shared passkey signer.
  passkeyCandidates: readonly Address[]
  // Of those, the ones whose proven code hash is the shared signer: their slots are benign.
  passkeySigners: readonly Address[]
}

// Every key of storage pass 1: what the visible configuration says may be non-zero, and what each slot means.
export function pass1Slots(input: Pass1Input): ExpectedSlot[] {
  const fixed = (slot: bigint, meaning: string, technical: string, part: PartLabel): ExpectedSlot => ({
    key: slotKey(slot),
    meaning,
    technical,
    source: "config",
    status: "expected",
    part,
  })
  const slots: ExpectedSlot[] = [
    fixed(SLOTS.singleton, "Safe logic contract", "singleton (slot 0)", "singleton"),
    fixed(SLOTS.ownerCount, "Number of owners", "ownerCount (slot 3)", "owner count"),
    fixed(SLOTS.threshold, "Signatures required", "threshold (slot 4)", "threshold"),
    fixed(SLOTS.nonce, "Transaction counter", "nonce (slot 5)", "nonce"),
    {
      ...fixed(SLOTS.deprecatedDomainSeparator, "Unused slot", "_deprecatedDomainSeparator (slot 6)", "other"),
      ...(input.slot6 === "legacy"
        ? {
            meaning: "Leftover from Safe 1.0.0 to 1.2.0",
            status: "benign" as const,
            part: "legacy domain separator" as const,
          }
        : { status: "suspicious" as const }),
    },
    {
      key: FALLBACK_HANDLER_SLOT,
      meaning: "Fallback handler",
      technical: 'keccak256("fallback_manager.handler.address")',
      source: "config",
      status: "expected",
      part: "fallback handler",
    },
    {
      key: GUARD_SLOT,
      meaning: "Transaction guard",
      technical: 'keccak256("guard_manager.guard.address")',
      source: "config",
      status: "expected",
      part: "guard",
    },
    {
      key: MODULE_GUARD_SLOT,
      meaning: input.version === "1.5.0" ? "Module guard" : "Module guard slot, unused before Safe 1.5.0",
      technical: 'keccak256("module_manager.module_guard.address")',
      source: "config",
      status: input.version === "1.5.0" ? "expected" : "suspicious",
      part: "module guard",
    },
  ]
  for (const [list, entries, slotOf, part] of [
    ["owners", input.owners, ownerSlot, "owner entries"],
    ["modules", input.modules, moduleSlot, "module entries"],
  ] as const) {
    const label = list === "owners" ? "Owner list" : "Module list"
    slots.push({
      key: slotOf(SENTINEL),
      meaning: `${label} start`,
      technical: `${list}[0x1]`,
      source: "config",
      status: "expected",
      part,
    })
    for (const entry of entries) {
      slots.push({
        key: slotOf(entry),
        meaning: `${label} entry`,
        technical: `${list}[${entry}]`,
        source: "config",
        status: "expected",
        part,
      })
    }
  }
  for (const signer of input.passkeyCandidates) {
    const benign = input.passkeySigners.includes(signer)
    const base = BigInt(sharedSignerSlot(signer))
    ;["x", "y", "verifiers"].forEach((field, offset) => {
      slots.push({
        key: slotKey(base + BigInt(offset)),
        meaning: `Passkey ${field === "verifiers" ? "verifiers" : `public key ${field}`}`,
        technical: `SafeWebAuthnSharedSigner ${signer} SIGNER_SLOT + ${offset} (${field})`,
        source: "derived",
        status: benign ? "benign" : "suspicious",
        part: "passkey signer",
      })
    })
  }
  return slots
}

export type EventSlotInput = {
  // approvedHashes[owner][hash] from ApproveHash events.
  approvedHashes: readonly { owner: Address; hash: Hex }[]
  // signedMessages[hash] from SignMsg events.
  signedMessages: readonly Hex[]
}

// Pass 2 keys: the approved hashes and signed messages the events name, benign when non-zero.
export function eventSlots({ approvedHashes, signedMessages }: EventSlotInput): ExpectedSlot[] {
  const slots: ExpectedSlot[] = []
  for (const { owner, hash } of approvedHashes) {
    slots.push({
      key: approvedHashSlot(owner, hash),
      meaning: "Pre-approved transaction",
      technical: `approvedHashes[${owner}][${hash}]`,
      source: "event",
      status: "benign",
      part: "approved hashes",
    })
  }
  for (const hash of signedMessages) {
    slots.push({
      key: signedMessageSlot(hash),
      meaning: "Signed message",
      technical: `signedMessages[${hash}]`,
      source: "event",
      status: "benign",
      part: "signed messages",
    })
  }
  return slots
}

export type ProvenValues = {
  values: ReadonlyMap<Hex, bigint>
  // The cross-check's comparison of this read's values, and the keys it disagreed on.
  cross: Comparison
  mismatched: readonly Hex[]
}

// Rows for every non-zero slot of `slots`, from one proven read.
export function storageRows(slots: readonly ExpectedSlot[], read: ProvenValues): StorageSlotRow[] {
  const mismatched = new Set(read.mismatched.map((key) => key.toLowerCase()))
  const rows: StorageSlotRow[] = []
  const seen = new Set<Hex>()
  for (const slot of slots) {
    const key = slot.key.toLowerCase() as Hex
    if (seen.has(key)) continue
    seen.add(key)
    const value = read.values.get(key) ?? 0n
    if (value === 0n) continue
    rows.push({
      key,
      value: toHex(value, { size: 32 }),
      meaning: slot.meaning,
      technical: slot.technical,
      source: slot.source,
      status: slot.status,
      proven: true,
      cross: mismatched.has(key) ? "mismatch" : read.cross,
    })
  }
  return rows
}

// Rebuilds the storage root from `rows` and compares it with the proven root of the same read.
export async function rootPass(by: RootMatch, rows: readonly StorageSlotRow[], actualRoot: Hex): Promise<RootPass> {
  const expectedRoot = await storageRoot(rows.map((row) => ({ slot: row.key, value: BigInt(row.value) })))
  return { by, slotCount: rows.length, expectedRoot, match: expectedRoot === actualRoot.toLowerCase() }
}

// "Expected non-zero slots: 10 = 1 singleton + 1 owner count + ...", counting the expected and benign rows. For
// reading only; the root is the check.
export function formula(slots: readonly ExpectedSlot[], rows: readonly StorageSlotRow[]): StorageSection["formula"] {
  const partOf = new Map(slots.map((slot) => [slot.key.toLowerCase(), slot.part]))
  const counts = new Map<PartLabel, number>()
  let total = 0
  for (const row of rows) {
    if (row.status !== "expected" && row.status !== "benign") continue
    const part = partOf.get(row.key) ?? "other"
    counts.set(part, (counts.get(part) ?? 0) + 1)
    total++
  }
  const parts = PART_LABELS.filter((label) => counts.has(label)).map((label) => ({ label, count: counts.get(label)! }))
  const sum = parts
    .map(({ label, count }) => `${count} ${count === 1 ? (SINGULAR[label] ?? label) : label}`)
    .join(" + ")
  return { total, parts, text: `Expected non-zero slots: ${total}${sum === "" ? "" : ` = ${sum}`}.` }
}

const FIXED_NAMES: [Hex, string][] = [
  [slotKey(SLOTS.singleton), "singleton (slot 0)"],
  [slotKey(SLOTS.modules), "slot 1"],
  [slotKey(SLOTS.owners), "slot 2"],
  [slotKey(SLOTS.ownerCount), "ownerCount (slot 3)"],
  [slotKey(SLOTS.threshold), "threshold (slot 4)"],
  [slotKey(SLOTS.nonce), "nonce (slot 5)"],
  [slotKey(SLOTS.deprecatedDomainSeparator), "_deprecatedDomainSeparator (slot 6)"],
  [GUARD_SLOT, "guard"],
  [FALLBACK_HANDLER_SLOT, "fallback handler"],
  [MODULE_GUARD_SLOT, "module guard"],
]

// What a slot key is, when it is a fixed slot or a list entry of one of `addresses`; "" otherwise.
export function describeKey(key: Hex, addresses: readonly Address[]): string {
  const wanted = key.toLowerCase()
  const fixedName = FIXED_NAMES.find(([slot]) => slot === wanted)?.[1]
  if (fixedName !== undefined) return fixedName
  for (const address of [SENTINEL, ...addresses]) {
    if (ownerSlot(address) === wanted) return `owners[${address}]`
    if (moduleSlot(address) === wanted) return `modules[${address}]`
  }
  return ""
}
