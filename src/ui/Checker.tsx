import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react"
import type { Address } from "viem"
import type { CheckRequest, Report } from "@/core/report"
import { chainSettings } from "@/data/settings"
import type { ChainInfo, Settings } from "@/data/types"
import { chainRef } from "@/core/steps"
import { DetectPanel } from "@/ui/components/DetectPanel"
import { InputBar } from "@/ui/components/InputBar"
import { PrivacyNote } from "@/ui/components/PrivacyNote"
import { RunView } from "@/ui/components/RunView"
import { SettingsPanel } from "@/ui/components/SettingsPanel"
import { type UiDeps, useDeps } from "@/ui/deps"
import { failureText } from "@/ui/format"
import { type Flow, reduceFlow, startRun } from "@/ui/run"

type Initial = { request: CheckRequest; text: string; chainId: number; block: string }

function refFor(deps: UiDeps, chainId: number) {
  const chain = deps.getChain(chainId)
  return chain ? chainRef(chain) : null
}

// A permalink in the hash starts a run straight away, without chain detection.
function fromHash(deps: UiDeps, hash: string): Initial | null {
  if (!hash.startsWith("#/")) return null
  const parsed = deps.parseInput(hash)
  if (!parsed.ok || parsed.input.chainId === null) return null
  const block = parsed.input.block === null ? null : parsed.input.block.toString()
  const { address, chainId } = parsed.input
  return { request: { address, chainId, block }, text: address, chainId, block: block ?? "" }
}

function ChainNote({
  chain,
  settings,
  onOpenSettings,
}: {
  chain: ChainInfo
  settings: Settings
  onOpenSettings: () => void
}) {
  const own = chainSettings(settings, chain.chainId).primary
  let text: string | null = null
  if (chain.rpcs.length === 0 && !own) {
    text = `No public RPC that we tested works for ${chain.name}. Add your own RPC in the settings to check a Safe on it.`
  } else if (chain.rootCheck.status === "unsupported") {
    text = `${chain.name} does not serve standard Ethereum storage proofs (${chain.rootCheck.reason}). The storage root check cannot run there; the other checks still do.`
  } else if (chain.rootCheck.status === "no-proof-rpc" && !own) {
    text = `The default RPCs for ${chain.name} do not serve storage proofs, so the storage cannot be verified. Add an RPC that serves eth_getProof for recent blocks.`
  }
  if (!text) return null
  return (
    <div className="flex flex-wrap items-center gap-2 rounded border border-warn-border bg-warn-surface p-2 text-sm text-warn">
      <p className="min-w-0 flex-1">{text}</p>
      <button type="button" onClick={onOpenSettings} className="rounded border border-current px-2 py-1">
        Open settings
      </button>
    </div>
  )
}

