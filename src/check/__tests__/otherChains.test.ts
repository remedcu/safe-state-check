import { describe, expect, it } from "vitest"
import { B3 } from "@/core/__tests__/fixtures/appendixB"
import { ADDRESS, HASH, REGISTRY } from "@/core/__tests__/fixtures/registry"
import type { Report } from "@/core/report"
import type { DetectResult, OpenSession, Settings } from "@/data/types"
import { runCheck } from "@/check/run"
import { checkOtherChainsWith } from "@/check/otherChains"
import { account, B1_SAFE, b1World, type FakeWorld, fakeDeps, issue } from "@/check/__tests__/fakeDeps"

const SETTINGS: Settings = {
  schema: 1,
  rpcs: {},
  safeTxService: { enabled: false, apiKey: null },
  etherscan: { apiKey: null },
}
const NOW = () => new Date("2026-10-12T12:00:00.000Z")

async function firstReport(): Promise<Report> {
  const report = await runCheck({ address: B1_SAFE, chainId: 1, block: null }, fakeDeps(b1World()).deps, () => {}, {
    registry: REGISTRY,
    now: NOW,
  })
  if (report === null) throw new Error("stopped")
  return report
}

const result = (chainId: number, status: DetectResult["status"]): DetectResult => ({
  chainId,
  status,
  singleton: null,
  version: null,
  issue: status === "error" ? issue("timeout") : null,
})

// The same address holds this Safe on chain 100, a Safe with other owners (B3's) on chain 137, and other things
// elsewhere.
const WORLDS: Record<number, FakeWorld> = {
  100: b1World(),
  137: account(account(b1World(), B1_SAFE, { codeHash: HASH.proxy150, storage: B3 }), ADDRESS.safe150, {
    codeHash: HASH.safe150,
  }),
}

function env(results: DetectResult[]) {
  const asked: number[] = []
  const openSession: OpenSession = async (chainId) => {
    asked.push(chainId)
    return { ok: true, deps: fakeDeps(WORLDS[chainId]).deps }
  }
  return { asked, env: { openSession, registry: async () => REGISTRY, now: NOW, detectChains: async () => results } }
}

describe("checkOtherChainsWith", () => {
  it("compares owners and threshold where the address is a Safe, and lists the rest", async () => {
    const report = await firstReport()
    const { asked, env: deps } = env([
      result(1, "safe"),
      result(10, "empty"),
      result(137, "safe"),
      result(8453, "error"),
      result(56, "contract"),
      result(100, "safe"),
    ])
    const updated = await checkOtherChainsWith(deps, report, SETTINGS)

    expect(asked.sort()).toEqual([100, 137])
    expect(updated.crossChain).toMatchObject({ state: "partial" })
    if (updated.crossChain?.state !== "partial") throw new Error("crossChain")
    expect(
      updated.crossChain.data.chains.map((row) => [row.chainId, row.status, row.ownersMatch, row.thresholdMatch]),
    ).toEqual([
      [137, "safe", false, false],
      [100, "safe", true, true],
      [56, "contract", null, null],
      [8453, "error", null, null],
      [10, "empty", null, null],
    ])
    const found = updated.findings.filter((f) => f.code === "same-address-other-chains")
    expect(found).toHaveLength(1)
    expect(found[0].technical).toContain("Other owners or threshold on")
    expect(updated.verdict.counts.info).toBe(report.verdict.counts.info + 1)
  })

  it("adds no finding when no other chain has code, and replaces an earlier look", async () => {
    const report = await firstReport()
    const once = await checkOtherChainsWith(env([result(100, "safe")]).env, report, SETTINGS)
    const again = await checkOtherChainsWith(env([result(10, "empty")]).env, once, SETTINGS)

    expect(again.findings.map((f) => f.code)).not.toContain("same-address-other-chains")
    expect(again.crossChain).toEqual({
      state: "complete",
      data: { chains: [expect.objectContaining({ chainId: 10, status: "empty" })] },
    })
  })
})

describe("checkOtherChainsWith when stopped", () => {
  it("returns the report unchanged", async () => {
    const report = await firstReport()
    const controller = new AbortController()
    const openSession: OpenSession = async (chainId) => {
      controller.abort()
      return { ok: true, deps: fakeDeps(WORLDS[chainId]).deps }
    }
    const deps = {
      openSession,
      registry: async () => REGISTRY,
      now: NOW,
      detectChains: async () => [result(100, "safe")],
    }

    expect(await checkOtherChainsWith(deps, report, SETTINGS, controller.signal)).toBe(report)
  })
})
