import { createPublicClient, custom, type Hex, hexToBigInt } from "viem"
import { mainnet } from "viem/chains"
import { describe, expect, it } from "vitest"
import { B1, B3, FIXTURES } from "@/core/__tests__/fixtures/appendixB"
import { ADDRESS } from "@/core/__tests__/fixtures/registry"
import recorded from "@/core/__tests__/fixtures/proof-reward-distribution-26176126.json"
import { describeKey, formula, type Pass1Input, pass1Slots, rootPass, storageRows } from "@/core/accounting"
import { legacyDomainSeparator } from "@/core/config"
import { MODULE_GUARD_SLOT } from "@/core/constants"
import { verifyAccountProof, verifyStorageProof } from "@/core/proof"
import { ownerSlot, sharedSignerSlot, slotKey } from "@/core/slots"

const B1_SAFE = "0xAd219b3c26fe42BF5FC66F67490745a4fa5dff59"
const B1_INPUT: Pass1Input = {
  version: "1.4.1",
  owners: ["0x802cbafa6133c493A7c67f685f97AdA5918d1dF9"],
  modules: ["0x4210382652A5e3C9aF7e1D3c88085818A465449b", "0x8DFc5Db2C83200Cf0cC84d7e3C441d7721ef83dC"],
  slot6: "zero",
  passkeyCandidates: [],
  passkeySigners: [],
}
const B3_INPUT: Pass1Input = {
  version: "1.5.0",
  owners: [
    "0xa3840d235de294e55c5ba4a3c57942617c7e3c05",
    "0xb1df01604095536cea66a9d06e67ed6f00684e58",
    "0x9f7dfab2222a473284205cddf08a677726d786a0",
  ],
  modules: [],
  slot6: "zero",
  passkeyCandidates: [],
  passkeySigners: [],
}

function read(entries: readonly { slot: Hex; value: bigint }[]) {
  return {
    values: new Map(entries.map(({ slot, value }) => [slot.toLowerCase() as Hex, value])),
    cross: "match" as const,
    mismatched: [],
  }
}

