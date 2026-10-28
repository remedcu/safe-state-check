import { useState } from "react"
import { AGREEMENT_LABEL, COMPARISON_LABEL, PINNED_BY_LABEL, utcTime, visibleIssues } from "@/core/markdown"
import type { CrossChainSection, EndpointRef, Part, Report, StepRecord } from "@/core/report"
import { Badge, BUTTON, HexText, Section, SectionTitle, TableScroll, TD, TH } from "@/ui/components/common"
import { IssueList } from "@/ui/components/IssueCard"
import { failureText, STEP_STATUS_LABEL } from "@/ui/format"

function Endpoint({ endpoint }: { endpoint: EndpointRef }) {
  return (
    <span>
      {endpoint.host}{" "}
      <span className="text-muted-foreground">
        ({endpoint.operatorName}, {endpoint.origin === "user" ? "entered by you" : "default"}
        {endpoint.aggregator ? ", forwards to other nodes" : ""})
      </span>
    </span>
  )
}

export function Verification({
  report,
  steps,
  onOpenSettings,
}: {
  report: Report
  steps: readonly StepRecord[]
  onOpenSettings: () => void
}) {
  const v = report.verification
  const issues = visibleIssues(report.issues)
  return (
    <section aria-labelledby="verification-title" className="flex flex-col gap-4">
      <SectionTitle id="verification-title" title="Verification" technical="block, RPCs and proofs" />
      {report.verdict.unverified.length > 0 && (
        <div className="rounded-sm border border-warn-border bg-warn-surface px-3 py-2 text-sm text-warn">
          <p className="font-semibold">Why this could not be verified:</p>
          <ul className="list-disc pl-5">
            {report.verdict.unverified.map((u) => (
              <li key={u.reason}>{u.detail}</li>
            ))}
          </ul>
        </div>
      )}
      <dl className="grid grid-cols-1 gap-x-6 gap-y-1 text-sm sm:grid-cols-[auto_1fr] sm:gap-y-2.5">
        <dt className="text-muted-foreground">Block</dt>
        <dd>
          {v.anchor.number}, {utcTime(v.anchor.timestamp)}, pinned to {PINNED_BY_LABEL[v.anchor.pinnedBy]}.
          {v.anchor.note && <span className="block">{v.anchor.note}</span>}
        </dd>
        <dt className="text-muted-foreground">Block hash</dt>
        <dd>
          <HexText value={v.anchor.hash} />
        </dd>
        <dt className="text-muted-foreground">State root</dt>
        <dd>
          <HexText value={v.anchor.stateRoot} />
        </dd>
        <dt className="text-muted-foreground">Primary RPC</dt>
        <dd>
          <Endpoint endpoint={v.primary} />
        </dd>
        <dt className="text-muted-foreground">Cross-check RPC</dt>
        <dd>
          {v.crossCheck ? <Endpoint endpoint={v.crossCheck} /> : <span className="text-warn">none</span>}
          {v.crossCheckMissing && <span className="block text-warn">{v.crossCheckMissing}</span>}
        </dd>
        <dt className="text-muted-foreground">Agreement</dt>
        <dd className={v.agreement === "agreed" ? undefined : "text-warn"}>{AGREEMENT_LABEL[v.agreement]}</dd>
        <dt className="text-muted-foreground">Proofs</dt>
        <dd>
          {v.proofs.accounts} accounts and {v.proofs.slots} storage slots,{" "}
          {v.proofs.allVerified ? <Badge tone="ok">all verified</Badge> : <Badge tone="warn">not all verified</Badge>}
          {v.proofs.servedBy.length > 0 && <span className="block">served by {v.proofs.servedBy.join(", ")}</span>}
          {v.proofs.blocks.length > 1 && <span className="block">at blocks {v.proofs.blocks.join(", ")}</span>}
        </dd>
        <dt className="text-muted-foreground">Reorg check</dt>
        <dd>
          {v.reorg === "unchanged"
            ? "The block was still the same at the end."
            : v.reorg === "restarted"
              ? "The block changed once; the check ran again."
              : "Not run."}
        </dd>
      </dl>
      <TableScroll label="What the cross-check RPC compared">
        <thead>
          <tr>
            <th className={TH}>Compared</th>
            <th className={TH}>Result</th>
          </tr>
        </thead>
        <tbody>
          {(
            [
              ["Block header", v.coverage.header],
              ["Storage root", v.coverage.storageRoot],
              ["Slot values", v.coverage.slotValues],
              ["Contract calls", v.coverage.calls],
            ] as const
          ).map(([label, value]) => (
            <tr key={label}>
              <td className={TD}>{label}</td>
              <td className={TD}>{COMPARISON_LABEL[value]}</td>
            </tr>
          ))}
        </tbody>
      </TableScroll>
      {v.capabilities.length > 0 && (
        <TableScroll label="RPC capabilities">
          <thead>
            <tr>
              <th className={TH}>RPC</th>
              <th className={TH}>Has</th>
              <th className={TH}>Lacks</th>
            </tr>
          </thead>
          <tbody>
            {v.capabilities.map((c) => (
              <tr key={c.host}>
                <td className={TD}>{c.host}</td>
                <td className={`${TD} font-mono text-xs`}>{c.available.join(", ") || "none"}</td>
                <td className={`${TD} font-mono text-xs`}>{c.missing.join(", ") || "none"}</td>
              </tr>
            ))}
          </tbody>
        </TableScroll>
      )}
      <StepsTable steps={steps} />
      <h3 className="mt-2 text-lg font-semibold">Problems during the run</h3>
      {issues.length === 0 ? (
        <p className="text-sm">None.</p>
      ) : (
        <IssueList issues={issues} onOpenSettings={onOpenSettings} />
      )}
    </section>
  )
}

