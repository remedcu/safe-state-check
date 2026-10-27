// The fixture player: UiDeps over the fixture chains and recorded runs, for the unit tests and the end-to-end page.
// Input parsing and settings are the real src/data functions; the green and red runs are real pipeline runs over the
// pipeline's fake data layer, replayed with delays so the page streams as it would live.
import type { Address } from "viem"
import type { CheckEvent, Report } from "@/core/report"
import { providers } from "@/data/chains"
import { defaultEndpoint } from "@/data/endpoints"
import { parseInput, permalink } from "@/data/input"
import { defaultSettings, loadSettings, saveSettings } from "@/data/settings"
import type { ChainInfo, DetectOptions, DetectResult } from "@/data/types"
import { TOOL } from "@/check/run"
import { chainRef } from "@/core/steps"
import { FIXTURE_CHAINS } from "@/ui/__fixtures__/chains"
import { restartStreamFor, stoppedStream, streamFor, type TimedEvent } from "@/ui/__fixtures__/events"
import { pipelineGreen, type PipelineRun, pipelineShadowOwner } from "@/ui/__fixtures__/pipeline"
import {
  amberSingleOperatorReport,
  amberUnsupportedChainReport,
  GREEN_SAFE,
  RED_SAFE,
  SELF_TRUSTED_SAFE,
  selfTrustedReport,
  ZKSYNC_SAFE,
} from "@/ui/__fixtures__/reports"
import type { Emit, UiDeps } from "@/ui/deps"

// Plays `stream` into `emit`, `delayMs / speed` apart. Resolves with the final report, or null when the run stops or
// `signal` aborts (nothing is emitted after an abort).
export function playStream(stream: TimedEvent[], emit: Emit, signal?: AbortSignal, speed = 1): Promise<Report | null> {
  return new Promise((resolve) => {
    let index = 0
    let timer: ReturnType<typeof setTimeout> | undefined
    const onAbort = () => {
      clearTimeout(timer)
      resolve(null)
    }
    signal?.addEventListener("abort", onAbort, { once: true })
    const next = () => {
      if (signal?.aborted) return
      const item = stream[index++]
      if (!item) return resolve(null)
      emit(item.event)
      if (item.event.type === "finished" || item.event.type === "stopped") {
        signal?.removeEventListener("abort", onAbort)
        return resolve(item.event.type === "finished" ? item.event.report : null)
      }
      timer = setTimeout(next, item.delayMs / speed)
    }
    timer = setTimeout(next, 0)
  })
}

// A recorded report replayed for another Safe, chain or block.
function retarget(report: Report, address: Address, chain: ChainInfo, block: string | null = null): Report {
  const moved = { ...report, chain: chainRef(chain), request: { ...report.request, address, chainId: chain.chainId } }
  if (block === null) return moved
  // A block from the link: pinned by the user and months older than the check, as an old permalink would be.
  const anchor = {
    ...report.verification.anchor,
    number: block,
    timestamp: "2026-06-01T08:00:00Z",
    pinnedBy: "user" as const,
    note: "",
  }
  return { ...moved, request: { ...moved.request, block }, verification: { ...report.verification, anchor } }
}

function retargetEvents(run: PipelineRun, address: Address, chain: ChainInfo, block: string | null): CheckEvent[] {
  const report = retarget(run.report, address, chain, block)
  return run.events.map((event) => {
    if (event.type === "started") return { ...event, request: report.request, chain: report.chain }
    if (event.type === "finished") return { ...event, report }
    if (event.type === "section" && event.patch.key === "verification") {
      return { ...event, patch: { key: "verification", value: report.verification } }
    }
    return event
  })
}

const timed = (events: CheckEvent[], delayMs = 60): TimedEvent[] => events.map((event) => ({ delayMs, event }))

// Where the fixture Safes "exist": the red one on two chains, so detection has to ask.
const DEPLOYED: Record<string, number[]> = {
  [GREEN_SAFE.toLowerCase()]: [1],
  [RED_SAFE.toLowerCase()]: [1, 100],
  [ZKSYNC_SAFE.toLowerCase()]: [324],
  [SELF_TRUSTED_SAFE.toLowerCase()]: [1],
}

