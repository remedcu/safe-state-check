import { type ReactNode, useId, useState } from "react"
import type { Address, Hex } from "viem"
import { FINDINGS } from "@/core/findings"
import { identificationLabel, SEVERITY_LABEL } from "@/core/markdown"
import type { ChainRef, FindingCode, Identification, Part, Severity, Tone } from "@/core/report"
import { explorerUrl, SEVERITY_TONE, shorten, sourcifyUrl, TONE_CLASSES } from "@/ui/format"

const BUTTON_BASE =
  "inline-flex items-center justify-center gap-2 rounded-md text-sm whitespace-nowrap disabled:cursor-not-allowed disabled:opacity-50 motion-safe:transition-colors"
// The one green action on the page: Check.
export const BUTTON_PRIMARY = `${BUTTON_BASE} h-11 bg-primary px-6 text-[15px] font-semibold text-primary-foreground hover:bg-primary-hover`
// Every other action.
export const BUTTON = `${BUTTON_BASE} h-10 border border-border px-4 hover:border-foreground hover:bg-subtle`
// An action on a tinted verdict panel.
export const BUTTON_ON_TONE = `${BUTTON_BASE} h-10 border border-foreground px-4 text-foreground hover:bg-foreground hover:text-background`
export const INPUT =
  "w-full rounded-md border border-border bg-background px-3 text-sm placeholder:text-muted-foreground disabled:opacity-50 aria-invalid:border-bad"

export function Spinner({ className = "" }: { className?: string }) {
  return (
    <span
      aria-hidden="true"
      className={`inline-block size-3.5 shrink-0 rounded-full border-2 border-current border-t-transparent motion-safe:animate-spin ${className}`}
    />
  )
}

export function Badge({ tone, children, title }: { tone: Tone; children: ReactNode; title?: string }) {
  return (
    <span
      title={title}
      className={`inline-flex min-h-[22px] items-center rounded-sm px-2 text-xs whitespace-nowrap ${TONE_CLASSES[tone]}`}
    >
      {children}
    </span>
  )
}

export function SeverityBadge({ severity }: { severity: Severity }) {
  return (
    <Badge tone={SEVERITY_TONE[severity]}>
      <span className={severity === "critical" ? "font-bold" : undefined}>{SEVERITY_LABEL[severity]}</span>
    </Badge>
  )
}

export function Flags({ flags }: { flags: readonly FindingCode[] }) {
  if (flags.length === 0) return <span className="text-muted-foreground">none</span>
  return (
    <span className="flex flex-wrap gap-1">
      {flags.map((flag) => (
        <Badge key={flag} tone={SEVERITY_TONE[FINDINGS[flag].severity]} title={FINDINGS[flag].explanation}>
          {FINDINGS[flag].title}
        </Badge>
      ))}
    </span>
  )
}

export function Mono({ children, title }: { children: ReactNode; title?: string }) {
  return (
    <span className="font-mono text-xs break-all" title={title}>
      {children}
    </span>
  )
}

export function AddressLink({
  address,
  chain,
  short = false,
}: {
  address: Address
  chain: ChainRef | null
  short?: boolean
}) {
  const url = chain ? explorerUrl(chain, address) : null
  const text = short ? shorten(address) : address
  return (
    // A full address wraps on a narrow screen instead of widening the page.
    <span className={`font-mono text-[13px] ${short ? "whitespace-nowrap" : "wrap-break-word"}`} title={address}>
      {url ? (
        <a
          href={url}
          target="_blank"
          rel="noreferrer noopener"
          className="underline decoration-border underline-offset-[3px] hover:text-brand hover:decoration-brand"
        >
          {text}
        </a>
      ) : (
        text
      )}
    </span>
  )
}

export function HexText({ value }: { value: Hex }) {
  return <Mono title={value}>{value}</Mono>
}

