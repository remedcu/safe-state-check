import type { Address, Hex } from "viem"
import { describe, expect, it } from "vitest"
import { B1, B3 } from "@/core/__tests__/fixtures/appendixB"
import { SENTINEL } from "@/core/constants"
import { walkList } from "@/core/linkedList"
import { ownerSlot } from "@/core/slots"
import type { StorageEntry } from "@/core/trie"

const A = "0x000000000000000000000000000000000000000A"
const B = "0x000000000000000000000000000000000000000b"
const C = "0x000000000000000000000000000000000000000C"

function slotMap(entries: readonly StorageEntry[]): Map<Hex, bigint> {
  return new Map(entries.map(({ slot, value }) => [slot, value]))
}

// An owners list from `pointers`, each `[from, to]` meaning `owners[from] = to`.
function owners(...pointers: [Address, Address | bigint][]): Map<Hex, bigint> {
  return new Map(pointers.map(([from, to]) => [ownerSlot(from), typeof to === "bigint" ? to : BigInt(to)]))
}

describe("walkList", () => {
  it("walks the lists of real Safes", () => {
    expect(walkList("owners", slotMap(B1))).toEqual({ entries: ["0x802cbafa6133c493A7c67f685f97AdA5918d1dF9"] })
    expect(walkList("modules", slotMap(B1))).toEqual({
      entries: ["0x4210382652A5e3C9aF7e1D3c88085818A465449b", "0x8DFc5Db2C83200Cf0cC84d7e3C441d7721ef83dC"],
    })
    expect(walkList("owners", slotMap(B3)).entries).toHaveLength(3)
    // An empty module list is `modules[SENTINEL] = SENTINEL`.
    expect(walkList("modules", slotMap(B3))).toEqual({ entries: [] })
  })

  it("accepts the expected entries in any letter case", () => {
    const values = owners([SENTINEL, A], [A, B], [B, SENTINEL])

    expect(walkList("owners", values, { expected: [A.toLowerCase() as Address, B] })).toEqual({ entries: [A, B] })
  })

  it("reports a list that differs from the expected one", () => {
    const values = owners([SENTINEL, A], [A, B], [B, SENTINEL])

    expect(walkList("owners", values, { expected: [B, A] }).problem).toEqual({ kind: "mismatch", expected: [B, A] })
  })

  it("reports a list that ends early", () => {
    const values = owners([SENTINEL, A], [A, SENTINEL], [B, C], [C, SENTINEL])

    expect(walkList("owners", values, { expected: [A, B, C] })).toEqual({
      entries: [A],
      problem: { kind: "mismatch", expected: [A, B, C] },
    })
  })

  it("reports a cycle", () => {
    const values = owners([SENTINEL, A], [A, B], [B, A])

    expect(walkList("owners", values)).toEqual({ entries: [A, B], problem: { kind: "cycle", at: A } })
    expect(walkList("owners", owners([SENTINEL, A], [A, A]))).toEqual({
      entries: [A],
      problem: { kind: "cycle", at: A },
    })
  })

  it("reports a broken pointer", () => {
    expect(walkList("owners", owners([SENTINEL, A], [A, 0n]))).toEqual({
      entries: [A],
      problem: { kind: "broken", at: A, value: 0n },
    })
    const notAnAddress = (1n << 160n) | 0xbn
    expect(walkList("owners", owners([SENTINEL, A], [A, notAnAddress]))).toEqual({
      entries: [A],
      problem: { kind: "broken", at: A, value: notAnAddress },
    })
  })

  it("reports an entry that was not read", () => {
    expect(walkList("owners", owners([SENTINEL, A]))).toEqual({ entries: [A], problem: { kind: "unread", at: A } })
    expect(walkList("modules", owners([SENTINEL, A]))).toEqual({
      entries: [],
      problem: { kind: "unread", at: SENTINEL },
    })
  })

  it("stops at the length cap", () => {
    const values = owners([SENTINEL, A], [A, B], [B, C], [C, SENTINEL])

    expect(walkList("owners", values, { maxLength: 3 })).toEqual({ entries: [A, B, C] })
    expect(walkList("owners", values, { maxLength: 2 })).toEqual({
      entries: [A, B],
      problem: { kind: "tooLong", limit: 2 },
    })
  })
})
