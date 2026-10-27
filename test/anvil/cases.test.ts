// Every case of docs/SPEC.md 11.3 through startCheck against a fresh anvil, for Safe 1.3.0, 1.4.1 and 1.5.0. The user's
// own RPC is the anvil, marked as own node (trusted alone), defaults and the Transaction Service off. Other hosts are refused,
// so the suite runs offline; the hosts the pipeline tried are listed at the end.
import type { Address } from "viem"
import { afterAll, beforeAll, describe, expect, inject, it, vi } from "vitest"
import type { CheckEvent, Report } from "@/core/report"
import { defaultSettings } from "@/data/settings"
import type { Settings } from "@/data/types"
import { testCandidates } from "@/check/candidates"
import { startCheck } from "@/check/start"
import { type Case, CASES } from "./cases"
import { CHAIN_IDS, type Version } from "./safes"

const { urls, built } = inject("anvil")
const offline = new Set<string>()

function settingsFor(c: Case): Settings {
  const settings = defaultSettings()
  const ownNode = c.ownNode ?? true
  settings.rpcs[CHAIN_IDS[c.chain]] = { primary: urls[c.chain], crossCheck: null, useDefaults: false, ownNode }
  settings.safeTxService.enabled = false
  return settings
}

async function check(c: Case, safe: Address): Promise<Report> {
  const events: CheckEvent[] = []
  const request = { address: safe, chainId: CHAIN_IDS[c.chain], block: null }
  const report = await startCheck(request, settingsFor(c), (e) => events.push(e))
  if (report === null) throw new Error(`stopped: ${JSON.stringify(events.at(-1))}`)
  return report
}

// VERSION() answers through the proxy; the version itself comes from the singleton's code hash.
const versionOf = (c: Case, v: Version) => (c.codes.includes("singleton-not-canonical") ? null : v)
const expectedCodes = (c: Case, v: Version) =>
  [...c.codes, ...(versionOf(c, v) === null || v === "1.5.0" ? [] : ["version-behind"])].sort()
const codesOf = (report: Report) => report.findings.map((f) => f.code).sort()

function expectShadow(c: Case, report: Report) {
  const finding = report.findings.find((f) => f.code === c.codes.find((code) => code.startsWith("shadow-")))
  expect(finding?.subject?.toLowerCase()).toBe(c.shadow!.subject.toLowerCase())
  expect(finding?.evidence).toContainEqual(expect.objectContaining({ kind: "slot", key: c.shadow!.key }))
}

beforeAll(() => {
  const realFetch = globalThis.fetch
  vi.stubGlobal("fetch", (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : input)
    if (url.hostname === "127.0.0.1") return realFetch(input, init)
    offline.add(`${url.host}${url.pathname.replace(/0x[0-9a-fA-F]{40}/g, "<address>")}`)
    return Promise.reject(new TypeError("fetch failed: the anvil suite runs offline"))
  })
})

afterAll(() => {
  vi.unstubAllGlobals()
  console.log(`requests refused: ${[...offline].sort().join(", ") || "none"}`)
})

for (const c of CASES) {
  describe(c.name, () => {
    for (const v of c.versions) {
      it(`${v}: ${c.verdict}, ${expectedCodes(c, v).join(", ") || "no findings"}`, async () => {
        const { safe, proof } = built[`${c.name} ${v}`]
        if (c.proof) expect(proof).toContain(c.proof)

        const report = await check(c, safe)
        expect(report.identity).toMatchObject({ data: { versionCall: v, version: versionOf(c, v) } })
        expect(codesOf(report)).toEqual(expectedCodes(c, v))
        expect(report.verdict.kind).toBe(c.verdict)
        expect(report.verdict.unverified.map((u) => u.reason)).toEqual(c.unverified ?? [])
        expect(report.verification.agreement).toBe(c.ownNode === false ? "single-operator" : "self-trusted")
        if (c.matchedBy) expect(report.storage).toMatchObject({ data: { matchedBy: c.matchedBy } })
        if (c.events) {
          expect(report.history).toMatchObject({ state: "complete", data: { complete: true } })
          const history = report.history.state === "complete" ? report.history.data : null
          expect(history?.configEvents.map((e) => e.name).sort()).toEqual([...c.events].sort())
          // The replayed ChangedMasterCopy explains slot 0.
          if (c.events.includes("ChangedMasterCopy") && report.identity.state === "complete") {
            expect(history?.rebuilt.singleton).toBe(report.identity.data.singleton.address)
          }
        }
        if (c.shadow) {
          expectShadow(c, report)
          // anvil serves prestateTracer traces but not debug_storageRangeAt.
          expect(report.diagnosis?.steps).toContainEqual(
            expect.objectContaining({ id: "enumeration", status: "unavailable" }),
          )
          expect(report.diagnosis?.steps).toContainEqual(expect.objectContaining({ id: "traces", missing: [] }))
        }
      })
    }
  })
}

// docs/SPEC.md 5.11 step 4: the user pastes the address, and the tool proves and classifies its slots.
describe("user candidates", () => {
  for (const c of CASES.filter((c) => c.shadow)) {
    for (const v of c.versions) {
      it(`${c.name} ${v}: the pasted address classifies the slot`, async () => {
        const report = await check(c, built[`${c.name} ${v}`].safe)
        const updated = await testCandidates(report, [c.shadow!.subject], settingsFor(c), () => undefined)
        expect(codesOf(updated)).toEqual(expectedCodes(c, v))
        expect(updated.verdict.kind).toBe("unexplained")
        expect(updated.storage).toMatchObject({ data: { matchedBy: "candidates" } })
        expectShadow(c, updated)
      })
    }
  }
})
