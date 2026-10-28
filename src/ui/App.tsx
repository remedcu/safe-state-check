import { useEffect, useState } from "react"
import { Checker } from "@/ui/Checker"
import { InputBar } from "@/ui/components/InputBar"
import { Hero } from "@/ui/components/Intro"
import { PAGE, SiteHeader } from "@/ui/components/Site"
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
    <div className="flex min-h-dvh flex-col">
      <SiteHeader />
      {deps ? (
        <DepsContext value={deps}>
          <Checker />
        </DepsContext>
      ) : (
        <main className={`${PAGE} flex flex-col gap-4 pt-6 sm:pt-8`}>
          {/* A link that names a Safe starts a run, which shows no intro; the page must not jump when it loads. */}
          {!window.location.hash.startsWith("#/") && <Hero />}
          {loadError ? (
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
      )}
    </div>
  )
}

export default App
