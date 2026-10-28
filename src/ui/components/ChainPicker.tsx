import { type KeyboardEvent, useEffect, useId, useMemo, useState } from "react"
import type { ChainInfo } from "@/data/types"
import { INPUT } from "@/ui/components/common"

const SHOWN = 50

function rootCheckNote(chain: ChainInfo): string | null {
  if (chain.rpcs.length === 0) return "no default RPC"
  if (chain.rootCheck.status === "unsupported") return "storage check not supported"
  if (chain.rootCheck.status === "no-proof-rpc") return "no proof RPC"
  return null
}

function matches(chain: ChainInfo, query: string): boolean {
  const q = query.trim().toLowerCase()
  if (q === "") return true
  return (
    chain.name.toLowerCase().includes(q) ||
    chain.shortName.toLowerCase() === q ||
    chain.shortNameAliases.includes(q) ||
    String(chain.chainId) === q
  )
}

// A searchable chain list (ARIA combobox). `null` means "find the chain automatically".
export function ChainPicker({
  chains,
  value,
  onChange,
  disabled = false,
}: {
  chains: readonly ChainInfo[]
  value: number | null
  onChange: (chainId: number | null) => void
  disabled?: boolean
}) {
  const id = useId()
  const listId = `${id}-list`
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState("")
  const [active, setActive] = useState(0)

  const selected = chains.find((c) => c.chainId === value) ?? null
  const found = useMemo(() => chains.filter((c) => matches(c, query)), [chains, query])
  // Option 0 is "find automatically"; chains follow.
  const options: (ChainInfo | null)[] = [null, ...found.slice(0, SHOWN)]
  const optionId = (index: number) => `${id}-option-${index}`
  // A search with no match has no active option: Enter then changes nothing.
  const current = active < options.length ? active : -1

  // The active option stays in view while the keyboard moves through a long list.
  useEffect(() => {
    if (open && current >= 0) document.getElementById(`${id}-option-${current}`)?.scrollIntoView?.({ block: "nearest" })
  }, [id, open, current])

  const choose = (chain: ChainInfo | null) => {
    onChange(chain?.chainId ?? null)
    setOpen(false)
    setQuery("")
  }

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault()
      if (!open) {
        setOpen(true)
        setActive(0)
        return
      }
      const step = event.key === "ArrowDown" ? 1 : -1
      setActive((Math.max(current, 0) + step + options.length) % options.length)
    } else if (event.key === "Enter" && open) {
      event.preventDefault()
      if (current >= 0) choose(options[current])
    } else if (event.key === "Escape" && open) {
      event.preventDefault()
      setOpen(false)
      setQuery("")
    }
  }

  return (
    <div className="relative flex flex-col gap-2">
      <label htmlFor={id} className="text-sm font-semibold">
        Chain <span className="font-normal text-muted-foreground">(optional, found automatically)</span>
      </label>
      <div className="relative">
        <input
          id={id}
          role="combobox"
          aria-expanded={open}
          aria-controls={listId}
          aria-autocomplete="list"
          aria-activedescendant={open && current >= 0 ? optionId(current) : undefined}
          autoComplete="off"
          spellCheck={false}
          disabled={disabled}
          placeholder="Search by name or chain id"
          value={open ? query : selected ? `${selected.name} (${selected.chainId})` : "Find automatically"}
          onClick={() => {
            setOpen(true)
            setActive(0)
          }}
          onChange={(event) => {
            setQuery(event.target.value)
            setOpen(true)
            setActive(event.target.value.trim() === "" ? 0 : 1)
          }}
          onKeyDown={onKeyDown}
          onBlur={() => {
            setOpen(false)
            setQuery("")
          }}
          className={`${INPUT} h-11 pr-10 text-[15px] sm:pl-4`}
        />
        <svg
          viewBox="0 0 12 8"
          aria-hidden="true"
          className="pointer-events-none absolute top-1/2 right-4 h-2 w-3 -translate-y-1/2 fill-none stroke-muted-foreground"
        >
          <path d="M1 1.5L6 6.5L11 1.5" strokeWidth="1.5" />
        </svg>
      </div>
      {open && (
        <ul
          id={listId}
          role="listbox"
          aria-label="Chains"
          className="absolute top-full right-0 left-0 z-20 mt-1 max-h-72 overflow-auto rounded-md border border-border bg-surface py-1 text-sm"
        >
          {options.map((chain, index) => {
            const note = chain && rootCheckNote(chain)
            return (
              <li
                key={chain?.chainId ?? "auto"}
                id={optionId(index)}
                role="option"
                aria-selected={index === current}
                // Keep focus in the input so the list does not close before the click lands.
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => choose(chain)}
                className={`flex cursor-pointer justify-between gap-2 px-3 py-2 ${index === current ? "bg-subtle" : ""}`}
              >
                {chain ? (
                  <>
                    <span className="min-w-0 truncate">
                      {chain.name} <span className="text-muted-foreground">{chain.chainId}</span>
                    </span>
                    {note && <span className="shrink-0 text-xs text-warn">{note}</span>}
                  </>
                ) : (
                  <span>Find automatically</span>
                )}
              </li>
            )
          })}
          {found.length > SHOWN && (
            <li role="presentation" className="px-3 py-2 text-xs text-muted-foreground">
              {found.length - SHOWN} more; keep typing to narrow the list.
            </li>
          )}
          {found.length === 0 && (
            <li role="presentation" className="px-3 py-2 text-xs text-muted-foreground">
              No chain matches “{query}”.
            </li>
          )}
        </ul>
      )}
    </div>
  )
}
