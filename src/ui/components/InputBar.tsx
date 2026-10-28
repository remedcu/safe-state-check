import { type FormEvent, type ReactNode, useId } from "react"
import type { ChainInfo } from "@/data/types"
import { ChainPicker } from "@/ui/components/ChainPicker"
import { BUTTON, BUTTON_PRIMARY, INPUT } from "@/ui/components/common"

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
      className="flex flex-col gap-4 border border-border-subtle bg-surface p-4 sm:gap-5 sm:p-6"
    >
      <div className="flex flex-col gap-2">
        <label htmlFor={id} className="text-sm font-semibold">
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
          // Small enough on a 390 px phone that a whole address fits.
          className={`${INPUT} h-12 font-mono text-[11.5px] sm:px-4 sm:text-[15px]`}
        />
        <p id={`${id}-help`} className="text-[13px] leading-[18px] text-muted-foreground">
          A bare address, eth:0x…, a Safe{"{"}Wallet{"}"} link, or a link from this site.
        </p>
        {error && (
          <p id={`${id}-error`} role="alert" className="text-sm text-bad">
            {error}
          </p>
        )}
      </div>
      <div className="flex flex-wrap items-end gap-3">
        <div className="min-w-0 flex-1 basis-64">
          <ChainPicker chains={chains} value={chainId} onChange={onChainChange} disabled={disabled} />
        </div>
        <div className="flex gap-3 max-sm:w-full">
          <button
            type="submit"
            // When the run ends, focus moves from here to the result.
            data-run-control=""
            disabled={disabled}
            className={`${BUTTON_PRIMARY} max-sm:flex-1`}
          >
            Check
          </button>
          <button
            type="button"
            aria-expanded={settingsOpen}
            aria-controls="settings-panel"
            onClick={onToggleSettings}
            disabled={disabled}
            className={`${BUTTON} h-11`}
          >
            Settings
          </button>
        </div>
      </div>
      {chainNote}
    </form>
  )
}
