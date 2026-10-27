import { createPublicClient, custom, type GetProofReturnType, type Hex, hexToBigInt } from "viem"
import { mainnet } from "viem/chains"
import { describe, expect, it } from "vitest"
import { FIXTURES } from "@/core/__tests__/fixtures/appendixB"
import recorded from "@/core/__tests__/fixtures/proof-reward-distribution-26176126.json"
import { ProofError, verifyAccountProof, verifyStorageProof } from "@/core/proof"
import { storageRoot } from "@/core/trie"

const SAFE = "0xAd219b3c26fe42BF5FC66F67490745a4fa5dff59"
const STATE_ROOT = recorded.block.stateRoot as Hex
const SLOTS = recorded.proof.storageProof.map(({ key }) => key as Hex)
const SLOT_6 = SLOTS[10]
const ABSENT = "0xadab0c32b63104018959a46abf523ba939af7245"

// Goes through viem's own `getProof`, so the input has exactly the shape the data layer will pass. A fresh copy per
// call, since viem keeps the response's arrays and the tests tamper with them.
async function loadProof(response: object = recorded.proof): Promise<GetProofReturnType> {
  const request = async () => structuredClone(response)
  const client = createPublicClient({ chain: mainnet, transport: custom({ request }) })
  return client.getProof({ address: SAFE, storageKeys: SLOTS, blockNumber: hexToBigInt(recorded.block.number as Hex) })
}

// Flips the last byte of a proof node, which changes its hash.
function tamper(node: Hex): Hex {
  const last = parseInt(node.slice(-2), 16) ^ 1
  return `${node.slice(0, -2)}${last.toString(16).padStart(2, "0")}` as Hex
}

describe("verifyAccountProof", () => {
  it("returns the proven account", async () => {
    const account = await verifyAccountProof(STATE_ROOT, SAFE, await loadProof())

    expect(account).toEqual({
      nonce: 1n,
      balance: 0n,
      storageHash: FIXTURES[0].root,
      codeHash: "0xd7d408ebcd99b2b70be43e20253d6d92a8ea8fab29bd3be7f55b10032331fb4c",
    })
  })

  it("returns null for a proven missing account, ignoring the RPC's placeholder fields", async () => {
    const proof = await loadProof(recorded.absentProof)

    expect(await verifyAccountProof(STATE_ROOT, ABSENT, proof)).toBeNull()
  })

  it("rejects a tampered missing-account proof", async () => {
    const proof = await loadProof(recorded.absentProof)
    proof.accountProof[7] = tamper(proof.accountProof[7])

    await expect(verifyAccountProof(STATE_ROOT, ABSENT, proof)).rejects.toThrow(ProofError)
  })

  it("rejects a tampered proof node", async () => {
    for (const index of [0, 4]) {
      const proof = await loadProof()
      proof.accountProof[index] = tamper(proof.accountProof[index])

      await expect(verifyAccountProof(STATE_ROOT, SAFE, proof)).rejects.toThrow(ProofError)
    }
  })

  it("rejects a different state root", async () => {
    const otherRoot = FIXTURES[0].root

    await expect(verifyAccountProof(otherRoot, SAFE, await loadProof())).rejects.toThrow("does not match the root")
  })

  it("rejects a proof for another account", async () => {
    await expect(
      verifyAccountProof(STATE_ROOT, "0x802cbafa6133c493A7c67f685f97AdA5918d1dF9", await loadProof()),
    ).rejects.toThrow("instead of")
  })

  it("rejects RPC fields that disagree with the proof", async () => {
    const lies: Partial<GetProofReturnType>[] = [
      { nonce: 2 },
      { balance: 1n },
      { storageHash: FIXTURES[1].root },
      { codeHash: FIXTURES[1].root },
    ]
    for (const lie of lies) {
      const proof = { ...(await loadProof()), ...lie }

      await expect(verifyAccountProof(STATE_ROOT, SAFE, proof)).rejects.toThrow("differs from the proven")
    }
  })
})

