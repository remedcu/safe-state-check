import { BUTTON, Spinner } from "@/ui/components/common"
import { IssueList } from "@/ui/components/IssueCard"
import type { Detection } from "@/ui/run"

// Finding the chain when the input names none: progress, then a pick when several chains match, or the next step when
// none does.
export function DetectPanel({
  detection,
  chainName,
  allCount,
  onPick,
  onSearchAll,
  onStop,
}: {
  detection: Detection
  chainName: (chainId: number) => string
  // How many chains "Search all chains" would ask, for the consent line.
  allCount: number
  onPick: (chainId: number) => void
  onSearchAll: () => void
  onStop: () => void
}) {
  const { results, done, scope, error } = detection
  const safes = results.filter((r) => r.status === "safe")
  const contracts = results.filter((r) => r.status === "contract")
  const failed = results.filter((r) => r.status === "error")
  const where = scope === "popular" ? "the most used chains" : "every chain with a default RPC"

  return (
    <section
      aria-labelledby="detect-title"
      className="mt-6 flex flex-col gap-3 border border-border-subtle bg-surface p-4 sm:mt-8 sm:p-6"
    >
      <div className="flex items-start justify-between gap-3">
        <h2 id="detect-title" className="flex items-center gap-2.5 text-xl font-semibold">
          {!done && <Spinner />}
          {done ? "Chain search finished" : `Looking for this Safe on ${where}`}
        </h2>
        {!done && (
          <button type="button" className={BUTTON} onClick={onStop}>
            Stop
          </button>
        )}
      </div>
      <p role="status" className="text-sm text-muted-foreground">
        {results.length} chains checked{done ? "." : " so far…"}
      </p>
      {error && (
        <p role="alert" className="text-sm text-warn">
          The search ended before every chain answered. {error}
        </p>
      )}
      {/* One match runs straight away; it only stays here when the search ended early. */}
      {done && safes.length > 0 && (
        <div className="flex flex-col gap-2">
          <p>
            This address is a Safe on {safes.length === 1 ? "1 chain" : `${safes.length} chains`}. Which one do you want
            to check?
          </p>
          <div className="flex flex-wrap gap-2">
            {safes.map((r) => (
              <button key={r.chainId} type="button" className={BUTTON} onClick={() => onPick(r.chainId)}>
                {chainName(r.chainId)}
                {r.version ? ` (Safe ${r.version})` : ""}
              </button>
            ))}
          </div>
        </div>
      )}
      {done && safes.length === 0 && (
        <div className="flex flex-col gap-2">
          <p>
            No Safe at this address on the {results.length} chains tried.
            {contracts.length > 0 &&
              ` It is a contract, but not a known Safe, on ${contracts.map((r) => chainName(r.chainId)).join(", ")}.`}
          </p>
          <p className="text-sm">Pick the chain above, or search every chain.</p>
          {scope === "popular" && (
            <div className="flex flex-col items-start gap-1">
              <button type="button" className={BUTTON} onClick={onSearchAll}>
                Search all chains
              </button>
              <p className="text-xs text-muted-foreground">
                This sends the address to the default RPC of all {allCount} chains that have one.
              </p>
            </div>
          )}
        </div>
      )}
      {failed.length > 0 && (
        <details className="text-sm">
          <summary className="mb-2 cursor-pointer text-muted-foreground hover:text-foreground">
            {failed.length} chains could not be checked
          </summary>
          <IssueList issues={failed.flatMap((r) => (r.issue ? [r.issue] : []))} />
        </details>
      )}
    </section>
  )
}
