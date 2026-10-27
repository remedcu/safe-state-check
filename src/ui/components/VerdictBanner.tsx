import { useEffect, useState } from "react"
import {
  AGREEMENT_LABEL,
  isPastState,
  issueHeadline,
  ownRpcLine,
  utcTime,
  PARTIAL_LABEL,
  VERDICT_LABEL,
  visibleIssues,
} from "@/core/markdown"
import type { Report, StepRecord, StopReason, Tone, UnverifiedReason, VerdictKind } from "@/core/report"
import { Spinner } from "@/ui/components/common"
import { shorten, STEP_STATUS_LABEL, TONE_CLASSES } from "@/ui/format"
import { STEP_LABELS, STEP_ORDER } from "@/core/steps"
import type { LiveRun } from "@/ui/run"

const VERDICT_TONE: Record<VerdictKind, Tone> = { explained: "ok", unexplained: "bad", unverified: "warn" }

// Unverified reasons that the user's own RPC can fix.
const RPC_REASONS = new Set<UnverifiedReason>([
  "no-proof-rpc",
  "single-operator",
  "rpc-disagreement",
  "proof-invalid",
  "read-failed",
  "unproven-read",
  "inspection-incomplete",
])

// One box for the whole run: progress while it streams, then the verdict or why it stopped. Its height is fixed in
// every state, so nothing below it moves when the state changes; the reasons scroll inside it when they do not fit.
const BOX = "grid h-[28rem] grid-cols-1 grid-rows-[auto_1fr_auto] gap-2 overflow-hidden rounded-lg border-2 p-4 sm:h-80"

const BUTTON =
  "rounded border border-current px-2 py-1 text-sm hover:bg-subtle focus-visible:outline-2 focus-visible:outline-focus"

export type BannerActions = {
  onStop: () => void
  onRetry: () => void
  onOpenSettings: () => void
  onLatestBlock: () => void
  findingsOpen: boolean
  onToggleFindings: () => void
}

export const VERDICT_HEADING_ID = "verdict-title"

export function VerdictBanner({
  run,
  partial,
  notes,
  actions,
}: {
  run: LiveRun
  // What a stopped run had proven; shown like a result, under its own label.
  partial: Report | null
  // Lines the report cannot say on its own, such as a user RPC that was not used.
  notes: readonly string[]
  actions: BannerActions
}) {
  if (run.report) return <Verdict report={run.report} notes={notes} partial={false} actions={actions} />
  if (partial) return <Verdict report={partial} notes={notes} partial actions={actions} />
  if (run.status === "stopped") return <Stopped run={run} actions={actions} />
  return <Progress run={run} actions={actions} />
}

// Whether the list has content below what is shown, so the box can say so instead of cutting it off unnoticed.
function useOverflow(list: HTMLElement | null) {
  const [state, setState] = useState({ overflows: false, more: false })
  useEffect(() => {
    if (!list || typeof ResizeObserver === "undefined") return
    const measure = () => {
      const overflows = list.scrollHeight > list.clientHeight + 1
      setState({ overflows, more: overflows && list.scrollTop + list.clientHeight < list.scrollHeight - 1 })
    }
    const observer = new ResizeObserver(measure)
    observer.observe(list)
    list.addEventListener("scroll", measure)
    return () => {
      observer.disconnect()
      list.removeEventListener("scroll", measure)
    }
  }, [list])
  return state
}

