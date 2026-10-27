import { describe, expect, it } from "vitest"
import { B1, FIXTURES } from "@/core/__tests__/fixtures/appendixB"
import { storageRoot } from "@/core/trie"

const EMPTY_TRIE_ROOT = "0x56e81f171bcc55a6ff8345e692c0f86e5b48e01b996cadc001622fb5e363b421"

describe("storageRoot", () => {
  it.each(FIXTURES)("reproduces the $name root", async ({ entries, root }) => {
    expect(await storageRoot(entries)).toBe(root)
  })

  it("does not depend on the order of the entries", async () => {
    expect(await storageRoot([...B1].reverse())).toBe(FIXTURES[0].root)
  })

  it("gives the empty trie root for no storage", async () => {
    expect(await storageRoot([])).toBe(EMPTY_TRIE_ROOT)
  })

  it("skips zero values", async () => {
    const zero = { slot: "0x0000000000000000000000000000000000000000000000000000000000000006" as const, value: 0n }

    expect(await storageRoot([...B1, zero])).toBe(FIXTURES[0].root)
    expect(await storageRoot([zero])).toBe(EMPTY_TRIE_ROOT)
  })

  it("accepts short slot keys", async () => {
    const short = B1.map((entry) =>
      entry.slot === `0x${"0".repeat(63)}3` ? { ...entry, slot: "0x3" as const } : entry,
    )

    expect(await storageRoot(short)).toBe(FIXTURES[0].root)
  })

  it("rejects a slot listed twice with different values", async () => {
    await expect(storageRoot([...B1, { slot: B1[0].slot, value: 1n }])).rejects.toThrow("listed twice")
  })

  it("rejects values outside uint256", async () => {
    const slot = B1[0].slot
    await expect(storageRoot([{ slot, value: -1n }])).rejects.toThrow("not a uint256")
    await expect(storageRoot([{ slot, value: 1n << 256n }])).rejects.toThrow("not a uint256")
  })
})