export function StepsTable({ steps }: { steps: readonly StepRecord[] }) {
  return (
    <TableScroll label="Steps">
      <thead>
        <tr>
          <th className={TH}>Step</th>
          <th className={TH}>Result</th>
          <th className={TH}>Note</th>
        </tr>
      </thead>
      <tbody>
        {steps.map((step) => (
          <tr key={step.id}>
            <td className={TD}>{step.label}</td>
            <td className={TD}>{STEP_STATUS_LABEL[step.status]}</td>
            <td className={TD}>{step.note ?? ""}</td>
          </tr>
        ))}
      </tbody>
    </TableScroll>
  )
}

function OtherChainsTable({ chains }: CrossChainSection) {
  return (
    <TableScroll label="Other chains">
      <thead>
        <tr>
          <th className={TH}>Chain</th>
          <th className={TH}>Found</th>
          <th className={TH}>Same owners</th>
        </tr>
      </thead>
      <tbody>
        {chains.map((c) => (
          <tr key={c.chainId}>
            <td className={TD}>
              {c.name} ({c.chainId})
            </td>
            <td className={TD}>
              {c.status}
              {c.note && <span className="block text-xs text-muted-foreground">{c.note}</span>}
            </td>
            <td className={TD}>{c.ownersMatch === null ? "not read" : c.ownersMatch ? "yes" : "no"}</td>
          </tr>
        ))}
      </tbody>
    </TableScroll>
  )
}

// The same address can hold a different Safe (or nothing yet) on other chains. Looking costs a request per chain and
// sends the address to every chain's default RPC, so it runs only on a click.
export function CrossChain({ part, onCheck }: { part: Part<CrossChainSection> | null; onCheck?: () => Promise<void> }) {
  const [state, setState] = useState<{ busy: boolean; error: string | null }>({ busy: false, error: null })
  if (part) {
    return (
      <Section id="cross-chain" title="Same address on other chains" part={part}>
        {(data) => <OtherChainsTable {...data} />}
      </Section>
    )
  }
  const check = async () => {
    if (!onCheck) return
    setState({ busy: true, error: null })
    try {
      await onCheck()
      setState({ busy: false, error: null })
    } catch (error) {
      setState({ busy: false, error: failureText(error) })
    }
  }
  return (
    <section aria-labelledby="cross-chain-title" className="flex flex-col gap-4">
      <SectionTitle id="cross-chain-title" title="Same address on other chains" />
      <p className="text-sm">
        Someone can deploy a Safe at this address on another chain with other owners. Checking sends the address to the
        default RPC of every chain that has one.
      </p>
      <button type="button" disabled={state.busy} onClick={check} className={`${BUTTON} self-start`}>
        {state.busy ? "Checking other chains…" : "Check other chains"}
      </button>
      {state.error && (
        <p role="alert" className="text-sm text-bad">
          {state.error}
        </p>
      )}
    </section>
  )
}

export function NotChecked({ lines }: { lines: readonly string[] }) {
  return (
    <section
      aria-labelledby="not-checked-title"
      className="flex flex-col gap-3 border border-border-subtle bg-surface p-5 sm:p-6"
    >
      <h2 id="not-checked-title" className="text-xl font-semibold">
        What this does not check
      </h2>
      <ul className="text-sm leading-[21px]">
        {lines.map((line) => (
          <li
            key={line}
            className="relative border-t border-border-subtle py-2.5 pl-5 before:absolute before:left-0 before:text-border before:content-['-'] last:pb-0"
          >
            {line}
          </li>
        ))}
      </ul>
    </section>
  )
}
