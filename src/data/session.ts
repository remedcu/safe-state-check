// openSession: everything one run needs for one chain, built from the settings and chains.json. Nothing is fetched
// here; the reader probes lazily, starting with anchor().
import { Blockscout } from "@/data/blockscout"
import { getChain, providers } from "@/data/chains"
import { Creation } from "@/data/creation"
import { buildPool } from "@/data/endpoints"
import { secretsOf } from "@/data/errors"
import { Etherscan } from "@/data/etherscan"
import { Events } from "@/data/logs"
import { type CapabilityCache, sessionCapabilities } from "@/data/probe"
import { Reader } from "@/data/reader"
import { SafeTxServiceClient } from "@/data/safeTxService"
import { chainSettings, publicIndexersOn } from "@/data/settings"
import { SourcifyClient } from "@/data/sourcify"
import { type CallLogEntry, Transport } from "@/data/transport"
import type { ChainInfo, OpenSession, SessionOptions, SessionResult, Settings } from "@/data/types"

export type SessionInternals = {
  // Injected in tests; the page session shares one cache.
  capabilities?: CapabilityCache
  chain?: ChainInfo
  // Every request of the run (host, method, time, outcome), for "technical details" and the CLI's --verbose.
  onCallLog?: (log: readonly CallLogEntry[]) => void
}

export const openSession: OpenSession = (chainId, settings, options) => open(chainId, settings, options)

export async function open(
  chainId: number,
  settings: Settings,
  options: SessionOptions = {},
  internals: SessionInternals = {},
): Promise<SessionResult> {
  const chain = internals.chain ?? getChain(chainId)
  if (!chain) {
    return {
      ok: false,
      reason: "unknown-chain",
      message: `Chain ${chainId} is not one of the chains Safe deploys on (safe-deployments).`,
      issues: [],
    }
  }
  const pool = buildPool(chain, settings, providers())
  if (pool.length === 0) {
    const off = !chainSettings(settings, chainId).useDefaults
    return {
      ok: false,
      reason: "no-rpc",
      message: off
        ? `Default RPCs are turned off for ${chain.name} and no RPC of your own is set. Add your RPC in settings.`
        : `There is no default RPC for ${chain.name} that passed the checks (${chain.rootCheck.reason.replace(/\.$/, "")}). Add your own RPC in settings.`,
      issues: [],
    }
  }

  const signal = options.signal ?? new AbortController().signal
  const onIssue = options.onIssue ?? (() => undefined)
  const transport = new Transport({ fetch: options.fetch, signal, secrets: secretsOf(settings) })
  internals.onCallLog?.(transport.log)
  const reader = new Reader(chain, pool, {
    transport,
    capabilities: internals.capabilities ?? sessionCapabilities,
    settings,
    onIssue,
  })
  // Public indexers only when the user keeps them on; keyed APIs only with a key; the Transaction Service only when on.
  const indexers = publicIndexersOn(settings)
  const blockscout = indexers && chain.blockscoutApi ? new Blockscout(chain.blockscoutApi, transport) : null
  const etherscan = settings.etherscan.apiKey ? new Etherscan(chainId, settings.etherscan.apiKey, transport) : null
  const safeTxService =
    settings.safeTxService.enabled && chain.safeTxServiceApi
      ? new SafeTxServiceClient(chain.safeTxServiceApi, settings.safeTxService.apiKey, transport)
      : null

  return {
    ok: true,
    deps: {
      reader,
      events: new Events({ reader, blockscout, etherscan, onIssue, budgetMs: options.historyBudgetMs }),
      creation: new Creation({ reader, safeTxService, blockscout }),
      safeTxService,
      sourcify: new SourcifyClient(transport, indexers),
      publicIndexers: indexers,
      signal,
    },
  }
}
