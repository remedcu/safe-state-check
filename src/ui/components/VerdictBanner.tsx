import { useEffect, useState } from "react"
import {
  AGREEMENT_LABEL,
  isPastState,
  issueHeadline,
  ownRpcLine,
  utcTime,
  PARTIAL_LABEL,
  SEVERITY_LABEL,
  VERDICT_LABEL,
  visibleIssues,
} from "@/core/markdown"
import { SEVERITIES } from "@/core/findings"
import type { Report, Severity, StepRecord, StopReason, UnverifiedReason, VerdictKind } from "@/core/report"
import { BUTTON, BUTTON_ON_TONE } from "@/ui/components/common"
import { shorten, STEP_STATUS_LABEL } from "@/ui/format"
import { STEP_LABELS, STEP_ORDER } from "@/core/steps"
import type { LiveRun } from "@/ui/run"

type BannerTone = "progress" | "ok" | "bad" | "warn"

const VERDICT_TONE: Record<VerdictKind, BannerTone> = { explained: "ok", unexplained: "bad", unverified: "warn" }

// The frame lines (border-*), the panel (bg-*), and the title and corner markers (text-*). Only the tone changes when
// the run ends; the box keeps its size.
const BANNER_TONE: Record<BannerTone, string> = {
  progress: "border-border bg-surface text-muted-foreground",
  ok: "border-brand-deep bg-brand-tint text-brand",
  bad: "border-bad bg-bad-surface text-bad",
  warn: "border-warn bg-warn-surface text-warn",
}

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
const BOX = "relative h-[32rem] sm:h-[28rem] lg:h-[22rem]"
// The content, clipped inside the frame. From lg up, the findings take a column of their own on the right.
const GRID =
  "grid h-full grid-cols-1 grid-rows-[auto_minmax(0,1fr)_auto_auto] gap-3 overflow-hidden p-5 sm:px-8 sm:py-7 lg:grid-cols-[minmax(0,1fr)_14rem] lg:grid-rows-[auto_minmax(0,1fr)_auto] lg:gap-x-10"

const NOTICE = "mb-2 rounded-sm border border-warn-border bg-warn-surface px-2 py-0.5 text-sm text-warn"

// Rules inside a tinted panel: the panel's own tone, lightened.
const RULE = "border-foreground/20"

const SEVERITY_SQUARE: Record<Severity, string> = {
  critical: "bg-bad outline-[1.5px] outline-offset-[1.5px] outline-bad outline-solid",
  high: "bg-bad",
  medium: "bg-warn",
  info: "bg-info",
}

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

