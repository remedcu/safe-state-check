import type { Address, Hex } from "viem"
import { describe, expect, it } from "vitest"
import { FIXTURES } from "@/core/__tests__/fixtures/appendixB"
import { REGISTRY } from "@/core/__tests__/fixtures/registry"
import type { CheckEvent, Report } from "@/core/report"
import type { OpenSession, Settings } from "@/data/types"
import { runCheck } from "@/check/run"
import { parseCandidates, testCandidatesWith } from "@/check/candidates"
import { B1_OWNER, B1_SAFE, b1World, type FakeWorld, fakeDeps, ioError, withStorage } from "@/check/__tests__/fakeDeps"
import { approvedHashSlot, ownerSlot } from "@/core/slots"

const SETTINGS: Settings = {
  schema: 1,
  rpcs: {},
  safeTxService: { enabled: false, apiKey: null },
  etherscan: { apiKey: null },
}
const SHADOW: Address = "0x0000000000000000000000000000000000000002"
const NOW = () => new Date("2026-10-12T12:00:00.000Z")

async function firstReport(world: FakeWorld): Promise<Report> {
  const report = await runCheck({ address: B1_SAFE, chainId: 1, block: null }, fakeDeps(world).deps, () => {}, {
    registry: REGISTRY,
    now: NOW,
  })
  if (report === null) throw new Error("stopped")
  return report
}

function env(world: FakeWorld) {
  const openSession: OpenSession = async () => ({ ok: true, deps: fakeDeps(world).deps })
  return { openSession, registry: async () => REGISTRY, now: NOW }
}

describe("parseCandidates", () => {
  it("keeps addresses and 32-byte hashes, drops the rest", () => {
    const hash = "0x9b8d6c1a8f5dfcb5d6b5c1f0a9e0c8f6f2a4d3e1b7c9a5f3e2d1c0b9a8f7e6d5"

    expect(parseCandidates([B1_SAFE, hash, "hello", "0x1234"])).toEqual({
      addresses: [B1_SAFE],
      hashes: [hash],
    })
  })
})

describe("testCandidatesWith", () => {
  // B1 plus a shadow owner 0x...02 whose address appears nowhere, so the first run leaves it unexplained (red).
  const negWorld = (): FakeWorld => withStorage(b1World(), B1_SAFE, () => [...FIXTURES[1].entries])

  it("names the shadow owner once the user pastes its address", async () => {
    const report = await firstReport(negWorld())
    expect(report.verdict.kind).toBe("unexplained")

    const events: CheckEvent[] = []
    const updated = await testCandidatesWith(env(negWorld()), report, [SHADOW], SETTINGS, (e) => events.push(e))

    expect(updated.findings.map((f) => f.code)).toContain("shadow-owner")
    // The root now matches with the candidate, so the root-mismatch finding goes.
    expect(updated.findings.map((f) => f.code)).not.toContain("unexplained-storage")
    expect(updated.storage).toMatchObject({ data: { matchedBy: "candidates" } })
    expect(updated.findings.find((f) => f.code === "shadow-owner")?.subject?.toLowerCase()).toBe(SHADOW)
    expect(updated.verdict.kind).toBe("unexplained")
    expect(updated.verdict.counts.critical).toBe(1)
    expect(updated.diagnosis?.candidatesTried).toContain(SHADOW)
    expect(updated.diagnosis?.steps.find((s) => s.id === "candidates")?.status).toBe("explained")
    expect(events.at(-1)).toEqual({ type: "finished", report: updated })
  })

  it("leaves a clean Safe explained and tries nothing new", async () => {
    const report = await firstReport(b1World())
    const updated = await testCandidatesWith(env(b1World()), report, ["not an address"], SETTINGS, () => {})

    expect(updated.verdict.kind).toBe("explained")
    expect(updated.diagnosis?.candidatesTried).toEqual([])
  })

  it("leaves a clean Safe green when a pasted hash has no slot on it", async () => {
    const hash: Hex = "0x1111111111111111111111111111111111111111111111111111111111111111"
    // The user knows a hash; its slot is zero on this Safe, so it is benign (absent), not a shadow entry.
    const report = await firstReport(b1World())
    const updated = await testCandidatesWith(env(b1World()), report, [hash], SETTINGS, () => {})

    expect(updated.findings.map((f) => f.code)).not.toContain("unexplained-storage")
    expect(updated.verdict.kind).toBe("explained")
  })
})