export function IdentificationText({
  identification,
  chain,
  address,
}: {
  identification: Identification | null
  chain: ChainRef | null
  address: Address | null
}) {
  if (!identification) return <span className="text-muted-foreground">not identified</span>
  const [first] = identification.matches
  return (
    <span className="flex flex-col gap-0.5">
      <span className="flex flex-wrap items-center gap-1">
        <span>{identificationLabel(identification)}</span>
        {identification.status === "known" && first && <Badge tone="ok">{first.origin}</Badge>}
        {identification.status === "reviewed" && first?.reviewed && (
          <a
            href={first.reviewed.url}
            target="_blank"
            rel="noreferrer noopener"
            className="text-xs text-brand underline"
          >
            reviewed list, {first.reviewed.on}
          </a>
        )}
        {identification.status === "unknown" && <Badge tone="bad">unknown</Badge>}
      </span>
      {identification.implementation && (
        <span className="text-xs text-muted-foreground">
          minimal proxy to <AddressLink address={identification.implementation} chain={chain} short />
        </span>
      )}
      {identification.status === "unknown" && (
        <span className="text-xs text-muted-foreground">
          code hash <Mono>{identification.codeHash}</Mono>
          {chain && address && (
            <>
              {" "}
              Sourcify: {identification.sourcify}.{" "}
              <a
                href={sourcifyUrl(chain.chainId, address)}
                target="_blank"
                rel="noreferrer noopener"
                className="text-brand underline"
              >
                Look it up
              </a>
            </>
          )}
        </span>
      )}
    </span>
  )
}

// A table that scrolls inside its own box; focusable so keyboard users can scroll it too.
export function TableScroll({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div role="region" aria-label={label} tabIndex={0} className="overflow-x-auto border border-border-subtle">
      <table className="w-full text-left text-sm [&_tbody>tr:last-child>td]:border-b-0">{children}</table>
    </div>
  )
}

export const TH =
  "border-b border-border-subtle bg-surface px-3 py-2.5 text-[13px] font-semibold whitespace-nowrap text-muted-foreground sm:px-4"
// Cells keep a minimum width; a table wider than the screen scrolls inside its own box instead of squeezing.
export const TD = "min-w-36 border-b border-border-subtle px-3 py-3 align-top sm:px-4"

// A section's heading: its name, then the call or source it comes from in mono. The id is what the summary cards
// jump to.
export function SectionTitle({ id, title, technical }: { id: string; title: string; technical?: string }) {
  return (
    <h2
      id={id}
      tabIndex={-1}
      className="flex scroll-mt-6 flex-wrap items-baseline gap-x-3.5 gap-y-1 text-[22px] leading-7 font-semibold focus:outline-none sm:text-2xl"
    >
      {title}
      {technical && (
        <span className="font-mono text-[13px] leading-5 font-normal text-muted-foreground"> {technical}</span>
      )}
    </h2>
  )
}

// A detail section; the states of `Part` render as a note instead of the body.
export function Section<T>({
  id,
  title,
  technical,
  part,
  children,
}: {
  id: string
  title: string
  technical?: string
  part: Part<T> | null | undefined
  children: (data: T) => ReactNode
}) {
  return (
    <section aria-labelledby={`${id}-title`} className="flex flex-col gap-4">
      <SectionTitle id={`${id}-title`} title={title} technical={technical} />
      {!part ? (
        <p className="text-sm text-muted-foreground">Not part of this run.</p>
      ) : part.state === "unavailable" ? (
        <p className="text-sm text-warn">Not available: {part.reason}</p>
      ) : part.state === "skipped" ? (
        <p className="text-sm text-muted-foreground">Skipped: {part.reason}</p>
      ) : (
        <>
          {part.state === "partial" && (
            <div className="rounded-sm border border-warn-border bg-warn-surface px-3 py-2 text-sm text-warn">
              <p>Incomplete:</p>
              <ul className="list-disc pl-5">
                {part.gaps.map((gap) => (
                  <li key={gap}>{gap}</li>
                ))}
              </ul>
            </div>
          )}
          {children(part.data)}
        </>
      )}
    </section>
  )
}

// A button that shows and hides the block after it.
export function Disclosure({
  label,
  children,
  className = "",
}: {
  label: (open: boolean) => string
  children: ReactNode
  className?: string
}) {
  const [open, setOpen] = useState(false)
  const id = useId()
  return (
    <div className={className}>
      <button
        type="button"
        aria-expanded={open}
        aria-controls={id}
        onClick={() => setOpen(!open)}
        className="text-sm text-muted-foreground underline decoration-dotted underline-offset-4 hover:text-foreground"
      >
        {label(open)}
      </button>
      {open && (
        <div id={id} className="mt-1">
          {children}
        </div>
      )}
    </div>
  )
}
