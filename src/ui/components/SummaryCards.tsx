import type { MouseEvent } from "react"
import type { CardId, SummaryCard, Tone } from "@/core/report"

// Fixed slots, so the grid has the same shape before, during and after a run. Each card leads to the section with its
// details.
const CARD_SLOTS: { id: CardId; label: string; section: string }[] = [
  { id: "version", label: "Version", section: "identity-title" },
  { id: "owners", label: "Owners", section: "owners-title" },
  { id: "modules", label: "Modules", section: "modules-title" },
  { id: "guard", label: "Guard", section: "handlers-title" },
  { id: "moduleGuard", label: "Module guard", section: "handlers-title" },
  { id: "fallbackHandler", label: "Fallback handler", section: "handlers-title" },
  { id: "nonce", label: "Nonce", section: "history-title" },
  { id: "storage", label: "Storage", section: "storage-title" },
]

// A square in the corner says the state; the value only takes the tone's color when something needs a look.
const MARKER: Record<Tone, string | null> = {
  ok: "bg-brand",
  warn: "bg-warn",
  bad: "bg-bad",
  neutral: null,
  unknown: "border border-dashed border-muted-foreground",
}
const VALUE: Record<Tone, string> = {
  ok: "text-foreground",
  warn: "text-warn",
  bad: "text-bad",
  neutral: "text-foreground",
  unknown: "text-muted-foreground",
}

const CARD = "flex h-36 flex-col gap-1 overflow-hidden border border-border-subtle bg-surface px-3.5 py-3 sm:px-4"

// The link keeps the page's own # (it holds the Safe), so it scrolls by hand instead of following the href.
function jump(event: MouseEvent<HTMLAnchorElement>, section: string) {
  event.preventDefault()
  const heading = document.getElementById(section)
  if (!heading) return
  const smooth = !window.matchMedia?.("(prefers-reduced-motion: reduce)").matches
  heading.scrollIntoView?.({ behavior: smooth ? "smooth" : "auto", block: "start" })
  heading.focus({ preventScroll: true })
}

function Body({ card, label }: { card: SummaryCard; label: string }) {
  const marker = MARKER[card.tone]
  return (
    <>
      <span className="flex items-center justify-between gap-2 text-[13px] text-muted-foreground">
        {card.label ?? label}
        {marker && <span aria-hidden="true" className={`size-2 shrink-0 ${marker}`} />}
      </span>
      <span
        className={`line-clamp-2 shrink-0 text-lg leading-6 font-semibold break-words sm:text-xl sm:leading-[26px] ${VALUE[card.tone]}`}
        title={card.value}
      >
        {card.value}
      </span>
      {card.detail && (
        <span
          className="mt-auto line-clamp-2 text-xs break-words text-muted-foreground sm:text-[13px]"
          title={card.detail}
        >
          {card.detail}
        </span>
      )}
    </>
  )
}

export function SummaryCards({ cards }: { cards: readonly SummaryCard[] | null }) {
  return (
    <ul aria-label="Summary" className="grid grid-cols-2 gap-2 sm:grid-cols-4 sm:gap-3">
      {CARD_SLOTS.map((slot) => {
        const card = cards?.find((c) => c.id === slot.id)
        return (
          <li key={slot.id}>
            {card ? (
              <a
                href={`#${slot.section}`}
                onClick={(event) => jump(event, slot.section)}
                className={`${CARD} hover:border-border`}
              >
                <Body card={card} label={slot.label} />
              </a>
            ) : (
              <div className={CARD}>
                <span className="text-[13px] text-muted-foreground">{slot.label}</span>
                {cards ? (
                  <span className="text-muted-foreground">Not reported</span>
                ) : (
                  <span aria-hidden="true" className="mt-1 h-5 w-2/3 bg-subtle motion-safe:animate-pulse" />
                )}
              </div>
            )}
          </li>
        )
      })}
    </ul>
  )
}
