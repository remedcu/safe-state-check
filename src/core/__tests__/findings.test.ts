import { describe, expect, it } from "vitest"
import { FINDINGS, finding, sortFindings, UNVERIFIED_REASONS } from "@/core/findings"
import type { FindingCode, Severity } from "@/core/report"

// docs/ARCHITECTURE.md section 11, copied as written, plus the codes added after it.
const TABLE: Record<Severity, FindingCode[]> = {
  critical: [
    "shadow-owner",
    "shadow-module",
    "eoa-module",
    "module-public-forwarder",
    "approval-without-event",
    "signed-message-without-event",
    "singleton-not-canonical",
    "proxy-not-canonical",
  ],
  high: [
    "unexplained-storage",
    "unknown-module",
    "unknown-fallback-handler",
    "setup-delegatecall-unknown",
    "config-without-event",
    "module-owner-not-safe",
    "list-corrupt",
    "getter-mismatch",
    "owner-count-mismatch",
    "threshold-invalid",
    "slot6-unexpected",
    "codehash-mismatch",
  ],
  medium: [
    "unknown-guard",
    "unknown-module-guard",
    "delegated-owner",
    "contract-owner",
    "pending-approved-hash",
    "queued-transaction",
    "factory-not-canonical",
    "creation-callback-unknown",
    "faulty-version",
    "config-without-event-unconfirmed",
  ],
  info: [
    "setup-payment",
    "version-behind",
    "inert-owners",
    "legacy-domain-separator",
    "passkey-signer-slots",
    "signed-message",
    "handler-keeps-own-state",
    "history-incomplete",
    "same-address-other-chains",
  ],
}

const EM_DASH = String.fromCharCode(0x2014)

describe("FINDINGS", () => {
  it("gives every code the severity of the design table", () => {
    const fromTable = Object.entries(TABLE).flatMap(([severity, codes]) => codes.map((code) => [code, severity]))

    expect(Object.fromEntries(fromTable)).toEqual(
      Object.fromEntries(Object.entries(FINDINGS).map(([code, entry]) => [code, entry.severity])),
    )
  })

  it("has plain text for every code, without em dashes", () => {
    for (const { title, explanation } of Object.values(FINDINGS)) {
      expect(title.length).toBeGreaterThan(5)
      expect(explanation.length).toBeGreaterThan(20)
      expect(`${title}${explanation}`).not.toContain(EM_DASH)
    }
    for (const text of Object.values(UNVERIFIED_REASONS)) expect(text).not.toContain(EM_DASH)
  })
})

describe("finding", () => {
  it("takes severity, title and explanation from the catalogue", () => {
    const item = finding("eoa-module", "modules", {
      subject: "0x0000000000000000000000000000000000000abc",
      technical: "t",
    })

    expect(item).toEqual({
      code: "eoa-module",
      severity: "critical",
      title: FINDINGS["eoa-module"].title,
      technical: "t",
      explanation: FINDINGS["eoa-module"].explanation,
      subject: "0x0000000000000000000000000000000000000abc",
      section: "modules",
      evidence: [],
    })
  })
})

describe("sortFindings", () => {
  it("puts the most severe first and keeps the order within a severity", () => {
    const items = [
      finding("version-behind", "identity", { technical: "a" }),
      finding("unknown-module", "modules", { technical: "b" }),
      finding("eoa-module", "modules", { technical: "c" }),
      finding("unknown-fallback-handler", "handlers", { technical: "d" }),
    ]

    expect(sortFindings(items).map((item) => item.technical)).toEqual(["c", "b", "d", "a"])
  })
})