function Verdict({
  report,
  notes,
  partial,
  actions,
}: {
  report: Report
  notes: readonly string[]
  partial: boolean
  actions: BannerActions
}) {
  const { verdict, verification } = report
  const counts = (["critical", "high", "medium", "info"] as const).map((s) => `${verdict.counts[s]} ${s}`).join(" · ")
  const total = report.findings.length
  const rpcReason = verdict.unverified.some((u) => RPC_REASONS.has(u.reason))
  const past = isPastState(report)
  const trust = verification.agreement === "self-trusted" ? AGREEMENT_LABEL["self-trusted"] : ownRpcLine(verification)
  const [list, setList] = useState<HTMLUListElement | null>(null)
  const reasons = useOverflow(list)
  return (
    <section
      aria-labelledby={VERDICT_HEADING_ID}
      className={`${BOX} ${TONE_CLASSES[partial ? "warn" : VERDICT_TONE[verdict.kind]]}`}
    >
      <div className="flex flex-col gap-1">
        <h2 id={VERDICT_HEADING_ID} tabIndex={-1} className="text-xl font-bold focus:outline-none">
          {partial ? PARTIAL_LABEL : VERDICT_LABEL[verdict.kind]}
        </h2>
        <p className="text-foreground">{verdict.headline}</p>
        <p className="text-sm text-foreground">
          Block {verification.anchor.number}, {utcTime(verification.anchor.timestamp)}
        </p>
        {past && (
          <p className="rounded border border-warn-border bg-warn-surface px-2 py-0.5 text-sm text-warn">
            This is the state at block {verification.anchor.number}, not the current state.
          </p>
        )}
        {trust && (
          <p className="rounded border border-warn-border bg-warn-surface px-2 py-0.5 text-sm text-warn">{trust}</p>
        )}
      </div>
      <div className="relative min-h-0">
        <ul
          ref={setList}
          aria-label="Reasons"
          tabIndex={reasons.overflows ? 0 : undefined}
          className="h-full list-disc overflow-y-auto pl-5 text-sm text-foreground focus-visible:outline-2 focus-visible:outline-focus"
        >
          {[...notes, ...verdict.reasons.slice(0, 3)].map((reason) => (
            <li key={reason}>{reason}</li>
          ))}
        </ul>
        {reasons.more && (
          <p className="pointer-events-none absolute right-0 bottom-0 rounded bg-surface px-1 text-xs text-foreground">
            More below; scroll the list.
          </p>
        )}
      </div>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm">Findings: {counts}</p>
        <div className="flex flex-wrap gap-2">
          {partial && (
            <button type="button" className={BUTTON} onClick={actions.onRetry}>
              Try again
            </button>
          )}
          {past && (
            <button type="button" className={BUTTON} onClick={actions.onLatestBlock}>
              Check the latest block
            </button>
          )}
          {rpcReason && (
            <button type="button" className={BUTTON} onClick={actions.onOpenSettings}>
              RPC settings
            </button>
          )}
          {total > 0 && (
            <button
              type="button"
              className={BUTTON}
              aria-expanded={actions.findingsOpen}
              aria-controls="all-findings"
              onClick={actions.onToggleFindings}
            >
              {actions.findingsOpen ? "Hide findings" : `Show all ${total} findings`}
            </button>
          )}
        </div>
      </div>
    </section>
  )
}

// The heading for a run that ended without a report; the message under it says the details.
const STOP_HEADING: Record<StopReason | "crashed", string> = {
  "not-deployed": "No Safe at this address",
  "no-code": "No Safe at this address",
  "not-a-safe": "This address is not a Safe",
  "unknown-chain": "Unknown chain",
  "no-rpc": "No RPC can read this chain",
  "anchor-failed": "No block could be pinned",
  cancelled: "Check stopped",
  crashed: "The check failed",
}

function Stopped({ run, actions }: { run: LiveRun; actions: BannerActions }) {
  const reason = run.stop?.reason
  return (
    <section aria-labelledby={VERDICT_HEADING_ID} className={`${BOX} ${TONE_CLASSES.warn}`}>
      <h2 id={VERDICT_HEADING_ID} tabIndex={-1} className="text-xl font-bold focus:outline-none">
        {reason ? STOP_HEADING[reason] : "The check could not run"}
      </h2>
      <p
        tabIndex={0}
        className="min-h-0 overflow-y-auto text-foreground wrap-anywhere focus-visible:outline-2 focus-visible:outline-focus"
      >
        {run.stop?.message}
      </p>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm">
          {visibleIssues(run.issues).length > 0 ? "The problems are listed below." : "Nothing was checked."}
        </p>
        <div className="flex gap-2">
          {(reason === "no-rpc" || reason === "anchor-failed") && (
            <button type="button" className={BUTTON} onClick={actions.onOpenSettings}>
              RPC settings
            </button>
          )}
          <button type="button" className={BUTTON} onClick={actions.onRetry}>
            Try again
          </button>
        </div>
      </div>
    </section>
  )
}

