import { type ReactNode, useEffect, useMemo, useState } from "react"
import { VERDICT_LABEL, visibleIssues } from "@/core/markdown"
import type { ChainRef, Finding, Report, SectionKey } from "@/core/report"
import type { ChainRpcSettings } from "@/data/types"
import { Mono, SectionTitle, SeverityBadge } from "@/ui/components/common"
import { IssueList } from "@/ui/components/IssueCard"
import { ReportActions } from "@/ui/components/ReportActions"
import { SummaryCards } from "@/ui/components/SummaryCards"
import { type BannerActions, VERDICT_HEADING_ID, VerdictBanner } from "@/ui/components/VerdictBanner"
import { droppedRpcLines, type LiveRun, partialReport, SECTION_ORDER, shownSections } from "@/ui/run"
import { Creation, History, Pending } from "@/ui/sections/Activity"
import { Handlers, Identity, Modules, Owners } from "@/ui/sections/Config"
import { Diagnosis, Storage } from "@/ui/sections/Storage"
import { CrossChain, NotChecked, StepsTable, Verification } from "@/ui/sections/Verification"

function FindingsList({ findings }: { findings: readonly Finding[] }) {
  return (
    <section id="all-findings" aria-label="All findings" className="mt-3 border border-border-subtle bg-surface">
      <ul>
        {findings.map((f, index) => (
          <li
            key={`${f.code}-${f.subject}-${index}`}
            className="border-b border-border-subtle px-4 py-3.5 text-sm last:border-b-0 sm:px-5"
          >
            <p className="flex flex-wrap items-center gap-2.5">
              <SeverityBadge severity={f.severity} />
              <span className="font-semibold">{f.title}</span>
            </p>
            <p className="mt-1.5">{f.explanation}</p>
            <p className="mt-1.5 text-xs text-muted-foreground">
              <Mono>{f.technical}</Mono>
              {f.subject && (
                <>
                  {" "}
                  (subject <Mono>{f.subject}</Mono>)
                </>
              )}
            </p>
          </li>
        ))}
      </ul>
    </section>
  )
}

export type RunActions = Omit<BannerActions, "findingsOpen" | "onToggleFindings"> & {
  onTestCandidates?: (candidates: string[]) => Promise<void>
  onCheckOtherChains?: () => Promise<void>
}

// What a screen reader hears when the run ends; the banner's own content is swapped, so it cannot announce itself.
function announcement(run: LiveRun): string {
  if (run.report) {
    const { verdict } = run.report
    const counts = (["critical", "high", "medium", "info"] as const).map((s) => `${verdict.counts[s]} ${s}`).join(", ")
    return `Check finished: ${VERDICT_LABEL[verdict.kind]}. Findings: ${counts}.`
  }
  return run.status === "stopped" ? `Check stopped: ${run.stop?.message ?? ""}` : ""
}

// Verdict, cards and the detail sections of one run, streamed or finished.
export function RunView({
  run,
  actions,
  tool,
  userRpcs,
}: {
  run: LiveRun
  actions: RunActions
  tool: Report["tool"]
  // The chain's RPC settings when the run started, to tell the user when their own RPC was not used.
  userRpcs: ChainRpcSettings | null
}) {
  const [findingsOpen, setFindingsOpen] = useState(false)
  // A run the user stopped keeps what it proved, shown and downloadable as a partial result.
  const partial = useMemo(() => partialReport(run, tool), [run, tool])
  const report = run.report ?? partial
  const notes = report ? droppedRpcLines(report, userRpcs) : []
  const data = report ?? run.sections
  const chain: ChainRef | null = report?.chain ?? run.chain
  const ended = run.status === "finished" || run.status === "stopped"

  // When the run ends, the result takes focus unless the user has moved on to something else.
  useEffect(() => {
    if (!ended) return
    const active = document.activeElement
    if (active === null || active === document.body || active.hasAttribute("data-run-control")) {
      document.getElementById(VERDICT_HEADING_ID)?.focus()
    }
  }, [ended])

  const sections: Record<SectionKey, () => ReactNode> = {
    identity: () => <Identity part={data.identity} chain={chain} />,
    owners: () => <Owners part={data.owners} chain={chain} />,
    modules: () => <Modules part={data.modules} chain={chain} />,
    handlers: () => <Handlers part={data.handlers} chain={chain} />,
    storage: () => <Storage part={data.storage} />,
    creation: () => <Creation part={data.creation} chain={chain} />,
    history: () => <History part={data.history} />,
    pending: () => <Pending part={data.pending} chain={chain} />,
    diagnosis: () =>
      data.diagnosis ? <Diagnosis diagnosis={data.diagnosis} onTestCandidates={actions.onTestCandidates} /> : null,
    verification: () =>
      report ? <Verification report={report} steps={run.steps} onOpenSettings={actions.onOpenSettings} /> : null,
    crossChain: () =>
      report?.crossChain || actions.onCheckOtherChains ? (
        <CrossChain part={report?.crossChain ?? null} onCheck={actions.onCheckOtherChains} />
      ) : null,
  }

  return (
    <div className="mt-6 flex flex-col gap-5 sm:mt-8">
      <p role="status" className="sr-only">
        {announcement(run)}
      </p>
      <VerdictBanner
        run={run}
        partial={partial}
        notes={notes}
        actions={{ ...actions, findingsOpen, onToggleFindings: () => setFindingsOpen(!findingsOpen) }}
      />
      {findingsOpen && report && <FindingsList findings={report.findings} />}
      <div className="mt-3 flex flex-col gap-3">
        <ReportActions report={report} partial={partial !== null} notes={notes} />
        <SummaryCards cards={report?.cards ?? null} />
      </div>
      {run.status === "stopped" && !partial && (
        <section aria-labelledby="stopped-problems" className="mt-12 flex flex-col gap-4">
          <SectionTitle id="stopped-problems" title="Problems during the run" />
          {visibleIssues(run.issues).length > 0 ? (
            <IssueList issues={visibleIssues(run.issues)} onOpenSettings={actions.onOpenSettings} />
          ) : (
            <p className="text-sm">None recorded.</p>
          )}
          {run.steps.length > 0 && <StepsTable steps={run.steps} />}
        </section>
      )}
      {(partial ? SECTION_ORDER : shownSections(run)).map((key) => {
        const node = sections[key]()
        return node ? (
          <div key={key} className="mt-10 sm:mt-12">
            {node}
          </div>
        ) : null
      })}
      {report && (
        <div className="mt-10 sm:mt-12">
          <NotChecked lines={report.notChecked} />
        </div>
      )}
    </div>
  )
}