// The frame of the design system's slides: lines that run past the corners, a square on each crossing. Lines take the
// box's border color and the squares its text color, so the tone colors both. Decoration only, out of the grid.
function Frame() {
  const line = "absolute [border-color:inherit]"
  const across = `${line} -inset-x-2.5 sm:-inset-x-[18px]`
  const down = `${line} -inset-y-2.5 sm:-inset-y-[18px]`
  const square = "absolute size-2.5 bg-current sm:size-3.5"
  return (
    <span aria-hidden="true" className="pointer-events-none absolute inset-0 [border-color:inherit]">
      <span className={`${across} top-0 border-t-2`} />
      <span className={`${across} bottom-0 border-b-2`} />
      <span className={`${down} left-0 border-l-2`} />
      <span className={`${down} right-0 border-r-2`} />
      <span className={`${square} -top-1 -left-1 sm:-top-1.5 sm:-left-1.5`} />
      <span className={`${square} -top-1 -right-1 sm:-top-1.5 sm:-right-1.5`} />
      <span className={`${square} -bottom-1 -left-1 sm:-bottom-1.5 sm:-left-1.5`} />
      <span className={`${square} -right-1 -bottom-1 sm:-right-1.5 sm:-bottom-1.5`} />
    </span>
  )
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
  const total = report.findings.length
  const rpcReason = verdict.unverified.some((u) => RPC_REASONS.has(u.reason))
  const past = isPastState(report)
  const trust = verification.agreement === "self-trusted" ? AGREEMENT_LABEL["self-trusted"] : ownRpcLine(verification)
  const [list, setList] = useState<HTMLUListElement | null>(null)
  const reasons = useOverflow(list)
  return (
    <section
      aria-labelledby={VERDICT_HEADING_ID}
      className={`${BOX} ${BANNER_TONE[partial ? "warn" : VERDICT_TONE[verdict.kind]]}`}
    >
      <Frame />
      <div className={GRID}>
        <div className="flex min-w-0 flex-col gap-1.5 lg:col-start-1 lg:row-start-1">
          <h2
            id={VERDICT_HEADING_ID}
            tabIndex={-1}
            className="text-[28px] leading-[34px] font-semibold focus:outline-none sm:text-[34px] sm:leading-10"
          >
            {partial ? PARTIAL_LABEL : VERDICT_LABEL[verdict.kind]}
          </h2>
          <p className="text-base text-foreground sm:text-lg">{verdict.headline}</p>
          <p className="text-sm text-muted-foreground">
            Block {verification.anchor.number}, {utcTime(verification.anchor.timestamp)}
          </p>
        </div>
        {/* The notices lead the list, so the list is the one part that gives way when space runs out. */}
        <div className="relative min-h-0 lg:col-start-1 lg:row-start-2">
          <ul
            ref={setList}
            aria-label="Reasons"
            tabIndex={reasons.overflows ? 0 : undefined}
            className="h-full overflow-y-auto text-sm text-foreground sm:text-[15px] sm:leading-[22px]"
          >
            {past && (
              <li className={NOTICE}>
                This is the state at block {verification.anchor.number}, not the current state.
              </li>
            )}
            {trust && <li className={NOTICE}>{trust}</li>}
            {[...notes, ...verdict.reasons.slice(0, 3)].map((reason) => (
              <li
                key={reason}
                className={`relative border-t py-2 pl-5 ${RULE} before:absolute before:left-0 before:content-['-'] last:border-b`}
              >
                {reason}
              </li>
            ))}
          </ul>
          {reasons.more && (
            <p className="pointer-events-none absolute right-0 bottom-0 bg-background px-1.5 text-xs text-foreground">
              More below; scroll the list.
            </p>
          )}
        </div>
        <div className={`flex flex-col gap-3 lg:col-start-2 lg:row-span-3 lg:row-start-1 lg:border-l lg:pl-8 ${RULE}`}>
          <p className="hidden text-sm font-semibold text-foreground lg:block">Findings</p>
          <ul
            aria-label="Findings by severity"
            className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm sm:grid-cols-4 sm:gap-x-8 lg:grid-cols-1 lg:gap-y-2.5 lg:text-[15px]"
          >
            {SEVERITIES.map((severity) => {
              const count = verdict.counts[severity]
              return (
                <li
                  key={severity}
                  className={`flex items-center gap-2.5 ${count > 0 ? "font-semibold text-foreground" : "text-muted-foreground"}`}
                >
                  <span
                    aria-hidden="true"
                    className={`size-2.5 shrink-0 ${count > 0 ? SEVERITY_SQUARE[severity] : "border-[1.5px] border-muted-foreground"}`}
                  />
                  <span>{SEVERITY_LABEL[severity]}</span> <span className="ml-auto tabular-nums">{count}</span>
                </li>
              )
            })}
          </ul>
          {total > 0 && (
            <button
              type="button"
              className={`${BUTTON_ON_TONE} w-full sm:w-auto sm:self-start lg:mt-auto lg:w-full`}
              aria-expanded={actions.findingsOpen}
              aria-controls="all-findings"
              onClick={actions.onToggleFindings}
            >
              {actions.findingsOpen ? "Hide findings" : `Show all ${total} findings`}
            </button>
          )}
        </div>
        {(partial || past || rpcReason) && (
          <div className="flex flex-wrap gap-2 lg:col-start-1 lg:row-start-3">
            {partial && (
              <button type="button" className={BUTTON_ON_TONE} onClick={actions.onRetry}>
                Try again
              </button>
            )}
            {past && (
              <button type="button" className={BUTTON_ON_TONE} onClick={actions.onLatestBlock}>
                Check the latest block
              </button>
            )}
            {rpcReason && (
              <button type="button" className={BUTTON_ON_TONE} onClick={actions.onOpenSettings}>
                RPC settings
              </button>
            )}
          </div>
        )}
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
    <section aria-labelledby={VERDICT_HEADING_ID} className={`${BOX} ${BANNER_TONE.warn}`}>
      <Frame />
      <div className={GRID}>
        <h2
          id={VERDICT_HEADING_ID}
          tabIndex={-1}
          className="text-[28px] leading-[34px] font-semibold focus:outline-none sm:text-[34px] sm:leading-10 lg:col-span-2"
        >
          {reason ? STOP_HEADING[reason] : "The check could not run"}
        </h2>
        <p tabIndex={0} className="min-h-0 overflow-y-auto text-foreground wrap-anywhere sm:text-lg lg:col-span-2">
          {run.stop?.message}
        </p>
        <div className="flex flex-wrap items-center justify-between gap-3 lg:col-span-2">
          <p className="text-sm text-foreground">
            {visibleIssues(run.issues).length > 0 ? "The problems are listed below." : "Nothing was checked."}
          </p>
          <div className="flex gap-2">
            {(reason === "no-rpc" || reason === "anchor-failed") && (
              <button type="button" className={BUTTON_ON_TONE} onClick={actions.onOpenSettings}>
                RPC settings
              </button>
            )}
            <button type="button" className={BUTTON_ON_TONE} onClick={actions.onRetry}>
              Try again
            </button>
          </div>
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

// A small block per step that fills in as the run goes: done in green with a check, gaps in amber with "!", failed in
// red with "✕". Shape and glyph carry the state, not only the color.
function StepIcon({ status }: { status: StepRecord["status"] }) {
  const cell = "inline-flex size-3.5 shrink-0 items-center justify-center text-[10px] leading-none font-semibold"
  switch (status) {
    case "running":
      return (
        <span aria-hidden="true" className={`${cell} border-[1.5px] border-foreground`}>
          <span className="size-1.5 bg-foreground motion-safe:animate-blink" />
        </span>
      )
    case "done":
      return (
        <span aria-hidden="true" className={`${cell} bg-brand`}>
          <svg viewBox="0 0 9 7" className="h-[7px] w-[9px] fill-none stroke-primary-foreground">
            <path d="M1 3.5L3.5 6L8 1" strokeWidth="1.6" />
          </svg>
        </span>
      )
    case "degraded":
      return (
        <span aria-hidden="true" className={`${cell} bg-warn text-primary-foreground`}>
          !
        </span>
      )
    case "failed":
      return (
        <span aria-hidden="true" className={`${cell} bg-bad text-primary-foreground`}>
          ✕
        </span>
      )
    case "skipped":
      return (
        <span aria-hidden="true" className={`${cell} border border-border text-muted-foreground`}>
          –
        </span>
      )
    case "pending":
      return <span aria-hidden="true" className={`${cell} border-[1.5px] border-border`} />
  }
}

function Progress({ run, actions }: { run: LiveRun; actions: BannerActions }) {
  const steps = STEP_ORDER.map((id) => stepFor(run, id, STEP_LABELS[id]))
  const finished = steps.filter((s) => s.status !== "pending" && s.status !== "running").length
  const issues = visibleIssues(run.issues)
  const latest = issues.at(-1)
  return (
    <section aria-labelledby={VERDICT_HEADING_ID} aria-busy="true" className={`${BOX} ${BANNER_TONE.progress}`}>
      <Frame />
      <div className={GRID}>
        <div className="flex items-start justify-between gap-3 lg:col-span-2">
          <div className="min-w-0">
            <h2 id={VERDICT_HEADING_ID} className="truncate text-xl font-semibold text-foreground sm:text-2xl">
              Checking {shorten(run.request.address)}
              {run.chain ? ` on ${run.chain.name}` : ""}
              {run.request.block ? ` at block ${run.request.block}` : ""}
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
        <ol
          aria-label="Steps"
          className="grid min-h-0 grid-cols-2 content-start gap-x-4 gap-y-0.5 text-[13px] sm:grid-cols-3 sm:gap-x-6 sm:text-sm lg:col-span-2"
        >
          {steps.map((step) => {
            const count = issues.filter((issue) => issue.step === step.id).length
            return (
              <li
                key={step.id}
                className={`flex h-7 min-w-0 items-center gap-2.5 ${step.status === "pending" ? "text-muted-foreground" : "text-foreground"}`}
                title={[step.label, STEP_STATUS_LABEL[step.status], step.note].filter(Boolean).join(": ")}
              >
                <StepIcon status={step.status} />
                <span className="truncate">{step.label}</span>
                <span className="sr-only">, {STEP_STATUS_LABEL[step.status]}</span>
                {count > 0 && (
                  <span className="ml-auto shrink-0 rounded-sm bg-warn-surface px-1 text-xs text-warn tabular-nums">
                    {count}
                    <span className="sr-only"> problems</span>
                  </span>
                )}
              </li>
            )
          })}
        </ol>
        <p className="line-clamp-2 h-10 text-sm text-warn lg:col-span-2" aria-live="polite">
          {latest ? `${issueHeadline(latest)}.${latest.recovered ? " Worked around." : ""}` : ""}
        </p>
      </div>
    </section>
  )
}
