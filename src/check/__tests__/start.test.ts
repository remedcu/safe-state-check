import { describe, expect, it, vi } from "vitest"
import { KNOWN_CONTRACTS, REVIEWED_CONTRACTS } from "@/core/__tests__/fixtures/registry"
import type { CheckEvent, Verdict } from "@/core/report"
import reviewedFile from "@/data/reviewed-contracts.json"
import { signedOff } from "@/data/reviewed"
import type { OpenSession, ReviewedContract, Settings } from "@/data/types"
import packageJson from "@/../package.json"
import { TOOL } from "@/check/run"
import { defaultRegistry, exitCode, registryLoader, startWith } from "@/check/start"
import { IssueLog } from "@/check/state"
import { B1_SAFE, b1World, fakeDeps, issue } from "@/check/__tests__/fakeDeps"

const SETTINGS: Settings = {
  schema: 1,
  rpcs: {},
  safeTxService: { enabled: false, apiKey: null },
  etherscan: { apiKey: null },
}
const REQUEST = { address: B1_SAFE, chainId: 1, block: null }

describe("registryLoader", () => {
  it("builds the index once", async () => {
    const load = vi.fn(async () => ({ known: { contracts: KNOWN_CONTRACTS }, reviewed: REVIEWED_CONTRACTS }))
    const registry = registryLoader(load)

    expect(await registry()).toBe(await registry())
    expect(load).toHaveBeenCalledTimes(1)
  })
})

describe("startWith", () => {
  const registry = registryLoader(async () => ({ known: { contracts: KNOWN_CONTRACTS }, reviewed: REVIEWED_CONTRACTS }))

  it("opens the session and runs the check, forwarding the session's issues", async () => {
    const openSession: OpenSession = async (_chainId, _settings, options) => {
      options?.onIssue?.(issue("rate-limited", { recovered: true }))
      return { ok: true, deps: fakeDeps(b1World()).deps }
    }
    const events: CheckEvent[] = []
    const report = await startWith({ openSession, registry }, REQUEST, SETTINGS, (e) => events.push(e))

    expect(report?.verdict.kind).toBe("explained")
    expect(report?.issues.map((i) => i.kind)).toEqual(["rate-limited"])
    expect(events.map((e) => e.type).indexOf("issue")).toBeGreaterThan(events.map((e) => e.type).indexOf("started"))
  })

  it("stops with the session's reason when there is no RPC", async () => {
    const openSession: OpenSession = async () => ({
      ok: false,
      reason: "no-rpc",
      message: "No RPC answered for Ethereum. Add your own RPC in the settings.",
      issues: [issue("unreachable")],
    })
    const events: CheckEvent[] = []

    expect(await startWith({ openSession, registry }, REQUEST, SETTINGS, (e) => events.push(e))).toBeNull()
    expect(events).toEqual([
      {
        type: "stopped",
        reason: "no-rpc",
        message: "No RPC answered for Ethereum. Add your own RPC in the settings.",
        issues: [expect.objectContaining({ kind: "unreachable" })],
      },
    ])
  })

  it("stops when cancelled while the session opens", async () => {
    const controller = new AbortController()
    const openSession: OpenSession = async () => {
      controller.abort()
      return { ok: true, deps: fakeDeps(b1World()).deps }
    }
    const events: CheckEvent[] = []

    expect(
      await startWith({ openSession, registry }, REQUEST, SETTINGS, (e) => events.push(e), controller.signal),
    ).toBeNull()
    expect(events).toEqual([expect.objectContaining({ type: "stopped", reason: "cancelled" })])
  })
})

describe("TOOL", () => {
  it("carries package.json's version", () => {
    expect(TOOL.version).toBe(packageJson.version)
  })
})

describe("exitCode", () => {
  const verdict = (kind: Verdict["kind"], critical = 0, high = 0): Verdict => ({
    kind,
    headline: "",
    reasons: [],
    unverified: [],
    matchedBy: null,
    counts: { critical, high, medium: 0, info: 0 },
  })

  it("is 0 only for green with no Critical or High finding", () => {
    expect(exitCode(verdict("explained"))).toBe(0)
    expect(exitCode(verdict("explained", 1))).toBe(1)
    expect(exitCode(verdict("explained", 0, 1))).toBe(1)
    expect(exitCode(verdict("unexplained"))).toBe(1)
    expect(exitCode(verdict("unverified", 1))).toBe(2)
  })
})

describe("IssueLog", () => {
  it("keeps one entry for the same problem logged twice as two objects", () => {
    const log = new IssueLog()
    log.add(issue("wrong-chain"))
    log.add(issue("wrong-chain"))
    log.add(issue("wrong-chain", { host: "other.example" }))

    expect(log.all.map((entry) => entry.host)).toEqual(["eth.drpc.org", "other.example"])
  })
})

describe("defaultRegistry", () => {
  it("counts only the signed-off entries of the reviewed list", async () => {
    const signed = new Set(signedOff(reviewedFile as ReviewedContract[]).map((entry) => entry.address.toLowerCase()))
    const registry = await defaultRegistry()

    expect(registry.reviewed.every(({ entry }) => signed.has(entry.address?.toLowerCase() ?? ""))).toBe(true)
  })
})
