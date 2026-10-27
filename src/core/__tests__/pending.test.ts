import type { Address, Hex } from "viem"
import { describe, expect, it } from "vitest"
import { checkPending, type PendingInput, type QueuedTx } from "@/core/pending"
import { approvedHashSlot, signedMessageSlot } from "@/core/slots"

const OWNER: Address = "0x802cbafa6133c493A7c67f685f97AdA5918d1dF9"
const HASH_A: Hex = "0x9b8d6c1a8f5dfcb5d6b5c1f0a9e0c8f6f2a4d3e1b7c9a5f3e2d1c0b9a8f7e6d5"
const HASH_B: Hex = "0x1111111111111111111111111111111111111111111111111111111111111111"

function queued(nonce: string): QueuedTx {
  return {
    nonce,
    safeTxHash: HASH_B,
    to: OWNER,
    value: "0",
    operation: "call",
    confirmations: 1,
    required: 2,
  }
}

function input(overrides: Partial<PendingInput> = {}): PendingInput {
  return {
    currentNonce: 3n,
    approvedHashes: [],
    signedMessages: [],
    executed: new Set(),
    queued: [],
    sources: [{ service: "rpc", host: "eth.drpc.org" }],
    ...overrides,
  }
}

const codes = (overrides: Partial<PendingInput>) => checkPending(input(overrides)).findings.map((f) => f.code)

describe("checkPending", () => {
  it("lists a non-zero approved hash that has not executed", () => {
    const result = checkPending(input({ approvedHashes: [{ owner: OWNER, hash: HASH_A, slotValue: 1n, nonce: "4" }] }))

    expect(result.findings.map((f) => f.code)).toEqual(["pending-approved-hash"])
    expect(result.section.approvedHashes).toEqual([
      { owner: OWNER, hash: HASH_A, slot: approvedHashSlot(OWNER, HASH_A), nonce: "4" },
    ])
  })

  it("drops an approved hash whose slot is zero or that already executed", () => {
    expect(codes({ approvedHashes: [{ owner: OWNER, hash: HASH_A, slotValue: 0n, nonce: null }] })).toEqual([])
    expect(
      codes({
        approvedHashes: [{ owner: OWNER, hash: HASH_A, slotValue: 1n, nonce: null }],
        executed: new Set([HASH_A.toLowerCase()]),
      }),
    ).toEqual([])
  })

  it("lists a non-zero signed message", () => {
    const result = checkPending(input({ signedMessages: [{ hash: HASH_A, slotValue: 1n }] }))

    expect(result.findings.map((f) => f.code)).toEqual(["signed-message"])
    expect(result.section.signedMessages).toEqual([{ hash: HASH_A, slot: signedMessageSlot(HASH_A) }])
    expect(checkPending(input({ signedMessages: [{ hash: HASH_A, slotValue: 0n }] })).findings).toEqual([])
  })

  it("takes an approval's nonce from the queued transaction with the same hash", () => {
    const result = checkPending(
      input({
        approvedHashes: [{ owner: OWNER, hash: HASH_B, slotValue: 1n, nonce: null }],
        queued: [queued("4")],
      }),
    )

    expect(result.section.approvedHashes[0].nonce).toBe("4")
  })

  it("carries the Transaction Service messages and delegates", () => {
    const messages = [{ hash: HASH_A, confirmations: 2, created: "2026-10-01T00:00:00Z" }]
    const delegates = [{ delegate: OWNER, delegator: OWNER, label: "bot" }]
    const { section } = checkPending(input({ messages, delegates }))

    expect(section.messages).toEqual(messages)
    expect(section.delegates).toEqual(delegates)
  })

  it("lists queued transactions at or above the current nonce only", () => {
    const result = checkPending(input({ queued: [queued("2"), queued("3"), queued("5")] }))

    expect(result.findings.map((f) => f.code)).toEqual(["queued-transaction", "queued-transaction"])
    expect(result.section.queued.map((tx) => tx.nonce)).toEqual(["3", "5"])
  })
})
