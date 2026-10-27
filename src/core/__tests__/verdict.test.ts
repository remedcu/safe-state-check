import type { Address } from "viem"
import { describe, expect, it } from "vitest"
import { HASH, REGISTRY } from "@/core/__tests__/fixtures/registry"
import { finding } from "@/core/findings"
import { identify } from "@/core/registry"
import type { Finding, StorageSection, StepRecord, UnverifiedReason, VerificationSection } from "@/core/report"
import {
  decideVerdict,
  summaryCards,
  unverifiedReasons,
  type VerdictInput,
  verificationNotChecked,
} from "@/core/verdict"

const ROOT = "0x4321ab747900a628bc24642a1cff166280215c287be657997cff8468934b693e"
const OTHER_ROOT = "0x7fbd1922de71c80aabaac95fcf30df7cfdc3359e159b9c7ed6979920e18983f3"
const SAFE = "0xAd219b3c26fe42BF5FC66F67490745a4fa5dff59"

const STORAGE: StorageSection = {
  support: "supported",
  supportReason: "",
  actualRoot: ROOT,
  formula: { total: 1, parts: [{ label: "singleton", count: 1 }], text: "Expected non-zero slots: 1 = 1 singleton." },
  passes: [{ by: "config", slotCount: 1, expectedRoot: ROOT, match: true }],
  matchedBy: "config",
  slots: [
    {
      key: "0x0000000000000000000000000000000000000000000000000000000000000005",
      value: "0x0000000000000000000000000000000000000000000000000000000000000003",
      meaning: "Transaction counter",
      technical: "nonce (slot 5)",
      source: "config",
      status: "expected",
      proven: true,
      cross: "match",
    },
  ],
}

const VERIFICATION: VerificationSection = {
  anchor: {
    number: "26176126",
    hash: "0xbca7f5c0cd31c75f3e3221c076713002cf9952022b18060c16f4eeedf35ea119",
    stateRoot: "0x076e2e1a0629ea82b1069570b7426e70d1d2e9011c1674b882b4c02c10c40fe7",
    timestamp: "2026-10-12T00:00:00.000Z",
    pinnedBy: "offset",
    note: "",
  },
  primary: {
    host: "eth.drpc.org",
    operator: "drpc",
    operatorName: "dRPC",
    origin: "default",
    aggregator: true,
    clientVersion: null,
  },
  crossCheck: {
    host: "ethereum-rpc.publicnode.com",
    operator: "publicnode",
    operatorName: "PublicNode",
    origin: "default",
    aggregator: false,
    clientVersion: null,
  },
  crossCheckMissing: null,
  agreement: "agreed",
  coverage: { header: "match", storageRoot: "match", slotValues: "match", calls: "match" },
  proofs: { accounts: 5, slots: 20, allVerified: true, servedBy: ["eth.drpc.org"], blocks: ["26176126"] },
  reorg: "unchanged",
  capabilities: [],
}

function steps(failed: Partial<Record<string, string>> = {}): StepRecord[] {
  return ["anchor", "identity", "config", "storage", "reorg"].map((id) => ({
    id: id as StepRecord["id"],
    label: id,
    status: id in failed ? "failed" : "done",
    note: failed[id] ?? null,
    startedAt: null,
    finishedAt: null,
  }))
}

// The event history from block `from` to `to`, read in full unless `complete` is false.
function history(from: string, to: string, complete = true): VerdictInput["history"] {
  return {
    state: complete ? "complete" : "partial",
    data: {
      source: { service: "rpc", host: "eth.drpc.org" },
      fromBlock: from,
      toBlock: to,
      complete,
      configEvents: [],
      executions: { success: 0, failure: 0, moduleSuccess: 0, moduleFailure: 0, recent: [] },
      rebuilt: {
        singleton: null,
        owners: [],
        threshold: null,
        modules: [],
        guard: null,
        moduleGuard: null,
        fallbackHandler: null,
      },
      differences: [],
    },
    gaps: complete ? undefined : ["The history read stopped at its time limit."],
  } as VerdictInput["history"]
}

