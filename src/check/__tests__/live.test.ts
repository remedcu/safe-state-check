// @vitest-environment node
// Live regression against public Ethereum RPCs (read-only), through startCheck with the default RPCs and the generated
// registry. Runs only with LIVE=1: `LIVE=1 npx vitest run live`.
import { describe, expect, it } from "vitest"
import { FIXTURES } from "@/core/__tests__/fixtures/appendixB"
import type { CheckEvent, Report } from "@/core/report"
import reviewedFile from "@/data/reviewed-contracts.json"
import { signedOff } from "@/data/reviewed"
import { defaultSettings } from "@/data/settings"
import type { ReviewedContract } from "@/data/types"
import { startCheck } from "@/check/start"
import { B1_SAFE, B3_SAFE } from "@/check/__tests__/fakeDeps"

const BLOCK = "26176126"
const SAFEDAO_GNOSIS = "0x9D02bed59170cdE96782Ea9a9b17F9bCF4916127" as const
// A reviewed-list entry counts only once signed off; until then its module is an unknown module (High).
const SIGNED = signedOff(reviewedFile as ReviewedContract[]).map((entry) => entry.address.toLowerCase())
const VETO_ETHEREUM = "0x4210382652a5e3c9af7e1d3c88085818a465449b"
const VETO_GNOSIS = "0xe62320c8f29cea47587b2239476841430e17af75"

async function liveCheck(
  address: `0x${string}`,
  chainId = 1,
  block: string | null = BLOCK,
): Promise<{ report: Report | null; events: CheckEvent[] }> {
  const events: CheckEvent[] = []
  const report = await startCheck({ address, chainId, block }, defaultSettings(), (event) => events.push(event))
  return { report, events }
}

describe.skipIf(!import.meta.env.LIVE)("live, Ethereum block 26176126", () => {
  it("gives Storage fully explained for the Reward Distribution Safe, with the veto module as reviewed or unknown", async () => {
    const { report, events } = await liveCheck(B1_SAFE)
    if (report === null) throw new Error(JSON.stringify(events.at(-1)))
    const signed = SIGNED.includes(VETO_ETHEREUM)

    expect(report.storage).toMatchObject({ data: { actualRoot: FIXTURES[0].root, matchedBy: "config" } })
    expect(report.verdict.kind).toBe("explained")
    expect(report.findings.map((f) => f.code)).toEqual([
      ...(signed ? [] : ["unknown-module"]),
      "delegated-owner",
      "version-behind",
    ])
    expect(report.modules).toMatchObject({
      data: {
        modules: [
          { identification: { status: signed ? "reviewed" : "unknown" } },
          { identification: { status: "known" } },
        ],
      },
    })
  }, 180_000)

  it("gives the SEF Safe's root", async () => {
    const { report, events } = await liveCheck(B3_SAFE)
    if (report === null) throw new Error(JSON.stringify(events.at(-1)))

    expect(report.storage).toMatchObject({ data: { actualRoot: FIXTURES[4].root, matchedBy: "config" } })
    expect(report.identity).toMatchObject({ data: { version: "1.5.0", supported: true } })
    expect(report.findings).toEqual([])
    expect(report.verdict.kind).toBe("explained")
  }, 180_000)
})

describe.skipIf(!import.meta.env.LIVE)("live, Gnosis SafeDAO Safe with Blockscout history", () => {
  it("reads the event history and identifies the reviewed veto and the Reality module", async () => {
    // Pinned at latest - 3 (the B4 fixture block is now outside the Gnosis proof window).
    const { report, events } = await liveCheck(SAFEDAO_GNOSIS, 100, null)
    if (report === null) throw new Error(JSON.stringify(events.at(-1)))

    expect(report.storage).toMatchObject({ data: { support: "supported", matchedBy: "config" } })
    expect(report.verdict.kind).toBe("explained")
    if (report.history.state !== "complete" && report.history.state !== "partial") throw new Error("no history")
    expect(report.history.data.configEvents.length).toBeGreaterThan(0)
    // The history replay must match the current config: no "set without event".
    expect(report.findings.map((f) => f.code)).not.toContain("config-without-event")
    if (report.modules.state !== "complete") throw new Error("modules")
    const statuses = report.modules.data.modules.map((m) => m.identification?.status)
    expect(statuses).toContain(SIGNED.includes(VETO_GNOSIS) ? "reviewed" : "unknown")
    expect(statuses).toContain("known")
  }, 180_000)
})
