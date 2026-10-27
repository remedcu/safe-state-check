import { type ReactNode, useId, useState } from "react"
import type { Address, Hex } from "viem"
import { FINDINGS } from "@/core/findings"
import { identificationLabel, SEVERITY_LABEL } from "@/core/markdown"
import type { ChainRef, FindingCode, Identification, Part, Severity, Tone } from "@/core/report"
import { explorerUrl, SEVERITY_TONE, shorten, sourcifyUrl, TONE_CLASSES } from "@/ui/format"

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
      className={`inline-flex items-center rounded border px-1.5 py-0.5 text-xs whitespace-nowrap ${TONE_CLASSES[tone]}`}
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
    <span className="font-mono text-xs whitespace-nowrap" title={address}>
      {url ? (
        <a href={url} target="_blank" rel="noreferrer noopener" className="underline decoration-dotted">
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
          <a href={first.reviewed.url} target="_blank" rel="noreferrer noopener" className="text-xs underline">
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
                className="underline"
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
    <div
      role="region"
      aria-label={label}
      tabIndex={0}
      className="overflow-x-auto rounded border border-border-subtle focus-visible:outline-2 focus-visible:outline-focus"
    >
      <table className="w-full text-left text-sm">{children}</table>
    </div>
  )
}

export const TH = "border-b border-border-subtle bg-subtle px-2 py-1.5 font-medium whitespace-nowrap"
// Cells keep a minimum width; a table wider than the screen scrolls inside its own box instead of squeezing.
export const TD = "min-w-36 border-b border-border-subtle px-2 py-1.5 align-top"

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
    <section aria-labelledby={`${id}-title`} className="flex flex-col gap-2">
      <h2 id={`${id}-title`} className="text-lg font-semibold">
        {title}
        {technical && <span className="text-sm font-normal text-muted-foreground"> {technical}</span>}
      </h2>
      {!part ? (
        <p className="text-muted-foreground">Not part of this run.</p>
      ) : part.state === "unavailable" ? (
        <p className="text-warn">Not available: {part.reason}</p>
      ) : part.state === "skipped" ? (
        <p className="text-muted-foreground">Skipped: {part.reason}</p>
      ) : (
        <>
          {part.state === "partial" && (
            <div className="rounded border border-warn-border bg-warn-surface p-2 text-sm text-warn">
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
        className="text-sm underline decoration-dotted focus-visible:outline-2 focus-visible:outline-focus"
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