function input(overrides: Partial<VerdictInput> = {}): VerdictInput {
  return {
    history: history("0", "26176126"),
    creation: { state: "skipped", reason: "" },
    chain: { chainId: 1, name: "Ethereum", shortName: "eth", explorerAddressUrl: null, rootCheck: "supported" },
    findings: [],
    identity: {
      state: "complete",
      data: {
        proxy: {
          codeHash: HASH.proxy141,
          identification: identify(REGISTRY, 1, { address: SAFE, codeHash: HASH.proxy141 }),
        },
        singleton: { address: SAFE, codeHash: HASH.safe141, identification: null },
        version: "1.4.1",
        l2: false,
        versionCall: "1.4.1",
        supported: true,
        latestVersion: "1.5.0",
      },
    },
    owners: { state: "skipped", reason: "" },
    modules: { state: "skipped", reason: "" },
    handlers: { state: "skipped", reason: "" },
    storage: { state: "complete", data: STORAGE },
    verification: VERIFICATION,
    steps: steps(),
    issues: [],
    ...overrides,
  }
}

const ISSUE = { ...({} as VerdictInput["issues"][number]), title: "t", explanation: "e" }

const failedStep = (id: StepRecord["id"]): StepRecord => ({ ...steps()[0], id, status: "failed", note: `${id} failed` })

const reasons = (overrides: Partial<VerdictInput>) => unverifiedReasons(input(overrides)).map((item) => item.reason)

const MISMATCH: StorageSection = {
  ...STORAGE,
  passes: [{ by: "config", slotCount: 1, expectedRoot: OTHER_ROOT, match: false }],
  matchedBy: null,
}

describe("decideVerdict", () => {
  it("is green when the root matched on a verified anchor", () => {
    const verdict = decideVerdict(input())

    expect(verdict).toMatchObject({ kind: "explained", matchedBy: "config", unverified: [] })
    expect(verdict.reasons).toEqual([
      "The storage root matches the root rebuilt from the owners, modules and settings.",
    ])
  })

  it("stays green over a Critical finding but counts it and lists it first among the findings", () => {
    const eoa = finding("eoa-module", "modules", { technical: "no code" })
    const verdict = decideVerdict(input({ findings: [finding("version-behind", "identity", { technical: "" }), eoa] }))

    expect(verdict.kind).toBe("explained")
    expect(verdict.counts).toEqual({ critical: 1, high: 0, medium: 0, info: 1 })
    expect(verdict.reasons[1]).toBe("Critical: Module is a plain account.")
    expect(verdict.reasons).toHaveLength(2)
  })

  it("is red on a verified mismatch", () => {
    const verdict = decideVerdict(
      input({
        storage: { state: "complete", data: MISMATCH },
        findings: [finding("unexplained-storage", "storage", { technical: "" })],
      }),
    )

    expect(verdict.kind).toBe("unexplained")
    expect(verdict.reasons).toEqual([
      "The storage root does not match any root rebuilt from the configuration, the event history or the slots diagnosis found.",
      "High: Storage the configuration does not explain.",
    ])
  })

  describe("on a red with part of the event history unread", () => {
    const red = { storage: { state: "complete" as const, data: MISMATCH } }
    const hint = (overrides: Partial<VerdictInput>) => decideVerdict(input({ ...red, ...overrides })).reasons[1]
    const all = (overrides: Partial<VerdictInput>) => decideVerdict(input({ ...red, ...overrides })).reasons.join(" ")

    it("says how far the history got and what settles it, right after the main reason", () => {
      expect(hint({ history: history("100", "200", false) })).toBe(
        'The event history could be read only for blocks 100 to 200, so an approval or signed message from outside that range may explain these slots. Paste its hash or the owner\'s address into "Test candidates", or use an RPC that serves the full history.',
      )
      expect(decideVerdict(input({ ...red, history: history("100", "200", false) })).kind).toBe("unexplained")
    })

    it("says so when no part of the history could be read", () => {
      expect(hint({ history: { state: "unavailable", reason: "x" } })).toMatch(/^The event history could not be read, /)
    })

    it("adds nothing when a hidden owner entry was found", () => {
      const findings = [finding("shadow-owner", "diagnosis", { technical: "" })]

      expect(all({ history: history("100", "200", false), findings })).not.toContain("Test candidates")
    })

    it("adds nothing when the whole range was read and only SafeSetup is missing", () => {
      expect(all({ history: history("0", "26176126", false) })).not.toContain("Test candidates")
    })
  })

  it("is red when a matched pass holds a suspicious slot", () => {
    const odd = { ...STORAGE, slots: [{ ...STORAGE.slots[0], status: "suspicious" as const }] }

    expect(decideVerdict(input({ storage: { state: "complete", data: odd } })).kind).toBe("unexplained")
  })

  // The user's own node, marked as trusted alone, can give green; it says so plainly.
  it("is green on a self-trusted RPC and says the check had no independent cross-check", () => {
    const own = { ...VERIFICATION, agreement: "self-trusted" as const, crossCheck: null }
    const verdict = decideVerdict(input({ verification: own }))

    expect(verdict.kind).toBe("explained")
    expect(verdict.reasons[1]).toBe(
      "Checked against your own RPC eth.drpc.org only. No independent operator cross-checked the block.",
    )
    expect(verificationNotChecked(own)).toHaveLength(1)
    expect(verificationNotChecked(own)[0]).toContain("your own RPC eth.drpc.org only")
    expect(verificationNotChecked(VERIFICATION)).toEqual([])
  })

  it("stays amber with a single operator that is not self-trusted", () => {
    const single = { ...VERIFICATION, agreement: "single-operator" as const, crossCheck: null }

    expect(decideVerdict(input({ verification: single })).kind).toBe("unverified")
  })

  // A lying RPC must not turn the banner red.
  it("puts unverified before unexplained", () => {
    const verdict = decideVerdict(
      input({
        storage: { state: "complete", data: MISMATCH },
        verification: { ...VERIFICATION, agreement: "single-operator", crossCheckMissing: "No second operator." },
      }),
    )

    expect(verdict.kind).toBe("unverified")
    expect(verdict.reasons).toEqual([
      "No second operator.",
      "The rebuilt storage root did not match, but the data behind it is not verified.",
    ])
  })
})

