// A run as the UI sees it: the events of src/check folded into one value, and the rule for which detail sections can
// be shown while the run streams without moving anything already on screen.
import type { Address } from "viem"
import type {
  ChainRef,
  CheckEvent,
  IsoTime,
  Part,
  CheckRequest,
  Finding,
  Report,
  ReportIssue,
  SectionKey,
  StepId,
  StepRecord,
  StopReason,
} from "@/core/report"
import { PARTIAL_LABEL } from "@/core/markdown"
import type { ChainRpcSettings, DetectResult } from "@/data/types"

export type LiveRun = {
  request: CheckRequest
  chain: ChainRef | null
  status: "starting" | "running" | "finished" | "stopped"
  startedAt: IsoTime | null
  steps: StepRecord[]
  sections: { [K in SectionKey]?: Report[K] }
  findings: Finding[]
  issues: ReportIssue[]
  restarts: string[]
  report: Report | null
  // "crashed": the pipeline threw, which it should never do; the UI still says so in plain words.
  stop: { reason: StopReason | "crashed"; message: string } | null
}

export function startRun(request: CheckRequest, chain: ChainRef | null = null): LiveRun {
  return {
    request,
    chain,
    status: "starting",
    startedAt: null,
    steps: [],
    sections: {},
    findings: [],
    issues: [],
    restarts: [],
    report: null,
    stop: null,
  }
}

const issueKey = (issue: ReportIssue) => JSON.stringify(issue)

function mergeIssues(known: ReportIssue[], more: readonly ReportIssue[]): ReportIssue[] {
  const seen = new Set(known.map(issueKey))
  return [...known, ...more.filter((issue) => !seen.has(issueKey(issue)))]
}

export function reduceRun(run: LiveRun, event: CheckEvent): LiveRun {
  switch (event.type) {
    case "started":
      return {
        ...run,
        status: "running",
        startedAt: event.at,
        request: event.request,
        chain: event.chain,
        steps: event.steps,
      }
    case "step": {
      const found = run.steps.some((step) => step.id === event.step.id)
      const steps = found
        ? run.steps.map((step) => (step.id === event.step.id ? event.step : step))
        : [...run.steps, event.step]
      return { ...run, steps }
    }
    case "section":
      return { ...run, sections: { ...run.sections, [event.patch.key]: event.patch.value } }
    case "finding":
      return { ...run, findings: [...run.findings, event.finding] }
    case "issue":
      return { ...run, issues: mergeIssues(run.issues, [event.issue]) }
    case "restarted":
      // The partial report belongs to the old block; issues stay, they explain the restart.
      return {
        ...run,
        sections: {},
        findings: [],
        steps: run.steps.map((step) => ({ ...step, status: "pending", note: null, startedAt: null, finishedAt: null })),
        restarts: [...run.restarts, event.reason],
      }
    case "finished":
      return {
        ...run,
        status: "finished",
        report: event.report,
        steps: event.report.steps,
        issues: event.report.issues,
        findings: event.report.findings,
      }
    case "stopped":
      return {
        ...run,
        status: "stopped",
        stop: { reason: event.reason, message: event.message },
        issues: mergeIssues(run.issues, event.issues),
      }
  }
}

// Display order of the detail sections (docs/SPEC.md section 7, with the Safe's code first and the guard and handler
// after the modules).
export const SECTION_ORDER = [
  "identity",
  "owners",
  "modules",
  "handlers",
  "storage",
  "creation",
  "history",
  "pending",
  "diagnosis",
  "verification",
  "crossChain",
] as const satisfies readonly SectionKey[]

// Steps whose results can still change a section. The history step may tell the handlers whether an event set them;
// the storage table grows in the event pass and in diagnosis. Verification and other chains are final only at the end.
const WRITERS: Record<SectionKey, StepId[] | null> = {
  identity: ["identity"],
  owners: ["owners"],
  modules: ["modules"],
  handlers: ["handlers", "history"],
  storage: ["storage", "storage-events", "diagnosis"],
  creation: ["creation"],
  history: ["history"],
  pending: ["pending"],
  diagnosis: ["diagnosis"],
  verification: null,
  crossChain: null,
}

const TERMINAL = new Set<StepRecord["status"]>(["done", "degraded", "skipped", "failed"])

function settled(run: LiveRun, key: SectionKey): boolean {
  const writers = WRITERS[key]
  if (writers === null) return false
  const stepsDone = writers.every((id) => {
    const step = run.steps.find((s) => s.id === id)
    return !step || TERMINAL.has(step.status)
  })
  if (!stepsDone) return false
  // Diagnosis sends nothing when the root matched; its step is then skipped.
  if (key === "diagnosis") return key in run.sections || run.steps.find((s) => s.id === "diagnosis")?.status !== "done"
  return key in run.sections
}

// Sections that can be on screen now. While streaming, a section appears only when it and every section above it are
// final, so new content is only ever added below what is already there.
export function shownSections(run: LiveRun): SectionKey[] {
  if (run.report) return [...SECTION_ORDER]
  const shown: SectionKey[] = []
  for (const key of SECTION_ORDER) {
    if (!settled(run, key)) break
    shown.push(key)
  }
  return shown
}