export function Checker() {
  const deps = useDeps()
  const chains = useMemo(() => deps.listChains(), [deps])
  const [initial] = useState(() => fromHash(deps, window.location.hash))
  const [text, setText] = useState(initial?.text ?? "")
  const [chainId, setChainId] = useState<number | null>(initial?.chainId ?? null)
  const [block, setBlock] = useState(initial?.block ?? "")
  const [settings, setSettings] = useState(() => deps.loadSettings())
  const [settingsOpen, setSettingsOpen] = useState(false)
  // Bumped by every "open the settings" request, so the drawer scrolls into view and takes focus each time.
  const [settingsFocus, setSettingsFocus] = useState(0)
  const [inputError, setInputError] = useState<string | null>(null)
  const [flow, dispatch] = useReducer(reduceFlow, initial, (first): Flow =>
    first
      ? { kind: "run", id: 1, run: startRun(first.request, refFor(deps, first.request.chainId)) }
      : { kind: "idle" },
  )
  const settingsRef = useRef(settings)
  // The RPCs the user had set for the run's chain when it started, to say later if one was not used.
  const [runRpcs, setRunRpcs] = useState(() => (initial ? chainSettings(settings, initial.chainId) : null))
  // One controller for whatever runs now: a check, a chain search, a candidate test or the other-chains look.
  const controller = useRef<AbortController | null>(null)
  const lastId = useRef(1)

  const takeOver = () => {
    controller.current?.abort()
    const own = new AbortController()
    controller.current = own
    return own
  }

  const launch = useCallback(
    (request: CheckRequest, id: number) => {
      controller.current?.abort()
      const own = new AbortController()
      controller.current = own
      deps
        .startCheck(
          request,
          settingsRef.current,
          (event) => {
            if (!own.signal.aborted) dispatch({ type: "event", id, event })
          },
          own.signal,
        )
        .then((report) => {
          if (report && !own.signal.aborted) {
            const block = request.block === null ? null : BigInt(request.block)
            window.history.replaceState(null, "", deps.permalink(request.chainId, request.address, block))
          }
        })
        .catch((error: unknown) => {
          // Runs share an id across a StrictMode relaunch and a stop, so the signal decides, not the id.
          if (own.signal.aborted) return
          const message = error instanceof Error ? error.message : String(error)
          dispatch({ type: "crashed", id, message: `The check failed unexpectedly: ${message}. This is a bug.` })
        })
    },
    [deps],
  )

  const begin = useCallback(
    (request: CheckRequest) => {
      const id = ++lastId.current
      setRunRpcs(chainSettings(settingsRef.current, request.chainId))
      dispatch({ type: "run", id, request, chain: refFor(deps, request.chainId) })
      launch(request, id)
    },
    [deps, launch],
  )

  // The run a permalink asked for; the initial state already shows it, so the first paint does not jump.
  // Leaving the page stops whatever is still going.
  useEffect(() => {
    if (initial) launch(initial.request, 1)
    return () => controller.current?.abort()
  }, [initial, launch])

  useEffect(() => {
    const onHashChange = () => {
      const next = fromHash(deps, window.location.hash)
      if (!next) return
      setText(next.text)
      setChainId(next.chainId)
      setBlock(next.block)
      begin(next.request)
    }
    window.addEventListener("hashchange", onHashChange)
    return () => window.removeEventListener("hashchange", onHashChange)
  }, [deps, begin])

  const detect = (address: Address, scope: "popular" | "all", blockValue: string | null) => {
    const own = takeOver()
    dispatch({ type: "detect", address, scope })
    deps
      .detectChains(address, {
        scope,
        signal: own.signal,
        onResult: (result) => {
          if (!own.signal.aborted) dispatch({ type: "detected", result })
        },
      })
      .then((results) => {
        if (own.signal.aborted) return
        dispatch({ type: "detect-done", results })
        const safes = results.filter((r) => r.status === "safe")
        if (safes.length === 1) begin({ address, chainId: safes[0].chainId, block: blockValue })
      })
      .catch((error: unknown) => {
        // The chains already answered stay listed; the message says why the search ended early.
        if (!own.signal.aborted) dispatch({ type: "detect-failed", message: failureText(error) })
      })
  }

  const stopDetection = () => {
    controller.current?.abort()
    dispatch({ type: "detect-failed", message: "You stopped the search." })
  }

  const openSettings = () => {
    setSettingsOpen(true)
    setSettingsFocus((n) => n + 1)
  }

  const submit = () => {
    const parsed = deps.parseInput(text)
    if (!parsed.ok) return setInputError(parsed.message)
    const { address } = parsed.input
    if (parsed.input.chainId !== null && chainId !== null && parsed.input.chainId !== chainId) {
      const named = deps.getChain(parsed.input.chainId)?.name ?? `chain ${parsed.input.chainId}`
      const picked = deps.getChain(chainId)?.name ?? `chain ${chainId}`
      return setInputError(`The address names ${named}, but the chain picker says ${picked}. Clear one of them.`)
    }
    const blockText = parsed.input.block?.toString() ?? block.trim()
    if (!/^\d*$/.test(blockText)) return setInputError("The block in the settings must be a number, or empty.")
    const blockValue = blockText === "" ? null : blockText
    const target = parsed.input.chainId ?? chainId
    setInputError(null)
    if (target === null) return detect(address, "popular", blockValue)

    const chain = deps.getChain(target)
    if (chain && chain.rpcs.length === 0 && !chainSettings(settings, target).primary) {
      openSettings()
      return setInputError(
        `${chain.name} has no working default RPC. Add your own RPC in the settings, then check again.`,
      )
    }
    begin({ address, chainId: target, block: blockValue })
  }

  const stop = () => {
    controller.current?.abort()
    if (flow.kind === "run") {
      dispatch({
        type: "event",
        id: lastId.current,
        event: {
          type: "stopped",
          reason: "cancelled",
          message: "You stopped the check before it finished.",
          issues: [],
        },
      })
    }
  }

  // The pipeline sends the updated report as a `finished` event; a newer run or search makes it moot.
  const testCandidates = async (report: Report, candidates: string[], id: number) => {
    const own = takeOver()
    const updated = await deps.testCandidates(
      report,
      candidates,
      settingsRef.current,
      (event) => {
        if (!own.signal.aborted) dispatch({ type: "event", id, event })
      },
      own.signal,
    )
    if (!own.signal.aborted) dispatch({ type: "event", id, event: { type: "finished", report: updated } })
  }

  const checkOtherChains = async (report: Report, id: number) => {
    const own = takeOver()
    const updated = await deps.checkOtherChains(report, settingsRef.current, own.signal)
    if (!own.signal.aborted) dispatch({ type: "event", id, event: { type: "finished", report: updated } })
  }

  const latestBlock = (request: CheckRequest) => {
    setBlock("")
    begin({ ...request, block: null })
  }

  const parsedChain = (() => {
    const parsed = deps.parseInput(text)
    return parsed.ok ? parsed.input.chainId : null
  })()
  const focusChainId = chainId ?? parsedChain ?? (flow.kind === "run" ? flow.run.request.chainId : null)
  const focusChain = focusChainId === null ? null : deps.getChain(focusChainId)
  const blockValue = block.trim() === "" ? null : block.trim()

  return (
    <div className="flex flex-col gap-4">
      <InputBar
        text={text}
        onTextChange={setText}
        chains={chains}
        chainId={chainId}
        onChainChange={setChainId}
        error={inputError}
        chainNote={focusChain && <ChainNote chain={focusChain} settings={settings} onOpenSettings={openSettings} />}
        settingsOpen={settingsOpen}
        onToggleSettings={() => setSettingsOpen(!settingsOpen)}
        onSubmit={submit}
      />
      {settingsOpen && (
        <SettingsPanel
          id="settings-panel"
          chain={focusChain}
          block={block}
          onBlockChange={setBlock}
          settings={settings}
          focusRequest={settingsFocus}
          operatorName={deps.operatorName}
          onSave={(next) => {
            const saved = deps.saveSettings(next)
            settingsRef.current = saved
            setSettings(saved)
          }}
        />
      )}
      <PrivacyNote chain={focusChain} settings={settings} detectionCount={deps.detectionChains("popular").length} />
      {flow.kind === "detecting" && (
        <DetectPanel
          detection={flow.detection}
          chainName={(id) => deps.getChain(id)?.name ?? `Chain ${id}`}
          allCount={deps.detectionChains("all").length}
          onPick={(id) => begin({ address: flow.detection.address, chainId: id, block: blockValue })}
          onSearchAll={() => detect(flow.detection.address, "all", blockValue)}
          onStop={stopDetection}
        />
      )}
      {flow.kind === "run" && (
        <RunView
          key={flow.id}
          run={flow.run}
          tool={deps.tool}
          userRpcs={runRpcs}
          actions={{
            onStop: stop,
            onRetry: () => begin(flow.run.request),
            onOpenSettings: openSettings,
            onLatestBlock: () => latestBlock(flow.run.request),
            onTestCandidates: flow.run.report
              ? (candidates) => testCandidates(flow.run.report as Report, candidates, flow.id)
              : undefined,
            onCheckOtherChains: flow.run.report
              ? () => checkOtherChains(flow.run.report as Report, flow.id)
              : undefined,
          }}
        />
      )}
    </div>
  )
}