describe("storage pass 1", () => {
  it.each([
    ["B1", B1_INPUT, B1, FIXTURES[0].root],
    ["B3", B3_INPUT, B3, FIXTURES[4].root],
  ] as const)("explains every slot of %s and rebuilds its root", async (_, input, entries, root) => {
    const slots = pass1Slots(input)
    const rows = storageRows(slots, read(entries))
    const pass = await rootPass("config", rows, root)

    expect(rows.map((row) => row.key).sort()).toEqual(entries.map((entry) => entry.slot).sort())
    expect(rows.every((row) => row.status === "expected" && row.proven && row.source === "config")).toBe(true)
    expect(pass).toEqual({ by: "config", slotCount: entries.length, expectedRoot: root, match: true })
  })

  it("misses a shadow owner, so the root does not match (B1-neg)", async () => {
    const rows = storageRows(pass1Slots(B1_INPUT), read(FIXTURES[1].entries))
    const pass = await rootPass("config", rows, FIXTURES[1].root)

    expect(pass.match).toBe(false)
    expect(pass.expectedRoot).toBe(FIXTURES[0].root)
  })

  it("writes the formula line of docs/SPEC.md section 5.4", () => {
    const slots = pass1Slots(B1_INPUT)

    expect(formula(slots, storageRows(slots, read(B1))).text).toBe(
      "Expected non-zero slots: 10 = 1 singleton + 1 owner count + 1 threshold + 1 nonce + 2 owner entries + 3 module entries + 1 fallback handler.",
    )
    expect(formula(slots, []).text).toBe("Expected non-zero slots: 0.")
    const b3 = pass1Slots(B3_INPUT)
    expect(formula(b3, storageRows(b3, read(B3))).text).toBe(
      "Expected non-zero slots: 9 = 1 singleton + 1 owner count + 1 threshold + 4 owner entries + 1 module entry + 1 fallback handler.",
    )
  })

  it("marks a legacy slot 6 benign and anything else in it suspicious", () => {
    const value = BigInt(legacyDomainSeparator(B1_SAFE))
    const withSlot6 = [...B1, { slot: slotKey(6n), value }]
    const legacy = storageRows(pass1Slots({ ...B1_INPUT, slot6: "legacy" }), read(withSlot6))
    const odd = storageRows(pass1Slots({ ...B1_INPUT, slot6: "unexpected" }), read(withSlot6))
    const slots = pass1Slots({ ...B1_INPUT, slot6: "legacy" })

    expect(legacy.find((row) => row.key === slotKey(6n))?.status).toBe("benign")
    expect(odd.find((row) => row.key === slotKey(6n))?.status).toBe("suspicious")
    expect(formula(slots, legacy).text).toContain("+ 1 legacy domain separator.")
  })

  it("marks a module guard below 1.5.0 suspicious and leaves it out of the formula", () => {
    const entries = [...B1, { slot: MODULE_GUARD_SLOT, value: 0xbadn }]
    const slots = pass1Slots(B1_INPUT)
    const rows = storageRows(slots, read(entries))

    expect(rows.find((row) => row.key === MODULE_GUARD_SLOT)?.status).toBe("suspicious")
    expect(formula(slots, rows).total).toBe(10)
    expect(pass1Slots({ ...B1_INPUT, version: "1.5.0" }).find((s) => s.key === MODULE_GUARD_SLOT)?.status).toBe(
      "expected",
    )
  })

  it("reads the shared passkey signer's three slots, benign only once its code is proven", () => {
    const signer = ADDRESS.sharedSigner
    const base = hexToBigInt(sharedSignerSlot(signer))
    const entries = [0n, 1n, 2n].map((offset) => ({ slot: slotKey(base + offset), value: 7n + offset }))
    const candidate = { ...B1_INPUT, owners: [signer], passkeyCandidates: [signer] }

    const proven = storageRows(pass1Slots({ ...candidate, passkeySigners: [signer] }), read(entries))
    const unproven = storageRows(pass1Slots(candidate), read(entries))

    expect(proven.map((row) => row.status)).toEqual(["benign", "benign", "benign"])
    expect(proven.map((row) => row.source)).toEqual(["derived", "derived", "derived"])
    expect(unproven.map((row) => row.status)).toEqual(["suspicious", "suspicious", "suspicious"])
  })

  it("marks a value the cross-check disagreed on", () => {
    const rows = storageRows(pass1Slots(B1_INPUT), { ...read(B1), mismatched: [slotKey(5n)] })

    expect(rows.find((row) => row.key === slotKey(5n))?.cross).toBe("mismatch")
    expect(rows.find((row) => row.key === slotKey(4n))?.cross).toBe("match")
  })

  // Invariants 1, 3 and 15: rows built only from values verified against one storageHash rebuild that storageHash.
  it("rebuilds the proven root from the recorded eth_getProof of the B1 Safe", async () => {
    const request = async () => structuredClone(recorded.proof)
    const client = createPublicClient({ chain: mainnet, transport: custom({ request }) })
    const keys = recorded.proof.storageProof.map(({ key }) => key as Hex)
    const proof = await client.getProof({ address: B1_SAFE, storageKeys: keys, blockNumber: 26176126n })
    const account = (await verifyAccountProof(recorded.block.stateRoot as Hex, B1_SAFE, proof))!
    const values = new Map<Hex, bigint>()
    for (const [index, entry] of proof.storageProof.entries()) {
      values.set(keys[index].toLowerCase() as Hex, await verifyStorageProof(account.storageHash, keys[index], entry))
    }

    const rows = storageRows(pass1Slots(B1_INPUT), { values, cross: "not-run", mismatched: [] })
    const pass = await rootPass("config", rows, account.storageHash)

    expect(pass.match).toBe(true)
    expect(account.storageHash).toBe(FIXTURES[0].root)
  })
})

describe("describeKey", () => {
  it("names fixed slots and list entries", () => {
    expect(describeKey(slotKey(0n), [])).toBe("singleton (slot 0)")
    expect(describeKey(MODULE_GUARD_SLOT, [])).toBe("module guard")
    expect(describeKey(ownerSlot(B1_INPUT.owners[0]), B1_INPUT.owners)).toBe(`owners[${B1_INPUT.owners[0]}]`)
    expect(describeKey(slotKey(9n), B1_INPUT.owners)).toBe("")
  })
})
