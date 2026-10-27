// Everything the UI calls outside src/ui, behind one object, so tests and the end-to-end fixture page can swap in the
// fixture player. The real implementations load as one lazy chunk: the chain list and the pipeline are the bulk of the
// app and are not needed for the first paint.
import { createContext, useContext } from "react"
import type { CheckEvent, CheckRequest, Report } from "@/core/report"
import type { ChainInfo, DefaultRpc, DetectOptions, DetectResult, InputResult, Settings } from "@/data/types"
import type { Address } from "viem"

export type Emit = (event: CheckEvent) => void

export type UiDeps = {
  // Name and version the pipeline writes into reports; a partial report from a stopped run carries the same.
  tool: Report["tool"]
  listChains(): ChainInfo[]
  getChain(chainId: number): ChainInfo | null
  parseInput(text: string): InputResult
  // "PublicNode" or "Kaia team" for a default RPC, instead of its operator id.
  operatorName(rpc: DefaultRpc, chain: ChainInfo): string
  // The hash a finished run writes, so the host never sees the address.
  permalink(chainId: number, address: Address, block: bigint | null): string
  detectChains(address: Address, options: DetectOptions): Promise<DetectResult[]>
  // The chains a detection phase asks, so the privacy note can say how many.
  detectionChains(scope: DetectOptions["scope"]): ChainInfo[]
  defaultSettings(): Settings
  loadSettings(): Settings
  // Returns what was stored (invalid fields dropped).
  saveSettings(settings: Settings): Settings
  startCheck(request: CheckRequest, settings: Settings, emit: Emit, signal?: AbortSignal): Promise<Report | null>
  testCandidates(
    report: Report,
    candidates: string[],
    settings: Settings,
    emit: Emit,
    signal?: AbortSignal,
  ): Promise<Report>
  // Looks for the same address on every other chain with a default RPC and returns the report with that section.
  checkOtherChains(report: Report, settings: Settings, signal?: AbortSignal): Promise<Report>
}

export const DepsContext = createContext<UiDeps | null>(null)

export function useDeps(): UiDeps {
  const deps = useContext(DepsContext)
  if (!deps) throw new Error("useDeps needs a DepsContext provider")
  return deps
}

export async function loadDeps(): Promise<UiDeps> {
  return (await import("@/ui/realDeps")).realDeps
}
