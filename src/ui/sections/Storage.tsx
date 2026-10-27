import { type FormEvent, useState } from "react"
import { COMPARISON_LABEL, ROOT_MATCH_LABEL, SLOT_SOURCE_LABEL, SLOT_STATUS_LABEL } from "@/core/markdown"
import type { DiagnosisSection, Part, SlotStatus, StorageSection, Tone } from "@/core/report"
import { Badge, HexText, Mono, Section, TableScroll, TD, TH } from "@/ui/components/common"
import { compactWord, failureText } from "@/ui/format"

const STATUS_TONE: Record<SlotStatus, Tone> = {
  expected: "ok",
  benign: "neutral",
  suspicious: "bad",
  unexplained: "bad",
}

export function Storage({ part }: { part: Part<StorageSection> | undefined }) {
  return (
    <Section id="storage" title="Storage" technical="storage root from eth_getProof" part={part}>
      {(storage) => (
        <>
          {storage.support !== "supported" && (
            <p className="rounded border border-warn-border bg-warn-surface p-2 text-sm text-warn">
              The storage root check did not run: {storage.supportReason}
            </p>
          )}
          <p className="text-sm">
            {storage.formula.text}{" "}
            <span className="text-muted-foreground">
              This count is for reading only; the root comparison below is the check.
            </span>
          </p>
          {storage.passes.length > 0 && (
            <ul className="flex flex-col gap-1 text-sm">
              {storage.passes.map((pass, index) => (
                <li
                  key={`${pass.by}-${index}`}
                  className="flex flex-col gap-0.5 rounded border border-border-subtle p-2"
                >
                  <span className="flex flex-wrap items-center gap-2">
                    Rebuilt from {ROOT_MATCH_LABEL[pass.by]} ({pass.slotCount} slots):
                    {pass.match ? <Badge tone="ok">matches</Badge> : <Badge tone="bad">does not match</Badge>}
                  </span>
                  <span className="text-xs text-muted-foreground">
                    expected root <HexText value={pass.expectedRoot} />
                  </span>
                </li>
              ))}
            </ul>
          )}
          <p className="text-xs text-muted-foreground">
            Actual root (storageHash): {storage.actualRoot ? <HexText value={storage.actualRoot} /> : "not read"}
          </p>
          <TableScroll label="Storage slots">
            <thead>
              <tr>
                <th className={TH}>Meaning</th>
                <th className={TH}>Key</th>
                <th className={TH}>Value (leading zeros dropped)</th>
                <th className={TH}>Source</th>
                <th className={TH}>Status</th>
              </tr>
            </thead>
            <tbody>
              {storage.slots.map((row) => (
                <tr key={row.key}>
                  <td className={TD}>
                    {row.meaning}
                    <span className="block font-mono text-xs text-muted-foreground">{row.technical}</span>
                  </td>
                  <td className={`${TD} min-w-64`}>
                    <HexText value={row.key} />
                  </td>
                  <td className={`${TD} min-w-64`}>
                    <Mono title={row.value}>{compactWord(row.value)}</Mono>
                  </td>
                  <td className={TD}>{SLOT_SOURCE_LABEL[row.source]}</td>
                  <td className={TD}>
                    <span className="flex flex-col items-start gap-0.5">
                      <Badge tone={STATUS_TONE[row.status]}>{SLOT_STATUS_LABEL[row.status]}</Badge>
                      {!row.proven && <span className="text-xs text-warn">not proven</span>}
                      <span className="text-xs whitespace-nowrap text-muted-foreground">
                        cross-check: {COMPARISON_LABEL[row.cross]}
                      </span>
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </TableScroll>
        </>
      )}
    </Section>
  )
}

const DIAGNOSIS_STEP_LABEL: Record<DiagnosisSection["steps"][number]["id"], string> = {
  events: "Add slots from approved hashes and signed messages",
  enumeration: "List every slot through the RPC (debug_storageRangeAt)",
  traces: "Trace the Safe's transactions (prestateTracer)",
  candidates: "Your candidates",
}

export function Diagnosis({
  diagnosis,
  onTestCandidates,
}: {
  diagnosis: DiagnosisSection
  onTestCandidates?: (candidates: string[]) => Promise<void>
}) {
  const [text, setText] = useState("")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    const candidates = text.split(/[\s,]+/).filter(Boolean)
    if (!onTestCandidates || candidates.length === 0) return
    setBusy(true)
    setError(null)
    try {
      await onTestCandidates(candidates)
    } catch (failure) {
      setError(failureText(failure))
    } finally {
      setBusy(false)
    }
  }

  return (
    <section aria-labelledby="diagnosis-title" className="flex flex-col gap-2">
      <h2 id="diagnosis-title" className="text-lg font-semibold">
        Diagnosis
        <span className="text-sm font-normal text-muted-foreground"> why the root does not match</span>
      </h2>
      <ol className="flex flex-col gap-1 text-sm">
        {diagnosis.steps.map((step) => (
          <li key={step.id} className="rounded border border-border-subtle p-2">
            <span className="font-medium">{DIAGNOSIS_STEP_LABEL[step.id]}</span>: {step.status.replace("-", " ")}.{" "}
            {step.detail}
            {step.missing.length > 0 && (
              <span className="block text-xs text-muted-foreground">
                Missing RPC capability: {step.missing.join(", ")}
              </span>
            )}
          </li>
        ))}
      </ol>
      {diagnosis.unexplained.length > 0 && (
        <TableScroll label="Unexplained slots">
          <thead>
            <tr>
              <th className={TH}>Key</th>
              <th className={TH}>Value</th>
            </tr>
          </thead>
          <tbody>
            {diagnosis.unexplained.map((row) => (
              <tr key={row.key}>
                <td className={TD}>
                  <HexText value={row.key} />
                </td>
                <td className={TD}>
                  <HexText value={row.value} />
                </td>
              </tr>
            ))}
          </tbody>
        </TableScroll>
      )}
      {onTestCandidates && (
        <form onSubmit={submit} className="flex flex-col gap-1 text-sm">
          <label htmlFor="candidates">
            Test your own guesses: paste addresses or 32-byte hashes. The tool computes their owner, module, approved
            hash and signed message slots and reads them.
          </label>
          <textarea
            id="candidates"
            value={text}
            onChange={(event) => setText(event.target.value)}
            rows={3}
            className="rounded border border-border bg-surface p-2 font-mono text-xs focus-visible:outline-2 focus-visible:outline-focus"
          />
          <button
            type="submit"
            disabled={busy}
            className="self-start rounded border border-border px-3 py-1.5 hover:bg-subtle disabled:opacity-50 focus-visible:outline-2 focus-visible:outline-focus"
          >
            {busy ? "Testing…" : "Test candidates"}
          </button>
          {error && (
            <p role="alert" className="text-sm text-bad">
              Testing the candidates failed. {error}
            </p>
          )}
          {diagnosis.candidatesTried.length > 0 && (
            <p className="text-xs text-muted-foreground">Tried so far: {diagnosis.candidatesTried.join(", ")}</p>
          )}
        </form>
      )}
    </section>
  )
}