// Invariant 7: every unverified reason has a test that triggers it.
describe("unverifiedReasons", () => {
  const cases: [UnverifiedReason, Partial<VerdictInput>][] = [
    ["root-check-unsupported", { storage: { state: "complete", data: { ...STORAGE, support: "unsupported" } } }],
    [
      "root-check-unsupported",
      { storage: { state: "unavailable", reason: "x" }, chain: { ...input().chain, rootCheck: "unsupported" } },
    ],
    [
      "no-proof-rpc",
      {
        storage: { state: "complete", data: { ...STORAGE, support: "no-proof-rpc" } },
        chain: { ...input().chain, rootCheck: "no-proof-rpc" },
      },
    ],
    ["single-operator", { verification: { ...VERIFICATION, agreement: "single-operator" } }],
    ["rpc-disagreement", { verification: { ...VERIFICATION, agreement: "disagreed" } }],
    [
      "rpc-disagreement",
      { verification: { ...VERIFICATION, coverage: { ...VERIFICATION.coverage, slotValues: "mismatch" } } },
    ],
    ["proof-invalid", { verification: { ...VERIFICATION, proofs: { ...VERIFICATION.proofs, allVerified: false } } }],
    ["code-not-canonical", { findings: [finding("proxy-not-canonical", "identity", { technical: "" })] }],
    ["code-not-canonical", { findings: [finding("singleton-not-canonical", "identity", { technical: "" })] }],
    ["reorg", { steps: steps({ reorg: "changed again" }), verification: { ...VERIFICATION, reorg: "restarted" } }],
    ["read-failed", { steps: steps({ reorg: "no answer" }), verification: { ...VERIFICATION, reorg: "not-run" } }],
    ["read-failed", { steps: steps({ config: "RPC down" }) }],
    ["read-failed", { storage: { state: "partial", data: STORAGE, gaps: ["list changed"] } }],
    ["read-failed", { storage: { state: "unavailable", reason: "failed" } }],
    ["rpc-disagreement", { issues: [{ ...ISSUE, kind: "disagreement" }] }],
    [
      "read-failed",
      { storage: { state: "complete", data: MISMATCH }, steps: [...steps(), failedStep("storage-events")] },
    ],
    ["read-failed", { storage: { state: "complete", data: MISMATCH }, steps: [...steps(), failedStep("diagnosis")] }],
    [
      "inspection-incomplete",
      { modules: { state: "partial", data: { modules: [] }, gaps: ["Module 0x1 could not be inspected."] } },
    ],
    ["inspection-incomplete", { steps: [...steps(), { ...steps()[0], id: "handlers", status: "failed", note: "x" }] }],
  ]

  it.each(cases)("triggers %s", (reason, overrides) => {
    expect(reasons(overrides)).toEqual([reason])
    expect(decideVerdict(input(overrides)).kind).toBe("unverified")
  })

  it("ignores a failed event or diagnosis step once a pass matched", () => {
    expect(reasons({ steps: [...steps(), failedStep("storage-events"), failedStep("diagnosis")] })).toEqual([])
  })

  it("triggers history-incomplete for a slot whose approval event lies in the unread part of the history", () => {
    const row = {
      ...STORAGE.slots[0],
      source: "enumeration" as const,
      status: "benign" as const,
      eventNotRead: true as const,
    }
    const storage: VerdictInput["storage"] = { state: "complete", data: { ...STORAGE, slots: [...STORAGE.slots, row] } }
    const items = unverifiedReasons(input({ storage, history: history("100", "200", false) }))

    expect(items.map((item) => item.reason)).toEqual(["history-incomplete"])
    expect(items[0].detail).toBe(
      "One slot looks like an approval or signed message whose event was not found in blocks 100 to 200, the part of the event history that was read. An RPC that serves the full history settles it.",
    )
    expect(decideVerdict(input({ storage, history: history("100", "200", false) })).kind).toBe("unverified")
  })

  it("adds unproven-read when no RPC proved the block on a chain whose proofs work", () => {
    const storage: VerdictInput["storage"] = { state: "complete", data: { ...STORAGE, support: "no-proof-rpc" } }

    expect(reasons({ storage })).toEqual(["no-proof-rpc", "unproven-read"])
  })

  it("triggers version-unsupported for a known older singleton", () => {
    const identity = input().identity
    if (identity.state !== "complete") throw new Error("fixture")
    const old = { ...identity, data: { ...identity.data, version: "1.1.1", supported: false } }

    expect(reasons({ identity: old })).toEqual(["version-unsupported"])
  })

  it("blames the chain, not an RPC, for a proof that does not verify on a chain with non-standard proofs", () => {
    const proofs = { ...VERIFICATION.proofs, allVerified: false }
    const unsupported = {
      verification: { ...VERIFICATION, proofs },
      chain: { ...input().chain, rootCheck: "unsupported" as const },
      storage: { state: "complete" as const, data: { ...STORAGE, support: "unsupported" as const } },
    }

    expect(reasons(unsupported)).toEqual(["root-check-unsupported"])
  })

  it("names the host behind a proof that did not verify", () => {
    const issue = {
      ...({} as VerdictInput["issues"][number]),
      kind: "proof-invalid" as const,
      host: "bad.example",
    }

    expect(unverifiedReasons(input({ issues: [issue] }))[0].detail).toContain("bad.example")
  })
})

