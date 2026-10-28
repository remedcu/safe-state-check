import { useState } from "react"
import { reportToMarkdown } from "@/core/markdown"
import type { Report } from "@/core/report"
import { BUTTON, INPUT } from "@/ui/components/common"

function download(report: Report, partial: boolean) {
  const blob = new Blob([JSON.stringify(report, null, 2)], { type: "application/json" })
  const url = URL.createObjectURL(blob)
  const link = document.createElement("a")
  link.href = url
  const suffix = partial ? "-partial" : ""
  link.download = `safe-state-check-${report.chain.chainId}-${report.request.address}-${report.verification.anchor.number}${suffix}.json`
  link.click()
  setTimeout(() => URL.revokeObjectURL(url), 0)
}

// Download the JSON report and copy the Markdown summary. Both stay disabled until the run has a report, or a partial
// one from a stopped run, which both label as partial.
export function ReportActions({
  report,
  partial,
  notes,
}: {
  report: Report | null
  partial: boolean
  notes: readonly string[]
}) {
  // Tied to the report it was made from, so a later report (after testing candidates) never reads as copied.
  const [copy, setCopy] = useState<{ state: "copied" | "failed"; text: string; report: Report } | null>(null)
  const current = copy && copy.report === report ? copy : null

  const copyMarkdown = async (report: Report) => {
    const text = reportToMarkdown(report, { partial, notes })
    try {
      await navigator.clipboard.writeText(text)
      setCopy({ state: "copied", text, report })
    } catch {
      setCopy({ state: "failed", text, report })
    }
  }

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap gap-2">
        <button type="button" className={BUTTON} disabled={!report} onClick={() => report && download(report, partial)}>
          Download JSON report
        </button>
        <button type="button" className={BUTTON} disabled={!report} onClick={() => report && copyMarkdown(report)}>
          {current?.state === "copied" ? "Markdown copied" : "Copy Markdown summary"}
        </button>
      </div>
      {current?.state === "failed" && (
        <label className="flex flex-col gap-1 text-sm">
          The browser did not allow copying. Select the text below and copy it yourself.
          <textarea
            readOnly
            value={current.text}
            rows={8}
            className={`${INPUT} p-3 font-mono text-xs`}
            onFocus={(event) => event.currentTarget.select()}
          />
        </label>
      )}
    </div>
  )
}
