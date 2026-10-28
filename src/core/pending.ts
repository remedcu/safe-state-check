import type { Address, Hex } from "viem"
import { finding } from "@/core/findings"
import type { Finding, PendingSection, ServiceRef } from "@/core/report"
import { approvedHashSlot, signedMessageSlot } from "@/core/slots"

export type ApprovedHashFact = {
  owner: Address
  hash: Hex
  // Proven value of approvedHashes[owner][hash].
  slotValue: bigint
  // The nonce of a queued Transaction Service transaction with this safeTxHash, if any.
  nonce: string | null
}

export type SignedMessageFact = { hash: Hex; slotValue: bigint }

export type QueuedTx = {
  nonce: string
  safeTxHash: Hex
  to: Address
  value: string
  operation: "call" | "delegatecall"
  confirmations: number
  required: number
}

export type PendingInput = {
  currentNonce: bigint
  approvedHashes: readonly ApprovedHashFact[]
  signedMessages: readonly SignedMessageFact[]
  // safeTxHashes that an ExecutionSuccess event already ran, so their approvals are spent.
  executed: ReadonlySet<string>
  queued: readonly QueuedTx[]
  // Offchain messages and delegates the Transaction Service holds, when it is on.
  messages?: PendingSection["messages"]
  delegates?: PendingSection["delegates"]
  sources: readonly ServiceRef[]
}

// An approved hash whose slot is still non-zero and that no ExecutionSuccess ran is a pending action; a non-zero
// signedMessages slot is a message the Safe accepts; a Transaction Service transaction at or above the current nonce
// can still execute.
export function checkPending(input: PendingInput): { section: PendingSection; findings: Finding[] } {
  const findings: Finding[] = []

  // The nonce of an approval comes from a queued transaction with the same safeTxHash, when there is one.
  const queuedNonce = (hash: Hex) =>
    input.queued.find((tx) => tx.safeTxHash.toLowerCase() === hash.toLowerCase())?.nonce ?? null
  const approvedHashes = input.approvedHashes
    .filter((entry) => entry.slotValue !== 0n)
    .map((entry) => ({
      owner: entry.owner,
      hash: entry.hash,
      slot: approvedHashSlot(entry.owner, entry.hash),
      nonce: entry.nonce ?? queuedNonce(entry.hash),
    }))
  for (const entry of approvedHashes) {
    if (input.executed.has(entry.hash.toLowerCase())) continue
    findings.push(
      finding("pending-approved-hash", "pending", {
        subject: entry.hash,
        technical: `Owner ${entry.owner} approved hash ${entry.hash} onchain, and no ExecutionSuccess has run it`,
        evidence: [
          {
            kind: "slot",
            key: entry.slot,
            value: "0x0000000000000000000000000000000000000000000000000000000000000001",
          },
        ],
      }),
    )
  }

  const signedMessages = input.signedMessages
    .filter((entry) => entry.slotValue !== 0n)
    .map((entry) => ({ hash: entry.hash, slot: signedMessageSlot(entry.hash) }))
  for (const entry of signedMessages) {
    findings.push(
      finding("signed-message", "pending", {
        subject: entry.hash,
        technical: `The Safe marked message ${entry.hash} as signed (SignMessageLib)`,
      }),
    )
  }

  const queued = input.queued.filter((tx) => BigInt(tx.nonce) >= input.currentNonce)
  for (const tx of queued) {
    findings.push(
      finding("queued-transaction", "pending", {
        subject: tx.safeTxHash,
        technical: `Transaction ${tx.safeTxHash} for nonce ${tx.nonce} (current nonce ${input.currentNonce}) has ${tx.confirmations} of ${tx.required} confirmations`,
      }),
    )
  }

  return {
    section: {
      approvedHashes,
      signedMessages,
      queued,
      messages: [...(input.messages ?? [])],
      delegates: [...(input.delegates ?? [])],
      sources: [...input.sources],
    },
    findings,
  }
}
