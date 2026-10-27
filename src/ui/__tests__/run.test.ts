import { describe, expect, it } from "vitest"
import type { CheckEvent, SectionKey } from "@/core/report"
import { restartStreamFor, stoppedStream, streamFor } from "@/ui/__fixtures__/events"
import { pipelineGreen, pipelineShadowOwner } from "@/ui/__fixtures__/pipeline"
import { greenReport, issue, redShadowOwnerReport } from "@/ui/__fixtures__/reports"
import { reportToMarkdown } from "@/core/markdown"
import { TOOL } from "@/check/run"
import {
  droppedRpcLines,
  type LiveRun,
  partialReport,
  reduceFlow,
  reduceRun,
  SECTION_ORDER,
  shownSections,
  startRun,
} from "@/ui/run"

function play(events: CheckEvent[]): LiveRun[] {
  const states: LiveRun[] = []
  let run = startRun(greenReport.request)
  for (const event of events) {
    run = reduceRun(run, event)
    states.push(run)
  }
  return states
}

describe("reduceRun", () => {
  it("ends with the finished report", () => {
    const states = play(streamFor(greenReport).map((t) => t.event))
    const last = states.at(-1)!

    expect(last.status).toBe("finished")
    expect(last.report).toBe(greenReport)
    expect(last.steps).toEqual(greenReport.steps)
  })

  it("collects sections, findings and issues while the run streams", () => {
    const events = streamFor(greenReport).map((t) => t.event)
    const beforeFinish = play(events.slice(0, -1)).at(-1)!

    expect(beforeFinish.status).toBe("running")
    expect(beforeFinish.sections.owners).toEqual(greenReport.owners)
    expect(beforeFinish.findings).toEqual(expect.arrayContaining(greenReport.findings))
    expect(beforeFinish.issues).toEqual(greenReport.issues)
  })

  it("clears the partial report on a restart and keeps the issues", () => {
    const events = restartStreamFor(greenReport).map((t) => t.event)
    const restartAt = events.findIndex((e) => e.type === "restarted")
    const before = play(events.slice(0, restartAt)).at(-1)!
    const after = play(events.slice(0, restartAt + 1)).at(-1)!

    expect(Object.keys(before.sections).length).toBeGreaterThan(0)
    expect(after.sections).toEqual({})
    expect(after.findings).toEqual([])
    expect(after.steps.every((s) => s.status === "pending")).toBe(true)
    expect(after.issues).toEqual(before.issues)
    expect(after.restarts).toEqual(["Block 26176126 changed while the check ran (a reorg)."])
  })

  it("records why a run stopped and adds the stop's issues once", () => {
    const extra = issue("unreachable")
    let run = reduceRun(startRun(greenReport.request), { type: "issue", issue: extra })
    run = reduceRun(run, { type: "stopped", reason: "no-rpc", message: "No RPC answered.", issues: [extra] })

    expect(run.status).toBe("stopped")
    expect(run.stop).toEqual({ reason: "no-rpc", message: "No RPC answered." })
    expect(run.issues).toEqual([extra])
  })

  it("stops on the not-deployed stream", () => {
    const last = play(stoppedStream().map((t) => t.event)).at(-1)!

    expect(last.stop?.reason).toBe("not-deployed")
    expect(last.steps.find((s) => s.id === "identity")?.status).toBe("failed")
  })
})

describe("shownSections", () => {
  // The streaming view must never move what is already on screen: sections appear in display order, only at the end
  // of the list, and a shown section's content never changes until the final report.
  for (const report of [greenReport, redShadowOwnerReport]) {
    it(`only appends final sections while the ${report.verdict.kind} run streams`, () => {
      const states = play(streamFor(report).map((t) => t.event))
      let shown: SectionKey[] = []
      const firstSeen = new Map<SectionKey, unknown>()
      for (const state of states.slice(0, -1)) {
        const now = shownSections(state)
        expect(now).toEqual(SECTION_ORDER.slice(0, now.length))
        expect(now.slice(0, shown.length)).toEqual(shown)
        for (const key of now) {
          if (!firstSeen.has(key)) firstSeen.set(key, state.sections[key])
          expect(state.sections[key]).toBe(firstSeen.get(key))
        }
        shown = now
      }
      // Owners and modules show before the end; verification only with the report.
      expect(shown).toEqual(expect.arrayContaining(["identity", "owners", "modules"]))
      expect(shown).not.toContain("verification")
      expect(shownSections(states.at(-1)!)).toEqual([...SECTION_ORDER])
    })
  }

  // The real pipeline's event order, not only the hand-made streams: owners and modules appear early, verification last.
  for (const [name, run] of [
    ["green", pipelineGreen],
    ["shadow owner", pipelineShadowOwner],
  ] as const) {
    it(`only appends final sections while the pipeline's ${name} run streams`, async () => {
      const { events } = await run()
      const states = play(events)
      let shown: SectionKey[] = []
      for (const state of states.slice(0, -1)) {
        const now = shownSections(state)
        expect(now).toEqual(SECTION_ORDER.slice(0, now.length))
        expect(now.slice(0, shown.length)).toEqual(shown)
        shown = now
      }
      expect(shown).not.toContain("verification")
      expect(states.at(-1)?.status).toBe("finished")
    })
  }

  it("holds back the storage table until the event pass and diagnosis are done", () => {
    const events = streamFor(redShadowOwnerReport).map((t) => t.event)
    const historyDone = events.findIndex(
      (e) => e.type === "step" && e.step.id === "history" && e.step.status === "done",
    )
    const state = play(events.slice(0, historyDone + 1)).at(-1)!

    // Pass 1 is in, and everything above storage is final, but the event pass can still add slots.
    expect(state.sections.storage).toMatchObject({ data: { passes: [{ by: "config", match: false }] } })
    expect(shownSections(state)).toEqual(["identity", "owners", "modules", "handlers"])
  })
})

