import { chainSettings, publicIndexersOn } from "@/data/settings"
import type { ChainInfo, Settings } from "@/data/types"

const host = (url: string | null) => {
  try {
    return url ? new URL(url).host : null
  } catch {
    return null
  }
}

// Where the Safe address goes with the settings as they are now, party by party.
export function PrivacyNote({
  chain,
  settings,
  detectionCount,
}: {
  chain: ChainInfo | null
  settings: Settings
  detectionCount: number
}) {
  const parties: string[] = []
  if (chain) {
    const rpcs = chainSettings(settings, chain.chainId)
    const own = [rpcs.primary, rpcs.crossCheck].map(host).filter((h) => h !== null)
    if (own.length > 0) parties.push(`your RPCs (${own.join(", ")})`)
    if (rpcs.useDefaults && chain.rpcs.length > 0) parties.push(`the default RPCs for ${chain.name}`)
    const sts = host(chain.safeTxServiceApi)
    if (settings.safeTxService.enabled && sts) parties.push(`the Safe Transaction Service (${sts})`)
    const blockscout = host(chain.blockscoutApi)
    if (publicIndexersOn(settings)) {
      parties.push(blockscout ? `Blockscout (${blockscout}) and Sourcify` : "Sourcify, for code it does not know")
    }
  } else {
    parties.push(
      `the default RPCs of the ${detectionCount} most used chains, to find the chain (one or two requests per chain)`,
      "then the RPCs and services of the chain it is found on",
    )
    if (settings.safeTxService.enabled) parties.push("the Safe Transaction Service")
    if (publicIndexersOn(settings)) parties.push("Blockscout and Sourcify")
  }
  if (settings.etherscan.apiKey) parties.push("Etherscan, with your key")

  return (
    <p className="max-w-[60rem] text-xs leading-[18px] text-muted-foreground">
      Privacy: with these settings the Safe address goes to {parties.join("; ")}. “Search all chains” and “Check other
      chains” send it to every chain's default RPC, only when you click them. Nothing goes to this site's host: the link
      keeps the address after the #.
    </p>
  )
}
