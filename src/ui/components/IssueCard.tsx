import { issueHeadline } from "@/core/markdown"
import type { ReportIssue } from "@/core/report"
import { Badge, BUTTON, Disclosure } from "@/ui/components/common"

// One I/O problem in plain words: who failed at what, why, and what to do. The raw answer sits behind a toggle.
export function IssueCard({ issue, onOpenSettings }: { issue: ReportIssue; onOpenSettings?: () => void }) {
  const raw = issue.raw
  const rows: [string, string | number | null][] = [
    ["URL", raw.url],
    ["Method", raw.method],
    ["Parameters", raw.params],
    ["HTTP status", raw.httpStatus],
    ["RPC error code", raw.rpcCode],
    ["Message", raw.message],
    ["Response body", raw.body],
    ["Time taken", `${raw.elapsedMs} ms`],
    ["Attempts", raw.attempts],
    ["At", raw.at],
  ]
  return (
    <article
      className={`border bg-surface p-4 text-sm ${issue.recovered ? "border-border-subtle" : "border-warn-border"}`}
    >
      <div className="flex flex-wrap items-start justify-between gap-2">
        <p className="font-semibold">{issueHeadline(issue)}</p>
        {issue.recovered && <Badge tone="ok">worked around</Badge>}
      </div>
      <p className="mt-1">{issue.explanation}</p>
      {issue.actions.length > 0 && (
        <div className="mt-2">
          <p className="text-muted-foreground">What you can do:</p>
          <ul className="list-disc pl-5">
            {issue.actions.map((action) => (
              <li key={action}>{action}</li>
            ))}
          </ul>
        </div>
      )}
      {onOpenSettings && issue.service === "rpc" && !issue.recovered && (
        <button type="button" onClick={onOpenSettings} className={`${BUTTON} mt-3`}>
          Open RPC settings
        </button>
      )}
      <Disclosure className="mt-3" label={(open) => (open ? "Hide technical details" : "Technical details")}>
        <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-xs">
          {rows
            .filter(([, value]) => value !== null && value !== "")
            .map(([label, value]) => (
              <div key={label} className="contents">
                <dt className="text-muted-foreground">{label}</dt>
                <dd className="font-mono break-all">{value}</dd>
              </div>
            ))}
        </dl>
      </Disclosure>
    </article>
  )
}

export function IssueList({ issues, onOpenSettings }: { issues: readonly ReportIssue[]; onOpenSettings?: () => void }) {
  return (
    <ul className="flex flex-col gap-2">
      {issues.map((issue, index) => (
        <li key={`${issue.kind}-${issue.host}-${index}`}>
          <IssueCard issue={issue} onOpenSettings={onOpenSettings} />
        </li>
      ))}
    </ul>
  )
}