describe("testCandidatesWith on an approval", () => {
  const H: Hex = "0x9b8d6c1a8f5dfcb5d6b5c1f0a9e0c8f6f2a4d3e1b7c9a5f3e2d1c0b9a8f7e6d5"
  // An approval written with no ApproveHash event; the RPC serves no enumeration or traces, so the first run is red.
  const planted = (): FakeWorld =>
    withStorage(b1World(), B1_SAFE, (entries) => [...entries, { slot: approvedHashSlot(B1_OWNER, H), value: 1n }])

  it("rates a pasted hash whose approval has no event as Critical, on a Safe that was red", async () => {
    const report = await firstReport(planted())
    expect(report.verdict.kind).toBe("unexplained")
    expect(report.findings.map((f) => f.code)).not.toContain("approval-without-event")

    const updated = await testCandidatesWith(env(planted()), report, [H], SETTINGS, () => {})

    expect(updated.findings.find((f) => f.code === "approval-without-event")?.severity).toBe("critical")
    expect(updated.findings.map((f) => f.code)).not.toContain("unexplained-storage")
    expect(updated.storage).toMatchObject({ data: { matchedBy: "candidates" } })
    expect(updated.verdict.kind).toBe("unexplained")
    expect(updated.diagnosis?.steps.find((s) => s.id === "candidates")?.detail).toBe(
      "Tested 0 addresses and 1 hash. The root matches with them.",
    )
  })

  it("rates a pasted hash as not verified, not Critical, when part of the history was not read", async () => {
    const partial = (): FakeWorld => ({ ...planted(), historyStop: { by: "time", at: 26000000n } })
    const report = await firstReport(partial())
    const updated = await testCandidatesWith(env(partial()), report, [H], SETTINGS, () => {})

    expect(updated.findings.map((f) => f.code)).not.toContain("approval-without-event")
    expect(updated.findings.map((f) => f.code)).toContain("pending-approved-hash")
    expect(updated.verdict.kind).toBe("unverified")
    expect(updated.verdict.unverified.map((u) => u.reason)).toEqual(["history-incomplete"])
  })

  it("accepts an approval the check saw an event for, but not as verified", async () => {
    const first = await firstReport(planted())
    if (first.pending.state !== "complete") throw new Error("pending")
    const entry = { owner: B1_OWNER, hash: H, slot: approvedHashSlot(B1_OWNER, H), nonce: null }
    const report: Report = {
      ...first,
      pending: { state: "complete", data: { ...first.pending.data, approvedHashes: [entry] } },
    }

    const updated = await testCandidatesWith(env(planted()), report, [H], SETTINGS, () => {})

    expect(updated.findings.map((f) => f.code)).not.toContain("approval-without-event")
    expect(updated.storage).toMatchObject({ state: "partial", data: { matchedBy: "candidates" } })
    expect(updated.verdict.kind).toBe("unverified")
  })

  it("keeps one candidates pass and each candidate once when tested twice", async () => {
    const report = await firstReport(planted())
    const once = await testCandidatesWith(env(planted()), report, [H], SETTINGS, () => {})
    const twice = await testCandidatesWith(env(planted()), once, [H], SETTINGS, () => {})

    if (twice.storage.state !== "complete") throw new Error("storage")
    expect(twice.storage.data.passes.filter((pass) => pass.by === "candidates")).toHaveLength(1)
    expect(twice.diagnosis?.candidatesTried).toEqual([H])
    expect(twice.findings.filter((f) => f.code === "approval-without-event")).toHaveLength(1)
  })
})

