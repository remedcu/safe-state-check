import { type FormEvent, type ReactNode, useId } from "react"
import type { ChainInfo } from "@/data/types"
import { ChainPicker } from "@/ui/components/ChainPicker"

const BUTTON =
  "rounded border px-4 py-1.5 text-sm font-medium focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus disabled:opacity-50"

// The address is the only required input; the chain is found when it is not given.
export function InputBar({
  text,
  onTextChange,
  chains,
  chainId,
  onChainChange,
  error,
  chainNote,
  settingsOpen,
  onToggleSettings,
  onSubmit,
  disabled = false,
}: {
  text: string
  onTextChange: (text: string) => void
  chains: readonly ChainInfo[]
  chainId: number | null
  onChainChange: (chainId: number | null) => void
  error: string | null
  chainNote: ReactNode
  settingsOpen: boolean
  onToggleSettings: () => void
  onSubmit: () => void
  disabled?: boolean
}) {
  const id = useId()
  const submit = (event: FormEvent) => {
    event.preventDefault()
    onSubmit()
  }
  return (
    <form
      onSubmit={submit}
      aria-label="Check a Safe"
      className="flex flex-col gap-3 rounded-lg border border-border-subtle bg-surface p-3"
    >
      <div className="flex flex-col gap-1">
        <label htmlFor={id} className="text-sm font-medium">
          Safe address
        </label>
        <input
          id={id}
          value={text}
          onChange={(event) => onTextChange(event.target.value)}
          disabled={disabled}
          autoComplete="off"
          spellCheck={false}
          placeholder="0x…"
          aria-invalid={error ? true : undefined}
          aria-describedby={`${id}-help ${id}-error`}
          className="w-full rounded border border-border bg-background px-2 py-2 font-mono text-sm focus-visible:outline-2 focus-visible:outline-focus disabled:opacity-50"
        />
        <p id={`${id}-help`} className="text-xs text-muted-foreground">
          A bare address, eth:0x…, a Safe{"{"}Wallet{"}"} link, or a link from this site.
        </p>
        {error && (
          <p id={`${id}-error`} role="alert" className="text-sm text-bad">
            {error}
          </p>
        )}
      </div>
      <div className="flex flex-wrap items-end gap-2">
        <div className="min-w-0 flex-1 basis-56">
          <ChainPicker chains={chains} value={chainId} onChange={onChainChange} disabled={disabled} />
        </div>
        <button
          type="submit"
          // When the run ends, focus moves from here to the result.
          data-run-control=""
          disabled={disabled}
          className={`${BUTTON} border-primary bg-primary text-primary-foreground hover:bg-primary-hover`}
        >
          Check
        </button>
        <button
          type="button"
          aria-expanded={settingsOpen}
          aria-controls="settings-panel"
          onClick={onToggleSettings}
          disabled={disabled}
          className={`${BUTTON} border-border hover:bg-subtle`}
        >
          Settings
        </button>
      </div>
      {chainNote}
    </form>
  )
}
