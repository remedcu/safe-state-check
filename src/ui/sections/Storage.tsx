import { type FormEvent, useState } from "react"
import { COMPARISON_LABEL, ROOT_MATCH_LABEL, SLOT_SOURCE_LABEL, SLOT_STATUS_LABEL } from "@/core/markdown"
import type { DiagnosisSection, Part, SlotStatus, StorageSection, Tone } from "@/core/report"
import { Badge, BUTTON, HexText, INPUT, Mono, Section, SectionTitle, TableScroll, TD, TH } from "@/ui/components/common"
import { compactWord, failureText } from "@/ui/format"

const STATUS_TONE: Record<SlotStatus, Tone> = {
  expected: "ok",
  benign: "neutral",
  suspicious: "bad",
  unexplained: "bad",
}

const ROOT_ROW =
  "grid grid-cols-1 gap-x-5 gap-y-1.5 border-b border-border-subtle px-4 py-3 last:border-b-0 sm:grid-cols-[14rem_minmax(0,1fr)] sm:items-center"

const ROOT = "font-mono text-[13px] break-all"

export function Storage({ part }: { part: Part<StorageSection> | undefined }) {
  return (
    <Section id="storage" title="Storage" technical="storage root from eth_getProof" part={part}>
      {(storage) => (
        <>
          {storage.support !== "supported" && (
            <p className="rounded-sm border border-warn-border bg-warn-surface px-3 py-2 text-sm text-warn">
              The storage root check did not run: {storage.supportReason}
            </p>
          )}
          <p className="text-sm">
            {storage.formula.text}{" "}
            <span className="text-muted-foreground">
              This count is for reading only; the root comparison below is the check.
            </span>
          </p>
          {/* Each rebuilt root above the proven one, so the two hashes can be read against each other. */}
          <dl className="border border-border-subtle bg-surface text-sm">
            {storage.passes.map((pass, index) => (
              <div key={`${pass.by}-${index}`} className={ROOT_ROW}>
                <dt className="flex flex-col items-start gap-1.5 text-muted-foreground">
                  Rebuilt from {ROOT_MATCH_LABEL[pass.by]} ({pass.slotCount} slots)
                  {pass.match ? <Badge tone="ok">matches</Badge> : <Badge tone="bad">does not match</Badge>}
                </dt>
                <dd className={ROOT}>{pass.expectedRoot}</dd>
              </div>
            ))}
            <div className={ROOT_ROW}>
              <dt className="text-muted-foreground">Actual root (storageHash)</dt>
              <dd className={storage.actualRoot ? ROOT : undefined}>{storage.actualRoot ?? "not read"}</dd>
            </div>
          </dl>
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
    <section aria-labelledby="diagnosis-title" className="flex flex-col gap-4">
      <SectionTitle id="diagnosis-title" title="Diagnosis" technical="why the root does not match" />
      <ol className="border border-border-subtle bg-surface text-sm">
        {diagnosis.steps.map((step) => (
          <li key={step.id} className="border-b border-border-subtle px-4 py-3 last:border-b-0">
            <span className="font-semibold">{DIAGNOSIS_STEP_LABEL[step.id]}</span>: {step.status.replace("-", " ")}.{" "}
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
        <form onSubmit={submit} className="flex flex-col gap-2 text-sm">
          <label htmlFor="candidates">
            Test your own guesses: paste addresses or 32-byte hashes. The tool computes their owner, module, approved
            hash and signed message slots and reads them.
          </label>
          <textarea
            id="candidates"
            value={text}
            onChange={(event) => setText(event.target.value)}
            rows={3}
            className={`${INPUT} p-3 font-mono text-xs`}
          />
          <button type="submit" disabled={busy} className={`${BUTTON} self-start`}>
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