describe("testCandidatesWith on a real-shaped session (fixes from the anvil suite)", () => {
  // Diagnosis traced the shadow key but no trace named 0x...02, so the first report holds it as unexplained.
  const tracedWorld = (): FakeWorld => ({
    ...withStorage(b1World(), B1_SAFE, () => [...FIXTURES[1].entries]),
    creation: {
      lookup: { found: false, tried: [], issues: [] },
      diff: {
        [B1_SAFE]: {
          pre: {},
          post: { [ownerSlot(SHADOW)]: "0x0000000000000000000000000000000000000000000000000000000000000001" },
        },
      },
    },
  })

  it("names a slot diagnosis found but could not name, with no duplicate or stale finding", async () => {
    const report = await firstReport(tracedWorld())
    expect(report.findings.filter((f) => f.code === "unexplained-storage" && f.section === "diagnosis")).toHaveLength(1)

    const updated = await testCandidatesWith(env(tracedWorld()), report, [SHADOW], SETTINGS, () => {})

    expect(updated.findings.filter((f) => f.code === "shadow-owner")).toHaveLength(1)
    expect(updated.findings.map((f) => f.code)).not.toContain("unexplained-storage")
    expect(updated.storage).toMatchObject({ data: { matchedBy: "candidates" } })
    expect(updated.verdict.kind).toBe("unexplained")
  })

  it("keeps a found-but-unnamed slot when the candidates name something else", async () => {
    const report = await firstReport(tracedWorld())
    const unrelated = "0x00000000000000000000000000000000000000Ff"
    const updated = await testCandidatesWith(env(tracedWorld()), report, [unrelated], SETTINGS, () => {})

    if (updated.storage.state !== "complete") throw new Error("storage")
    // The slot is still in the rebuilt set, so the candidates pass matches; it stays unexplained, once.
    expect(updated.storage.data.passes.at(-1)).toMatchObject({ by: "candidates", match: true })
    expect(updated.storage.data.slots.some((row) => row.key === ownerSlot(SHADOW).toLowerCase())).toBe(true)
    expect(updated.findings.filter((f) => f.code === "unexplained-storage")).toHaveLength(1)
    expect(updated.verdict.kind).toBe("unexplained")
  })

  it("hands the stop signal to the session and returns the report unchanged once stopped", async () => {
    const report = await firstReport(b1World())
    const controller = new AbortController()
    let given: AbortSignal | undefined
    const openSession: OpenSession = async (_chainId, _settings, options) => {
      given = options?.signal
      controller.abort()
      return { ok: true, deps: fakeDeps(b1World()).deps }
    }
    const events: CheckEvent[] = []
    const env = { openSession, registry: async () => REGISTRY, now: NOW }
    const updated = await testCandidatesWith(env, report, [SHADOW], SETTINGS, (e) => events.push(e), controller.signal)

    expect(given).toBe(controller.signal)
    expect(updated).toBe(report)
    expect(events).toEqual([])
  })

  it("refuses when the report's block is no longer the chain's block at that height", async () => {
    const report = await firstReport(b1World())
    const moved: FakeWorld = { ...b1World(), anchor: { hash: `0x${"ab".repeat(32)}` } }
    const updated = await testCandidatesWith(env(moved), report, [SHADOW], SETTINGS, () => {})

    expect(updated.diagnosis?.steps.find((s) => s.id === "candidates")).toMatchObject({ status: "failed" })
    expect(updated.findings).toEqual(report.findings)
  })

  it("reports an RPC that cannot pin the block, in plain words", async () => {
    const report = await firstReport(b1World())
    const failing: FakeWorld = {
      ...b1World(),
      failures: { anchor: ioError("proof-window", { title: "Block too old for this RPC's proofs" }) },
    }
    const updated = await testCandidatesWith(env(failing), report, [SHADOW], SETTINGS, () => {})

    expect(updated.diagnosis?.steps.find((s) => s.id === "candidates")).toMatchObject({
      status: "failed",
      detail: "Primary RPC eth.drpc.org could not read the Safe: Block too old for this RPC's proofs.",
    })
    expect(updated.issues.map((i) => i.kind)).toContain("proof-window")
  })
})
