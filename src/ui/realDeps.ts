// The app's real dependencies, loaded as one lazy chunk: the chain list, the registry loader and the pipeline.
import { testCandidates } from "@/check/candidates"
import { checkOtherChains } from "@/check/otherChains"
import { TOOL } from "@/check/run"
import { startCheck } from "@/check/start"
import { getChain, listChains, providers } from "@/data/chains"
import { detectChains, detectionChains } from "@/data/detect"
import { defaultEndpoint } from "@/data/endpoints"
import { parseInput, permalink } from "@/data/input"
import { defaultSettings, loadSettings, saveSettings } from "@/data/settings"
import type { UiDeps } from "@/ui/deps"

export const realDeps: UiDeps = {
  tool: TOOL,
  listChains,
  getChain,
  parseInput,
  permalink,
  operatorName: (rpc, chain) => defaultEndpoint(rpc, chain, providers()).operatorName,
  detectChains,
  detectionChains,
  defaultSettings,
  loadSettings: () => loadSettings(),
  saveSettings: (settings) => saveSettings(settings),
  startCheck,
  testCandidates,
  checkOtherChains,
}
