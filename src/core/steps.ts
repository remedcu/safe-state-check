// Step labels, step order and the chain reference: what the first paint needs from the pipeline. Imports types
// only, so the page can show them before the check code loads.
import type { ChainRef, StepId } from "@/core/report"
import type { ChainInfo } from "@/data/types"

export const STEP_LABELS: Record<StepId, string> = {
  anchor: "Pin a block both RPCs agree on",
  identity: "Check the Safe's code",
  config: "Read owners, modules and settings",
  storage: "Rebuild the storage root",
  owners: "Inspect the owners",
  modules: "Inspect the modules",
  handlers: "Inspect the guard and fallback handler",
  creation: "Decode how the Safe was created",
  history: "Read the event history",
  pending: "List pending actions",
  "storage-events": "Add slots from events",
  diagnosis: "Look for the unexplained slots",
  reorg: "Check the block did not change",
  verdict: "Decide the verdict",
}

export const STEP_ORDER = Object.keys(STEP_LABELS) as StepId[]

export function chainRef(chain: ChainInfo): ChainRef {
  return {
    chainId: chain.chainId,
    name: chain.name,
    shortName: chain.shortName,
    explorerAddressUrl: chain.explorer?.addressUrl ?? null,
    rootCheck: chain.rootCheck.status,
  }
}
