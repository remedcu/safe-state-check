import { type Address, getAddress, type Hex, isAddressEqual, toHex } from "viem"
import { SENTINEL } from "@/core/constants"
import { moduleSlot, ownerSlot } from "@/core/slots"

// Far above any real Safe; it only bounds the walk.
export const MAX_LIST_LENGTH = 1000

export type ListProblem =
  // The entry of `at` is not in the slot-value map, so the walk cannot go on.
  | { kind: "unread"; at: Address }
  // The entry of `at` is zero or not an address.
  | { kind: "broken"; at: Address; value: bigint }
  // `at` is reached a second time.
  | { kind: "cycle"; at: Address }
  | { kind: "tooLong"; limit: number }
  // The list is well formed but differs from `expected` (for example it ends early).
  | { kind: "mismatch"; expected: Address[] }

export type ListWalk = { entries: Address[]; problem?: ListProblem }

// Walks the owners or modules linked list from raw storage: `list[SENTINEL]` is the first entry, each entry points to
// the next, and the last points back to `SENTINEL`. `values` maps lowercase slot keys to their values. `entries` holds
// what was walked before any problem.
export function walkList(
  list: "owners" | "modules",
  values: ReadonlyMap<Hex, bigint>,
  { expected, maxLength = MAX_LIST_LENGTH }: { expected?: readonly Address[]; maxLength?: number } = {},
): ListWalk {
  const slotOf = list === "owners" ? ownerSlot : moduleSlot
  const entries: Address[] = []
  const seen = new Set<Address>()

  let current = SENTINEL
  while (true) {
    const value = values.get(slotOf(current))
    if (value === undefined) return { entries, problem: { kind: "unread", at: current } }
    if (value === 0n || value >> 160n !== 0n) return { entries, problem: { kind: "broken", at: current, value } }

    const next = getAddress(toHex(value, { size: 20 }))
    if (next === SENTINEL) break
    if (seen.has(next)) return { entries, problem: { kind: "cycle", at: next } }
    if (entries.length === maxLength) return { entries, problem: { kind: "tooLong", limit: maxLength } }
    seen.add(next)
    entries.push(next)
    current = next
  }

  if (
    expected !== undefined &&
    (expected.length !== entries.length || expected.some((entry, index) => !isAddressEqual(entry, entries[index])))
  ) {
    return { entries, problem: { kind: "mismatch", expected: [...expected] } }
  }
  return { entries }
}
