import type { Address, Hex } from "viem"
import { describe, expect, it } from "vitest"
import { SENTINEL } from "@/core/constants"
import { diagnose, type DiagnosisContext, slotIndex } from "@/core/diagnosis"
import { approvedHashSlot, moduleSlot, ownerSlot, signedMessageSlot } from "@/core/slots"

const OWNER: Address = "0x802cbafa6133c493A7c67f685f97AdA5918d1dF9"
const SHADOW: Address = "0x0000000000000000000000000000000000000002"
const MODULE: Address = "0x4210382652A5e3C9aF7e1D3c88085818A465449b"
const HASH: Hex = "0x9b8d6c1a8f5dfcb5d6b5c1f0a9e0c8f6f2a4d3e1b7c9a5f3e2d1c0b9a8f7e6d5"

function ctx(overrides: Partial<DiagnosisContext> = {}): DiagnosisContext {
  return {
    owners: [OWNER],
    modules: [MODULE],
    addresses: [OWNER, SHADOW, MODULE],
    hashes: [HASH],
    source: "enumeration",
    approvals: [],
    messages: [],
    historyRange: null,
    executed: new Set(),
    ...overrides,
  }
}

describe("slotIndex", () => {
  it("covers the owner, module, approved hash and signed message forms for every address and hash", () => {
    const index = slotIndex([OWNER], [HASH])

    expect(index.get(ownerSlot(OWNER).toLowerCase() as Hex)).toEqual({ kind: "owner", address: OWNER })
    expect(index.get(moduleSlot(SENTINEL).toLowerCase() as Hex)).toEqual({ kind: "module", address: SENTINEL })
    expect(index.get(signedMessageSlot(HASH).toLowerCase() as Hex)).toEqual({ kind: "signed-message", hash: HASH })
    expect(index.get(approvedHashSlot(OWNER, HASH).toLowerCase() as Hex)).toEqual({
      kind: "approved-hash",
      owner: OWNER,
      hash: HASH,
    })
  })
})

describe("diagnose", () => {
  it("classifies a shadow owner and a shadow module as Critical", () => {
    const { rows, findings } = diagnose(
      [
        { key: ownerSlot(SHADOW), value: 1n },
        { key: moduleSlot(SHADOW), value: 1n },
      ],
      ctx({ addresses: [OWNER, SHADOW, MODULE] }),
    )

    expect(findings.map((f) => [f.code, f.severity, f.subject])).toEqual([
      ["shadow-owner", "critical", SHADOW],
      ["shadow-module", "critical", SHADOW],
    ])
    expect(rows.map((r) => r.status)).toEqual(["suspicious", "suspicious"])
  })

  it("treats an in-list owner or module entry as expected, not a shadow entry", () => {
    const { findings } = diagnose(
      [
        { key: ownerSlot(OWNER), value: 1n },
        { key: moduleSlot(MODULE), value: 1n },
        { key: moduleSlot(SENTINEL), value: 1n },
      ],
      ctx(),
    )

    expect(findings).toEqual([])
  })

  const APPROVAL_AND_MESSAGE = [
    { key: approvedHashSlot(OWNER, HASH), value: 1n },
    { key: signedMessageSlot(HASH), value: 1n },
  ]

  it("classifies an approved hash and a signed message as benign when their own events exist", () => {
    const { rows, findings, unconfirmed } = diagnose(
      APPROVAL_AND_MESSAGE,
      ctx({ approvals: [{ owner: OWNER, hash: HASH, confirmed: true }], messages: [{ hash: HASH, confirmed: true }] }),
    )

    expect(findings).toEqual([])
    expect(rows.map((r) => r.status)).toEqual(["benign", "benign"])
    expect(unconfirmed).toEqual([])
  })

  it("names the slots whose events no second RPC confirmed", () => {
    const { findings, unconfirmed } = diagnose(
      APPROVAL_AND_MESSAGE,
      ctx({
        approvals: [{ owner: OWNER, hash: HASH, confirmed: false }],
        messages: [{ hash: HASH, confirmed: false }],
      }),
    )

    expect(findings).toEqual([])
    expect(unconfirmed).toEqual([approvedHashSlot(OWNER, HASH), signedMessageSlot(HASH)])
  })

  it("rates an approval or signed message with no event of its own as Critical", () => {
    // The approval's event names another owner, as a planted ApproveHash log can.
    const { rows, findings } = diagnose(
      APPROVAL_AND_MESSAGE,
      ctx({ approvals: [{ owner: SHADOW, hash: HASH, confirmed: true }] }),
    )

    expect(findings.map((f) => [f.code, f.severity, f.subject])).toEqual([
      ["approval-without-event", "critical", HASH],
      ["signed-message-without-event", "critical", HASH],
    ])
    expect(rows.map((r) => r.status)).toEqual(["suspicious", "suspicious"])
  })

  it("with part of the history unread, marks such a slot instead of rating it Critical", () => {
    const range = { from: "100", to: "200" }
    const { rows, findings } = diagnose(APPROVAL_AND_MESSAGE, ctx({ historyRange: range }))

    expect(rows.map((r) => [r.status, r.eventNotRead])).toEqual([
      ["benign", true],
      ["benign", true],
    ])
    expect(findings.map((f) => [f.code, f.severity])).toEqual([
      ["pending-approved-hash", "medium"],
      ["signed-message", "info"],
    ])
    expect(findings[0].technical).toContain(
      "was not found in blocks 100 to 200, the part of the event history that was read",
    )
  })

  it("lists no pending approval when a read ExecutionSuccess ran it", () => {
    const { findings } = diagnose(
      [{ key: approvedHashSlot(OWNER, HASH), value: 1n }],
      ctx({ historyRange: "none", executed: new Set([HASH.toLowerCase()]) }),
    )

    expect(findings).toEqual([])
  })

  it("leaves a key that matches nothing as unexplained storage", () => {
    const key = "0xdeadbeef00000000000000000000000000000000000000000000000000000000" as Hex
    const { rows, findings } = diagnose([{ key, value: 7n }], ctx())

    expect(findings.map((f) => f.code)).toEqual(["unexplained-storage"])
    expect(rows[0].status).toBe("unexplained")
  })

  it("skips zero values", () => {
    expect(diagnose([{ key: ownerSlot(SHADOW), value: 0n }], ctx()).findings).toEqual([])
  })
})