describe("summaryCards", () => {
  it("renders every card", () => {
    const cards = summaryCards(input())

    expect(cards.map((card) => card.id)).toEqual([
      "version",
      "owners",
      "modules",
      "guard",
      "moduleGuard",
      "fallbackHandler",
      "nonce",
      "storage",
    ])
    expect(cards.find((card) => card.id === "nonce")).toMatchObject({ value: "3", tone: "neutral" })
    expect(cards.find((card) => card.id === "storage")).toMatchObject({ value: "Root matches", tone: "ok" })
    expect(cards.find((card) => card.id === "owners")).toMatchObject({ value: "Not checked", tone: "unknown" })
  })

  it("shows a mismatch as bad", () => {
    const cards = summaryCards(input({ storage: { state: "complete", data: MISMATCH } }))

    expect(cards.find((card) => card.id === "storage")).toMatchObject({ value: "Root does not match", tone: "bad" })
  })

  it("counts a module that could not be inspected, and never shows that card as ok", () => {
    const row = { address: SAFE as Address, delegate: null, identification: null, zodiac: null, flags: [] }
    const modules: VerdictInput["modules"] = {
      state: "partial",
      data: {
        modules: [
          { ...row, kind: "unknown" },
          { ...row, kind: "eoa" },
        ],
      },
      gaps: ["x"],
    }
    const card = (findings: Finding[]) => summaryCards(input({ modules, findings })).find((c) => c.id === "modules")

    expect(card([])).toMatchObject({ value: "2", detail: "1 plain account, 1 not inspected", tone: "unknown" })
    expect(card([finding("eoa-module", "modules", { technical: "" })])).toMatchObject({ tone: "bad" })
  })

  it("gives a card the tone of its worst finding", () => {
    const findings: Finding[] = [finding("delegated-owner", "owners", { technical: "" })]
    const owners: VerdictInput["owners"] = {
      state: "complete",
      data: {
        owners: [{ address: SAFE, kind: "delegated-eoa", delegate: SAFE, identification: null, safe: null, flags: [] }],
        threshold: "1",
        ownerCount: "1",
        inertOnly: false,
      },
    }

    expect(summaryCards(input({ findings, owners })).find((card) => card.id === "owners")).toMatchObject({
      value: "1 of 1",
      detail: "1 delegated account",
      tone: "warn",
    })
  })
})
