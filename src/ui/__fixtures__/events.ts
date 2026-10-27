// Timed event streams built from the fixture reports, in the order src/check runs its steps: owners, modules, handlers
// and storage run in parallel after config and finish out of display order, so the streaming view has to cope.
import type { CheckEvent, Finding, Report, SectionKey, StepId, StepRecord } from "@/core/report"
import { stepRecords, stoppedNotDeployed } from "@/ui/__fixtures__/reports"

export type TimedEvent = { delayMs: number; event: CheckEvent }

type Phase = { start: StepId[]; finish: StepId[] }

const PHASES: Phase[] = [
  { start: ["anchor"], finish: ["anchor"] },
  { start: ["identity"], finish: ["identity"] },
  { start: ["config", "creation"], finish: ["config"] },
  { start: ["owners", "modules", "handlers", "storage"], finish: ["storage", "modules"] },
  { start: [], finish: ["creation", "owners"] },
  { start: ["history"], finish: ["handlers", "history"] },
  { start: ["pending", "storage-events"], finish: ["pending", "storage-events"] },
  { start: ["diagnosis"], finish: ["diagnosis"] },
  { start: ["reorg"], finish: ["reorg"] },
  { start: ["verdict"], finish: ["verdict"] },
]

// The sections each step sends when it finishes.
const SECTIONS: Partial<Record<StepId, SectionKey[]>> = {
  identity: ["identity"],
  storage: ["storage"],
  owners: ["owners"],
  modules: ["modules"],
  handlers: ["handlers"],
  creation: ["creation"],
  history: ["history"],
  pending: ["pending"],
  "storage-events": ["storage"],
  diagnosis: ["diagnosis"],
  reorg: ["verification"],
}

// The storage step sends pass 1 only (configuration slots); later passes come with the event pass and diagnosis.
function firstPass(storage: Report["storage"]): Report["storage"] {
  if (storage.state !== "complete" || storage.data.passes.length < 2) return storage
  const [pass] = storage.data.passes
  const slots = storage.data.slots.filter((slot) => slot.source === "config")
  return { ...storage, data: { ...storage.data, passes: [pass], matchedBy: pass.match ? pass.by : null, slots } }
}

function sectionEvent(report: Report, key: SectionKey, step: StepId): CheckEvent {
  const value = key === "storage" && step === "storage" ? firstPass(report.storage) : report[key]
  return { type: "section", patch: { key, value } as Extract<CheckEvent, { type: "section" }>["patch"] }
}

function runningSteps(report: Report): StepRecord[] {
  return report.steps.map((step) => ({ ...step, status: "running", note: null, finishedAt: null }))
}

// Every event a run of `report` sends, `delayMs` apart.
export function streamFor(report: Report, delayMs = 60): TimedEvent[] {
  const out: TimedEvent[] = []
  const push = (event: CheckEvent) => out.push({ delayMs, event })
  const final = new Map(report.steps.map((step) => [step.id, step]))
  const running = new Map(runningSteps(report).map((step) => [step.id, step]))
  const sent = new Set<Finding>()

  push({
    type: "started",
    at: report.createdAt,
    request: report.request,
    chain: report.chain,
    steps: report.steps.map((step) => ({ ...step, status: "pending", note: null, startedAt: null, finishedAt: null })),
  })
  for (const phase of PHASES) {
    for (const id of phase.start) {
      const step = running.get(id)
      if (step && final.get(id)?.status !== "skipped") push({ type: "step", step })
    }
    for (const id of phase.finish) {
      for (const issue of report.issues.filter((i) => i.step === id)) push({ type: "issue", issue })
      if (final.get(id)?.status !== "skipped") for (const key of SECTIONS[id] ?? []) push(sectionEvent(report, key, id))
      for (const finding of report.findings.filter((f) => !sent.has(f) && SECTIONS[id]?.includes(f.section))) {
        sent.add(finding)
        push({ type: "finding", finding })
      }
      const step = final.get(id)
      if (step) push({ type: "step", step })
    }
  }
  push({ type: "finished", report })
  return out
}

// A run that hits a reorg after the first pass and starts again.
export function restartStreamFor(report: Report, delayMs = 60): TimedEvent[] {
  const full = streamFor(report, delayMs)
  const firstPass = full.slice(0, Math.floor(full.length / 2))
  return [
    ...firstPass,
    { delayMs, event: { type: "restarted", reason: "Block 26176126 changed while the check ran (a reorg)." } },
    ...full.slice(1),
  ]
}

// The address has no account: the run stops after the identity step.
export function stoppedStream(delayMs = 60): TimedEvent[] {
  const [anchorRunning, identityRunning] = stepRecords("running")
  const [anchorDone] = stepRecords("done")
  const events: CheckEvent[] = [
    {
      type: "started",
      at: "2026-10-12T11:35:00Z",
      request: { address: "0x5afE5aFE5Afe5afe5aFe5afE5afE5aFE5afe0001", chainId: 1, block: null },
      chain: {
        chainId: 1,
        name: "Ethereum Mainnet",
        shortName: "eth",
        explorerAddressUrl: null,
        rootCheck: "supported",
      },
      steps: stepRecords("pending"),
    },
    { type: "step", step: anchorRunning },
    { type: "step", step: anchorDone },
    { type: "step", step: identityRunning },
    { type: "step", step: { ...identityRunning, status: "failed", note: "No account at this address." } },
    stoppedNotDeployed,
  ]
  return events.map((event) => ({ delayMs, event }))
}