function stepFor(run: LiveRun, id: StepRecord["id"], label: string): StepRecord {
  const step = run.steps.find((s) => s.id === id)
  if (step) return step
  // Before `started`, every step waits; after it, a step the run does not have is not needed.
  const status = run.status === "starting" ? "pending" : "skipped"
  return { id, label, status, note: run.status === "starting" ? null : "Not needed", startedAt: null, finishedAt: null }
}

function StepIcon({ status }: { status: StepRecord["status"] }) {
  if (status === "running") return <Spinner />
  const glyph = { pending: "○", done: "✓", degraded: "!", skipped: "–", failed: "✕" }[status]
  return (
    <span aria-hidden="true" className="inline-flex size-3.5 shrink-0 items-center justify-center text-xs font-bold">
      {glyph}
    </span>
  )
}

function Progress({ run, actions }: { run: LiveRun; actions: BannerActions }) {
  const steps = STEP_ORDER.map((id) => stepFor(run, id, STEP_LABELS[id]))
  const finished = steps.filter((s) => s.status !== "pending" && s.status !== "running").length
  const issues = visibleIssues(run.issues)
  const latest = issues.at(-1)
  return (
    <section aria-labelledby={VERDICT_HEADING_ID} aria-busy="true" className={`${BOX} ${TONE_CLASSES.neutral}`}>
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <h2 id={VERDICT_HEADING_ID} className="flex items-center gap-2 text-lg font-semibold">
            <Spinner />
            <span className="truncate">
              Checking {shorten(run.request.address)}
              {run.chain ? ` on ${run.chain.name}` : ""}
              {run.request.block ? ` at block ${run.request.block}` : ""}
            </span>
          </h2>
          <p className="truncate text-sm text-muted-foreground">
            {/* Fixed-width digits: the text after the count must not move when it gains a digit. */}
            <span className="inline-block w-[2ch] tabular-nums">{finished}</span> of {steps.length} steps finished
            {run.restarts.length > 0 ? `. Restarted: ${run.restarts.at(-1)}` : ""}
          </p>
        </div>
        <button type="button" className={BUTTON} onClick={actions.onStop}>
          Stop
        </button>
      </div>
      <ol aria-label="Steps" className="grid min-h-0 grid-cols-2 content-start gap-x-3 gap-y-1 text-sm sm:grid-cols-3">
        {steps.map((step) => {
          const count = issues.filter((issue) => issue.step === step.id).length
          return (
            <li
              key={step.id}
              className={`flex h-6 min-w-0 items-center gap-1.5 ${step.status === "pending" ? "text-muted-foreground" : ""}`}
              title={[step.label, STEP_STATUS_LABEL[step.status], step.note].filter(Boolean).join(": ")}
            >
              <StepIcon status={step.status} />
              <span className="truncate">{step.label}</span>
              <span className="sr-only">, {STEP_STATUS_LABEL[step.status]}</span>
              {count > 0 && (
                <span className="ml-auto shrink-0 rounded bg-warn-surface px-1 text-xs text-warn tabular-nums">
                  {count}
                  <span className="sr-only"> problems</span>
                </span>
              )}
            </li>
          )
        })}
      </ol>
      <p className="line-clamp-2 h-10 text-sm text-warn" aria-live="polite">
        {latest ? `${issueHeadline(latest)}.${latest.recovered ? " Worked around." : ""}` : ""}
      </p>
    </section>
  )
}