describe("partialReport and droppedRpcLines", () => {
  it("turns a stopped run into a labelled partial report, unread parts marked", async () => {
    const { events } = await pipelineGreen()
    const cut = events.findIndex((e) => e.type === "step" && e.step.id === "owners" && e.step.status === "done")
    let run = startRun(greenReport.request)
    for (const event of events.slice(0, cut + 1)) run = reduceRun(run, event)
    run = reduceRun(run, { type: "stopped", reason: "cancelled", message: "You stopped it.", issues: [] })
    const partial = partialReport(run, TOOL)!

    expect(partial.verdict).toMatchObject({
      kind: "unverified",
      headline: expect.stringMatching(/^Stopped: partial result\./),
    })
    expect(partial.owners.state).toBe("complete")
    expect(partial.history).toEqual({ state: "skipped", reason: "Not read: the check was stopped first." })
    expect(partial.steps.some((s) => s.status === "running" || s.status === "pending")).toBe(false)
    expect(reportToMarkdown(partial, { partial: true }).split("\n")[0]).toBe(
      "# Safe State Check: Stopped: partial result",
    )
    expect(JSON.parse(JSON.stringify(partial))).toEqual(partial)
  })

  it("gives no partial report for a stop that is not the user's, or before a block was pinned", () => {
    const stop = (reason: "cancelled" | "no-rpc") =>
      reduceRun(startRun(greenReport.request), { type: "stopped", reason, message: "", issues: [] })
    expect(partialReport(stop("cancelled"), TOOL)).toBeNull()
    expect(partialReport(stop("no-rpc"), TOOL)).toBeNull()
  })

  it("names a user RPC the run did not use, with the reason", () => {
    const report = { ...greenReport, issues: [issue("wrong-chain", { host: "rpc.gnosischain.com", recovered: true })] }
    const rpcs = { primary: "https://rpc.gnosischain.com/KEY", crossCheck: "https://eth.drpc.org", useDefaults: true }

    expect(droppedRpcLines(report, rpcs)).toEqual([
      `Your RPC rpc.gnosischain.com was not used: ${report.issues[0].title.replace(/\.$/, "")}.`,
    ])
    expect(droppedRpcLines(report, null)).toEqual([])
  })
})

describe("realDeps", () => {
  it("wires the pipeline's candidate test and other-chains look", async () => {
    const { realDeps } = await import("@/ui/realDeps")
    expect(realDeps.testCandidates).toBe((await import("@/check/candidates")).testCandidates)
    expect(realDeps.checkOtherChains).toBe((await import("@/check/otherChains")).checkOtherChains)
  })
})

describe("reduceFlow", () => {
  it("drops events of a run that a newer run replaced", () => {
    let flow = reduceFlow({ kind: "idle" }, { type: "run", id: 1, request: greenReport.request, chain: null })
    flow = reduceFlow(flow, { type: "run", id: 2, request: redShadowOwnerReport.request, chain: null })
    const stale = reduceFlow(flow, { type: "event", id: 1, event: { type: "finished", report: greenReport } })

    expect(stale).toBe(flow)
  })

  it("collects chain search results", () => {
    let flow = reduceFlow({ kind: "idle" }, { type: "detect", address: greenReport.request.address, scope: "popular" })
    const result = { chainId: 1, status: "safe" as const, singleton: null, version: "1.4.1", issue: null }
    flow = reduceFlow(flow, { type: "detected", result })

    expect(flow).toMatchObject({ kind: "detecting", detection: { results: [result], done: false } })
    flow = reduceFlow(flow, { type: "detect-done", results: [result] })
    expect(flow).toMatchObject({ detection: { done: true } })
  })

  it("keeps what the chain search found when it ends early, and says why", () => {
    let flow = reduceFlow({ kind: "idle" }, { type: "detect", address: greenReport.request.address, scope: "popular" })
    const result = { chainId: 1, status: "safe" as const, singleton: null, version: "1.4.1", issue: null }
    flow = reduceFlow(flow, { type: "detected", result })
    flow = reduceFlow(flow, { type: "detect-failed", message: "The registry could not load." })

    expect(flow).toMatchObject({
      kind: "detecting",
      detection: { results: [result], done: true, error: "The registry could not load." },
    })
  })

  it("turns a crash into a stopped run with the message", () => {
    let flow = reduceFlow({ kind: "idle" }, { type: "run", id: 3, request: greenReport.request, chain: null })
    flow = reduceFlow(flow, { type: "crashed", id: 3, message: "boom" })

    expect(flow).toMatchObject({
      kind: "run",
      run: { status: "stopped", stop: { reason: "crashed", message: "boom" } },
    })
  })
})
