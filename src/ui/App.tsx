import { useEffect, useState } from "react"
import { Checker } from "@/ui/Checker"
import { InputBar } from "@/ui/components/InputBar"
import { DepsContext, loadDeps, type UiDeps } from "@/ui/deps"

function App({ deps: given }: { deps?: UiDeps }) {
  const [deps, setDeps] = useState<UiDeps | null>(given ?? null)
  const [loadError, setLoadError] = useState<string | null>(null)

  useEffect(() => {
    if (given) return
    let live = true
    loadDeps().then(
      (loaded) => live && setDeps(loaded),
      (error: unknown) => live && setLoadError(error instanceof Error ? error.message : String(error)),
    )
    return () => {
      live = false
    }
  }, [given])

  return (
    <main className="mx-auto flex max-w-4xl flex-col gap-4 p-4 font-sans sm:p-6">
      <header>
        <h1 className="text-2xl font-semibold">Safe State Check</h1>
        <p className="text-muted-foreground">
          Checks a deployed Safe for hidden owners, hidden modules and storage its configuration does not explain.
        </p>
      </header>
      {deps ? (
        <DepsContext value={deps}>
          <Checker />
        </DepsContext>
      ) : loadError ? (
        <p role="alert" className="text-bad">
          The app could not load its chain list and checks ({loadError}). Reload the page to try again.
        </p>
      ) : (
        // Same shape as the loaded input bar, so the page does not jump when the chain list arrives.
        <InputBar
          text=""
          onTextChange={() => {}}
          chains={[]}
          chainId={null}
          onChainChange={() => {}}
          error={null}
          chainNote={null}
          settingsOpen={false}
          onToggleSettings={() => {}}
          onSubmit={() => {}}
          disabled
        />
      )}
    </main>
  )
}

export default App