describe("verifyStorageProof", () => {
  it("returns every proven value, and they rebuild the storage root", async () => {
    const proof = await loadProof()
    const { storageHash } = (await verifyAccountProof(STATE_ROOT, SAFE, proof))!

    const values = await Promise.all(
      proof.storageProof.map((entry, index) => verifyStorageProof(storageHash, SLOTS[index], entry)),
    )

    expect(values.slice(0, 10)).toEqual(FIXTURES[0].entries.map(({ value }) => value))
    expect(await storageRoot(SLOTS.map((slot, index) => ({ slot, value: values[index] })))).toBe(storageHash)
  })

  it("accepts a slot key without leading zeros", async () => {
    const proof = await loadProof()

    expect(await verifyStorageProof(FIXTURES[0].root, "0x5", proof.storageProof[3])).toBe(3n)
  })

  it("proves an absent slot as zero", async () => {
    const proof = await loadProof()

    expect(await verifyStorageProof(FIXTURES[0].root, SLOT_6, proof.storageProof[10])).toBe(0n)
  })

  it("rejects a tampered proof node", async () => {
    const entry = (await loadProof()).storageProof[5]
    const proof = { ...entry, proof: [entry.proof[0], tamper(entry.proof[1]), entry.proof[2]] }

    await expect(verifyStorageProof(FIXTURES[0].root, SLOTS[5], proof)).rejects.toThrow(ProofError)
  })

  it("rejects a tampered value", async () => {
    const proof = await loadProof()
    const lies = [
      { ...proof.storageProof[3], value: 4n },
      { ...proof.storageProof[10], value: 1n },
    ]

    await expect(verifyStorageProof(FIXTURES[0].root, SLOTS[3], lies[0])).rejects.toThrow("differs from the proven")
    await expect(verifyStorageProof(FIXTURES[0].root, SLOT_6, lies[1])).rejects.toThrow("differs from the proven")
  })

  it("rejects a different storage root", async () => {
    const proof = await loadProof()

    await expect(verifyStorageProof(FIXTURES[1].root, SLOTS[0], proof.storageProof[0])).rejects.toThrow(
      "does not match the root",
    )
  })

  it("rejects a proof for another slot", async () => {
    const proof = await loadProof()

    await expect(verifyStorageProof(FIXTURES[0].root, SLOTS[3], proof.storageProof[0])).rejects.toThrow("instead of")
    // Relabelled to the requested slot, the nodes still prove slot 0, so verification fails.
    const relabelled = { ...proof.storageProof[0], key: SLOTS[3] }
    await expect(verifyStorageProof(FIXTURES[0].root, SLOTS[3], relabelled)).rejects.toThrow(ProofError)
  })
})

describe("verifyStorageProof on an empty storage trie", () => {
  const EMPTY = "0x56e81f171bcc55a6ff8345e692c0f86e5b48e01b996cadc001622fb5e363b421" as const
  const SLOT = "0x0000000000000000000000000000000000000000000000000000000000000004" as const
  const entry = (proof: Hex[], value = 0n) => ({ key: SLOT, value, proof })

  // An account with no storage (the B1 owner at block 26176126) has the empty-trie root; every slot is proven zero.
  it("proves every slot zero, for both forms clients send", async () => {
    expect(await verifyStorageProof(EMPTY, SLOT, entry([]))).toBe(0n)
    expect(await verifyStorageProof(EMPTY, SLOT, entry(["0x80"]))).toBe(0n)
    // A non-zero key hashes elsewhere but is still absent from the empty trie.
    expect(await verifyStorageProof(EMPTY, SLOTS[5], { key: SLOTS[5], value: 0n, proof: [] })).toBe(0n)
  })

  it("rejects a proof that claims the empty root has contents", async () => {
    const node = (await loadProof()).storageProof[0].proof[0]

    await expect(verifyStorageProof(EMPTY, SLOT, entry([node]))).rejects.toThrow("has contents")
    await expect(verifyStorageProof(EMPTY, SLOT, entry(["0x80", "0x80"]))).rejects.toThrow("has contents")
  })

  it("rejects an RPC that claims a non-zero value against the empty root", async () => {
    await expect(verifyStorageProof(EMPTY, SLOT, entry([], 1n))).rejects.toThrow("differs from the proven")
  })

  // The empty-root path must not weaken a real root: a non-empty root still rejects an empty proof.
  it("still rejects an empty proof against a non-empty root", async () => {
    await expect(verifyStorageProof(FIXTURES[0].root, SLOT, entry([]))).rejects.toThrow(ProofError)
  })
})
