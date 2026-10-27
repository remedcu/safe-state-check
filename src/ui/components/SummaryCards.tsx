import type { CardId, SummaryCard } from "@/core/report"
import { TONE_CLASSES } from "@/ui/format"

// Fixed slots, so the grid has the same shape before, during and after a run.
const CARD_SLOTS: { id: CardId; label: string }[] = [
  { id: "version", label: "Version" },
  { id: "owners", label: "Owners" },
  { id: "modules", label: "Modules" },
  { id: "guard", label: "Guard" },
  { id: "moduleGuard", label: "Module guard" },
  { id: "fallbackHandler", label: "Fallback handler" },
  { id: "nonce", label: "Nonce" },
  { id: "storage", label: "Storage" },
]

export function SummaryCards({ cards }: { cards: readonly SummaryCard[] | null }) {
  return (
    <ul aria-label="Summary" className="grid grid-cols-2 gap-2 sm:grid-cols-4">
      {CARD_SLOTS.map((slot) => {
        const card = cards?.find((c) => c.id === slot.id)
        return (
          <li
            key={slot.id}
            className={`flex h-32 flex-col overflow-hidden rounded border p-2 ${TONE_CLASSES[card?.tone ?? "neutral"]}`}
          >
            <span className="text-xs text-muted-foreground">{card?.label ?? slot.label}</span>
            {card ? (
              <>
                <span className="line-clamp-2 font-semibold break-words" title={card.value}>
                  {card.value}
                </span>
                {card.detail && (
                  <span className="mt-auto line-clamp-3 text-xs break-words text-foreground" title={card.detail}>
                    {card.detail}
                  </span>
                )}
              </>
            ) : cards ? (
              <span className="text-muted-foreground">Not reported</span>
            ) : (
              <span aria-hidden="true" className="mt-1 h-5 w-2/3 rounded bg-subtle motion-safe:animate-pulse" />
            )}
          </li>
        )
      })}
    </ul>
  )
}