export type Detection = {
  address: Address
  scope: "popular" | "all"
  results: DetectResult[]
  done: boolean
  // Why the search ended before every chain answered.
  error: string | null
}

// What the page shows below the input: nothing, a chain search, or a run.
export type Flow =
  { kind: "idle" } | { kind: "detecting"; detection: Detection } | { kind: "run"; id: number; run: LiveRun }

export type FlowAction =
  | { type: "detect"; address: Address; scope: Detection["scope"] }
  | { type: "detected"; result: DetectResult }
  | { type: "detect-done"; results: DetectResult[] }
  | { type: "detect-failed"; message: string }
  | { type: "run"; id: number; request: CheckRequest; chain: ChainRef | null }
  | { type: "event"; id: number; event: CheckEvent }
  | { type: "crashed"; id: number; message: string }

export function reduceFlow(flow: Flow, action: FlowAction): Flow {
  switch (action.type) {
    case "detect":
      return {
        kind: "detecting",
        detection: { address: action.address, scope: action.scope, results: [], done: false, error: null },
      }
    case "detected":
      if (flow.kind !== "detecting") return flow
      return { ...flow, detection: { ...flow.detection, results: [...flow.detection.results, action.result] } }
    case "detect-done":
      if (flow.kind !== "detecting") return flow
      return { ...flow, detection: { ...flow.detection, results: action.results, done: true } }
    case "detect-failed":
      if (flow.kind !== "detecting") return flow
      return { ...flow, detection: { ...flow.detection, done: true, error: action.message } }
    case "run":
      return { kind: "run", id: action.id, run: startRun(action.request, action.chain) }
    case "event":
      // Events of a run the user has already replaced are dropped.
      if (flow.kind !== "run" || flow.id !== action.id) return flow
      return { ...flow, run: reduceRun(flow.run, action.event) }
    case "crashed":
      if (flow.kind !== "run" || flow.id !== action.id) return flow
      return { ...flow, run: { ...flow.run, status: "stopped", stop: { reason: "crashed", message: action.message } } }
  }
}

const NOT_READ = "Not read: the check was stopped first."

// What a run the user stopped had already proven, as a report: finished sections as they were, the rest marked not
// read, and a verdict that is no verdict. Null when nothing was proven yet (no block was pinned).
export function partialReport(run: LiveRun, tool: Report["tool"]): Report | null {
  const verification = run.sections.verification
  if (run.status !== "stopped" || run.stop?.reason !== "cancelled" || !verification || !run.chain) return null
  const part = <T>(value: Part<T> | undefined): Part<T> => value ?? { state: "skipped", reason: NOT_READ }
  const counts = { critical: 0, high: 0, medium: 0, info: 0 }
  for (const finding of run.findings) counts[finding.severity] += 1
  const unfinished = new Set<StepRecord["status"]>(["pending", "running"])
  return {
    schema: 1,
    tool,
    createdAt: run.startedAt ?? verification.anchor.timestamp,
    request: run.request,
    chain: run.chain,
    verdict: {
      kind: "unverified",
      headline: `${PARTIAL_LABEL}. The check was stopped before it finished, so this is not a verdict.`,
      reasons: ["You stopped the check. Only the parts it finished are shown; the rest says it was not read."],
      unverified: [{ reason: "read-failed", detail: "You stopped the check before it finished." }],
      matchedBy: null,
      counts,
    },
    findings: run.findings,
    cards: [],
    identity: part(run.sections.identity),
    owners: part(run.sections.owners),
    modules: part(run.sections.modules),
    handlers: part(run.sections.handlers),
    storage: part(run.sections.storage),
    creation: part(run.sections.creation),
    history: part(run.sections.history),
    pending: part(run.sections.pending),
    diagnosis: run.sections.diagnosis ?? null,
    verification,
    crossChain: null,
    steps: run.steps.map((step) =>
      unfinished.has(step.status) ? { ...step, status: "skipped", note: "Stopped by you." } : step,
    ),
    issues: run.issues,
    notChecked: ["Every part marked as not read: the check was stopped before it got there."],
  }
}

const hostOf = (url: string | null) => {
  try {
    return url ? new URL(url).host : null
  } catch {
    return null
  }
}

// An RPC the user entered that the run did not end up using (it failed and another took its place). The report names
// only the RPCs used, so the page says what became of the user's own.
export function droppedRpcLines(report: Report, rpcs: ChainRpcSettings | null): string[] {
  if (!rpcs) return []
  const used = new Set([report.verification.primary.host, report.verification.crossCheck?.host])
  const configured = [...new Set([hostOf(rpcs.primary), hostOf(rpcs.crossCheck)])].filter((h) => h !== null)
  return configured
    .filter((host) => !used.has(host))
    .map((host) => {
      const issue = report.issues.find((i) => i.host === host)
      return issue
        ? `Your RPC ${host} was not used: ${issue.title.replace(/\.$/, "")}.`
        : `Your RPC ${host} was not used.`
    })
}