export async function fixtureStream(address: Address, chain: ChainInfo, block: string | null): Promise<TimedEvent[]> {
  const key = `${chain.chainId}:${address.toLowerCase()}`
  if (key === `1:${GREEN_SAFE.toLowerCase()}`) {
    return timed(retargetEvents(await pipelineGreen(), address, chain, block))
  }
  if (key === `1:${RED_SAFE.toLowerCase()}`) {
    return timed(retargetEvents(await pipelineShadowOwner(), address, chain, block))
  }
  if (key === `100:${RED_SAFE.toLowerCase()}`) {
    return restartStreamFor(retarget(amberSingleOperatorReport, address, chain))
  }
  if (key === `1:${SELF_TRUSTED_SAFE.toLowerCase()}`) return streamFor(selfTrustedReport)
  if (key === `324:${ZKSYNC_SAFE.toLowerCase()}`) return streamFor(amberUnsupportedChainReport)
  return stoppedStream()
}

export type FixtureOptions = { storage?: Pick<Storage, "getItem" | "setItem">; speed?: number; chains?: ChainInfo[] }

export function fixtureDeps({ storage, speed = 1, chains = FIXTURE_CHAINS }: FixtureOptions = {}): UiDeps {
  const getChain = (chainId: number) => chains.find((c) => c.chainId === chainId) ?? null
  // The same rule as src/data/detect.ts, over the fixture chains.
  const detectionChains = (scope: DetectOptions["scope"]) =>
    chains.filter((c) => c.rpcs.length > 0 && (scope === "all" || c.safeWallet))
  return {
    tool: TOOL,
    listChains: () => chains,
    getChain,
    parseInput,
    permalink,
    operatorName: (rpc, chain) => defaultEndpoint(rpc, chain, providers()).operatorName,
    detectionChains,
    async detectChains(address, { scope, signal, onResult }) {
      const found = DEPLOYED[address.toLowerCase()] ?? []
      const results: DetectResult[] = []
      for (const chain of detectionChains(scope)) {
        await new Promise((resolve) => setTimeout(resolve, 20 / speed))
        if (signal?.aborted) break
        const result: DetectResult = {
          chainId: chain.chainId,
          status: found.includes(chain.chainId) ? "safe" : "empty",
          singleton: null,
          version: found.includes(chain.chainId) ? "1.4.1" : null,
          issue: null,
        }
        results.push(result)
        onResult?.(result)
      }
      return results
    },
    defaultSettings,
    loadSettings: () => loadSettings(storage ?? null),
    saveSettings: (settings) => saveSettings(settings, storage ?? null),
    async startCheck(request, _settings, emit, signal) {
      const chain = getChain(request.chainId)
      if (!chain) return null
      return playStream(await fixtureStream(request.address, chain, request.block), emit, signal, speed)
    },
    // Like the pipeline: sends the updated report as a `finished` event and returns it.
    async testCandidates(report, candidates, _settings, emit) {
      const diagnosis = report.diagnosis ?? { steps: [], unexplained: [], candidatesTried: [] }
      const updated = {
        ...report,
        diagnosis: { ...diagnosis, candidatesTried: [...diagnosis.candidatesTried, ...candidates] },
      }
      emit({ type: "finished", report: updated })
      return updated
    },
    async checkOtherChains(report) {
      const others = chains.filter((c) => c.chainId !== report.chain.chainId && c.rpcs.length > 0)
      const found = DEPLOYED[report.request.address.toLowerCase()] ?? []
      const rows = others.map((c) => ({
        chainId: c.chainId,
        name: c.name,
        status: found.includes(c.chainId) ? ("safe" as const) : ("empty" as const),
        ownersMatch: found.includes(c.chainId) ? false : null,
        thresholdMatch: found.includes(c.chainId) ? true : null,
        note: null,
      }))
      return { ...report, crossChain: { state: "complete", data: { chains: rows } } }
    },
  }
}
