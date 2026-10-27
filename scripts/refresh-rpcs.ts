// Builds src/data/generated/chains.json (the default RPCs and chain metadata) and data/rpcs/refresh-meta.json.
//
// Sources: chainlist.org rpcs.json, chainid.network chains.json (chains chainlist drops), the Blockscout chain
// registry, the Safe Config Service and the installed @safe-global/safe-deployments. Every RPC passes the trust policy
// in scripts/lib/rpc-policy.ts, then a probe that does what the app will do (scripts/lib/rpc-probe.ts).
//
//   npm run rpcs:refresh -- --out-dir <dir> [--offline] [--reuse <dir>/probes.json] [--chains 1,100]
//     --out-dir      probe dump, rejections and source snapshots (not committed; default: a temp folder)
//     --offline      read the source snapshots in <out-dir>/sources instead of fetching
//     --reuse        start from an earlier probe dump; with --chains only those chains are probed again
//     --chains       probe only these chains
//     --concurrency  global request cap (default 24); --per-operator (default 4); --timeout-ms (default 8000)
import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { parseArgs } from "node:util"
import type { RootCheckStatus } from "@/core/report"
import { canPair } from "@/data/endpoints"
import type { ChainInfo, ChainsFile, DefaultRpc, ProviderPolicy, SourceMeta } from "@/data/types"
import { KeyedLimiter, sleep } from "./lib/http"
import { writeJson } from "./lib/output"
import {
  type Candidate,
  type ChainlistChain,
  classifyOperator,
  CURATED_PRIMARY,
  DETECT_FIRST,
  filterChain,
  NOT_MPT,
  PROVIDERS,
  type Rejection,
  RELAY_HOST_SUFFIXES,
  type RuleId,
  TEAM_DOMAIN_ALIASES,
  type Tracking,
  ZK_STACK_REASON,
} from "./lib/rpc-policy"
import { BLOCK_OFFSET, PROBE_ORIGIN, PROOF_SLOT, probeBlockscout, probeRpc, type RpcProbe } from "./lib/rpc-probe"
import { packageVersion, SAFE_DEPLOYMENTS, safeDeploymentAssets, safeDeploymentChains } from "./lib/safe-deployments"
import { loadSource } from "./lib/sources"

const ROOT = resolve(import.meta.dirname, "..")
const CHAINS_OUT = join(ROOT, "src/data/generated/chains.json")
const META_OUT = join(ROOT, "data/rpcs/refresh-meta.json")

const SOURCES = {
  chainlist: "https://chainlist.org/rpcs.json",
  ethereumLists: "https://chainid.network/chains.json",
  blockscout: "https://chains.blockscout.com/api/chains",
  safeConfig: "https://safe-config.safe.global/api/v1/chains/?limit=100",
} as const

type SafeConfigChain = {
  chainId: string
  shortName: string
  transactionService?: string | null
  blockExplorerUriTemplate?: { address?: string }
}
type BlockscoutRegistry = Record<string, { explorers?: { url: string; hostedBy?: string }[] }>
type BlockscoutProbe = { apiBase: string; ok: boolean; detail: string | null }
type Dump = { probedAt: string[]; probes: Record<string, RpcProbe>; blockscout: Record<string, BlockscoutProbe> }

const { values: args } = parseArgs({
  options: {
    "out-dir": { type: "string", default: join(tmpdir(), "safe-state-check-rpcs") },
    offline: { type: "boolean", default: false },
    reuse: { type: "string" },
    chains: { type: "string" },
    concurrency: { type: "string", default: "24" },
    "per-operator": { type: "string", default: "4" },
    "timeout-ms": { type: "string", default: "8000" },
  },
})
const outDir = resolve(args["out-dir"])
const onlyChains = args.chains ? new Set(args.chains.split(",").map(Number)) : null
const timeoutMs = Number(args["timeout-ms"])

// An endpoint is a primary candidate when its proof verified, and a cross-check candidate when it served the header.
const usable = (p: RpcProbe | undefined): p is RpcProbe =>
  !!p && p.chainId === "ok" && p.corsPreflight.ok && p.corsPost.ok && p.header.ok
const proves = (p: RpcProbe | undefined) => usable(p) && p.proof?.status === "verified"
// Failures worth a second, slower try: rate limits, server errors, timeouts, load-balancer misses.
const transientDetail = /timeout|rate-limited|server-error|unreachable|not-archive|block-unavailable/
const isTransient = (p: RpcProbe) =>
  !proves(p) &&
  [p.chainIdDetail, p.header.detail, p.proof?.kind, p.corsPreflight.error].some((d) => d && transientDetail.test(d))

const key = (chainId: number, url: string) => `${chainId} ${url}`

function rank(chainId: number, rpcs: (Candidate & { probe: RpcProbe })[]) {
  const trackingOrder: Record<Tracking, number> = { none: 0, unlabelled: 1, limited: 2, yes: 9 }
  const score = (r: Candidate & { probe: RpcProbe }) => [
    proves(r.probe) ? 0 : 1,
    CURATED_PRIMARY[chainId] === r.url ? 0 : 1,
    r.operator.kind === "team" ? 0 : (PROVIDERS.find((p) => p.id === r.operator.id)?.rank ?? 9),
    trackingOrder[r.tracking],
    r.probe.latencyMs ?? 99_999,
  ]
  return rpcs
    .filter((r) => usable(r.probe))
    .sort((a, b) => {
      const sa = score(a)
      const sb = score(b)
      for (let i = 0; i < sa.length; i++) if (sa[i] !== sb[i]) return sa[i] - sb[i]
      return a.url.localeCompare(b.url)
    })
}

// Whether the storage-root check can run on the chain, documentation first, then the probe.
// Whether the storage-root check can run on the chain, documentation first, then the probe. `reason` is a plain
// sentence the app shows; `detail` keeps the probe's raw answer for refresh-meta.json only.
function rootCheck(chainId: number, zkStack: boolean, rpcs: (Candidate & { probe: RpcProbe | undefined })[]) {
  const status = (s: RootCheckStatus, reason: string, detail: string | null = null) => ({ status: s, reason, detail })
  if (zkStack) {
    return status(
      "unsupported",
      "This is a ZK Stack chain: its state is a different kind of tree, and its RPCs do not serve standard proofs.",
      ZK_STACK_REASON,
    )
  }
  if (NOT_MPT[chainId])
    return status("unsupported", "This chain keeps its state in a different kind of tree.", NOT_MPT[chainId])
  const tried = rpcs.filter((r) => usable(r.probe) && r.probe.proof)
  const raw = (list: typeof tried) =>
    [
      ...new Set(
        list.map(
          (r) => `${r.operator.id}: ${r.probe?.proof?.detail ?? r.probe?.proof?.kind ?? r.probe?.proof?.status}`,
        ),
      ),
    ].join("; ")
  const verified = tried.filter((r) => r.probe?.proof?.status === "verified")
  if (verified.length) {
    const operators = [...new Set(verified.map((r) => r.operator.id))].join(", ")
    return status(
      "supported",
      "Default RPCs serve storage proofs that verify.",
      `verified at latest - 3 by ${operators}`,
    )
  }
  const tip = tried.filter((r) => r.probe?.tip?.status === "verified")
  if (tip.length) {
    const operators = [...new Set(tip.map((r) => r.operator.id))].join(", ")
    return status(
      "supported",
      "Default RPCs prove only their newest block, so storage is proven there (tip mode).",
      `verified at the newest block by ${operators}`,
    )
  }
  const layout = tried.filter((r) => /storage layout|zksync os/i.test(r.probe?.proof?.detail ?? ""))
  if (layout.length) {
    return status(
      "unsupported",
      "This chain stores accounts in a different layout, so its RPCs do not serve standard proofs.",
      raw(layout),
    )
  }
  const other = tried.filter((r) => r.probe?.proof?.status === "non-mpt" || r.probe?.proof?.status === "invalid")
  if (other.length) {
    const detail = raw(other)
    const reason = /account leaf|fields|trailing bytes/i.test(detail)
      ? "This chain's proofs use a different account format."
      : /does not match the root|hash to its reference/i.test(detail)
        ? "This chain's proofs do not match the state roots of its blocks."
        : "This chain's proofs come in a different format."
    return status("unsupported", reason, detail)
  }
  if (tried.length) {
    const kinds = new Set(tried.map((r) => r.probe?.proof?.status))
    const reason =
      kinds.size === 1 && kinds.has("unsupported")
        ? "No default RPC offers storage proofs."
        : kinds.size === 1 && kinds.has("window")
          ? "Default RPCs keep storage proofs only for their newest blocks, and none could be tied to a block."
          : "No default RPC serves storage proofs for recent blocks."
    return status("no-proof-rpc", reason, raw(tried))
  }
  return status(
    "no-rpc",
    rpcs.length ? "No default RPC answered with CORS for web pages." : "No default RPC passed the trust policy.",
  )
}

async function main() {
  mkdirSync(outDir, { recursive: true })
  const sourceDir = join(outDir, "sources")
  const metas: Record<string, SourceMeta> = {}
  const chainlist = (await loadSource(
    "chainlist",
    SOURCES.chainlist,
    sourceDir,
    args.offline,
    metas,
  )) as ChainlistChain[]
  const ethLists = (await loadSource(
    "ethereumLists",
    SOURCES.ethereumLists,
    sourceDir,
    args.offline,
    metas,
  )) as ChainlistChain[]
  const blockscout = (await loadSource(
    "blockscout",
    SOURCES.blockscout,
    sourceDir,
    args.offline,
    metas,
  )) as BlockscoutRegistry
  const safeConfig = (await loadSource("safeConfig", SOURCES.safeConfig, sourceDir, args.offline, metas)) as {
    results: SafeConfigChain[]
    next: string | null
  }
  if (safeConfig.next) throw new Error("The Safe Config Service has more than one page of chains; add paging")

  const assets = safeDeploymentAssets()
  const deploymentsVersion = packageVersion(SAFE_DEPLOYMENTS)
  const { ids, singleton, zkStack } = safeDeploymentChains(assets)
  const byId = new Map(chainlist.map((c) => [c.chainId, c]))
  const ethListsById = new Map(ethLists.map((c) => [c.chainId, c]))
  const safeOrder = safeConfig.results.map((c) => Number(c.chainId))
  const safeById = new Map(safeConfig.results.map((c) => [Number(c.chainId), c]))

  // Filter every chainlist chain, so the counts show what each rule removes overall.
  const rejections: Rejection[] = []
  const failing: Record<RuleId, number> = { https: 0, key: 0, tracking: 0, relay: 0, operator: 0, duplicate: 0 }
  const kept = new Map<number, Candidate[]>()
  let endpoints = 0
  for (const chain of chainlist) {
    endpoints += chain.rpc.length
    kept.set(chain.chainId, filterChain(chain, rejections, failing))
  }
  for (const [id, url] of Object.entries(CURATED_PRIMARY)) {
    const list = kept.get(Number(id)) ?? []
    const chain = byId.get(Number(id))
    const operator = chain ? classifyOperator(new URL(url).hostname, chain) : null
    if (!list.some((c) => c.url === url) && operator)
      list.push({ url, operator, tracking: "unlabelled", source: "curated" })
    kept.set(Number(id), list)
  }
  const safeIds = new Set(ids)
  const countBy = (rows: Rejection[]) =>
    rows.reduce<Record<string, number>>((acc, r) => ({ ...acc, [r.rule]: (acc[r.rule] ?? 0) + 1 }), {})
  const filterStats = {
    allChains: {
      endpoints,
      kept: [...kept.values()].reduce((n, l) => n + l.length, 0),
      removedByFirstFailingRule: countBy(rejections),
      failingEachRule: failing,
    },
    safeDeploymentChains: {
      endpoints: chainlist.filter((c) => safeIds.has(c.chainId)).reduce((n, c) => n + c.rpc.length, 0),
      kept: ids.reduce((n, id) => n + (kept.get(id)?.length ?? 0), 0),
      removedByFirstFailingRule: countBy(rejections.filter((r) => safeIds.has(r.chainId))),
    },
  }
  writeFileSync(join(outDir, "rejections.json"), `${JSON.stringify(rejections, null, 1)}\n`)

  // Probe
  const dump: Dump = args.reuse
    ? (JSON.parse(readFileSync(resolve(args.reuse), "utf8")) as Dump)
    : { probedAt: [], probes: {}, blockscout: {} }
  const toProbe = args.reuse && !onlyChains ? [] : ids.filter((id) => !onlyChains || onlyChains.has(id))
  const started = Date.now()
  if (toProbe.length) {
    const limiter = new KeyedLimiter(Number(args.concurrency), Number(args["per-operator"]))
    const jobs: Promise<void>[] = []
    let done = 0
    const probeOne = (id: number, c: Candidate, slow: boolean) =>
      limiter.run(c.operator.id, async () => {
        const endpoint = {
          url: c.url,
          host: new URL(c.url).hostname,
          operator: c.operator.id,
          operatorName: c.operator.name,
          aggregator: c.operator.aggregator,
          origin: "default" as const,
        }
        const probe = await probeRpc(endpoint, id, singleton.get(id) ?? null, {
          timeoutMs: slow ? timeoutMs * 2 : timeoutMs,
        })
        const before = dump.probes[key(id, c.url)]
        if (!slow || proves(probe) || !before) dump.probes[key(id, c.url)] = probe
      })
    for (const id of toProbe) {
      for (const c of kept.get(id) ?? []) jobs.push(probeOne(id, c, false).then(() => void done++))
    }
    const timer = setInterval(() => console.error(`probing: ${done} endpoints done`), 15_000)
    await Promise.all(jobs)
    // A second, slower pass for transient failures, after rate limits from the first pass had time to reset.
    const again = toProbe.flatMap((id) =>
      (kept.get(id) ?? []).filter((c) => isTransient(dump.probes[key(id, c.url)])).map((c) => ({ id, c })),
    )
    console.error(`rechecking ${again.length} endpoints with transient failures`)
    if (again.length) {
      await sleep(30_000)
      const slowLimiter = new KeyedLimiter(6, 2)
      await Promise.all(again.map(({ id, c }) => slowLimiter.run(c.operator.id, () => probeOne(id, c, true))))
    }
    // Explorers after the RPCs: a working RPC of the chain checks the explorer's chain when its eth-rpc is limited.
    await Promise.all(
      toProbe.flatMap((id) => {
        const explorer = blockscout[String(id)]?.explorers?.[0]
        if (!explorer) return []
        const rpcUrl = (kept.get(id) ?? []).find((c) => usable(dump.probes[key(id, c.url)]))?.url ?? null
        return [
          limiter.run(`blockscout ${explorer.url}`, async () => {
            dump.blockscout[String(id)] = await probeBlockscout(explorer.url, id, timeoutMs, rpcUrl)
          }),
        ]
      }),
    )
    clearInterval(timer)
    dump.probedAt.push(`${new Date().toISOString()}${onlyChains ? ` (chains ${[...onlyChains].join(",")})` : ""}`)
    writeFileSync(join(outDir, "probes.json"), `${JSON.stringify(dump, null, 1)}\n`)
  }
  const probeSeconds = Math.round((Date.now() - started) / 1000)

  // Assemble
  const providers: ProviderPolicy[] = PROVIDERS.map(({ id, name, hostSuffixes, aggregator }) => ({
    id,
    name,
    hostSuffixes,
    aggregator,
  }))
  const detectOrder = [...DETECT_FIRST, ...safeOrder.filter((id) => !DETECT_FIRST.includes(id))]
  const chains: Record<string, ChainInfo> = {}
  const tipProbe: {
    chainId: number
    name: string
    rpcs: { url: string; tip: string; block: string | null; detail: string | null }[]
  }[] = []
  const coverage = {
    zero: [] as number[],
    one: [] as number[],
    twoPlus: [] as number[],
    twoPlusProofsOnly: 0,
    tipOnly: [] as number[],
    rootCheck: {} as Record<string, number>,
    // The probe's raw answers behind each chain's plain root-check reason.
    rootCheckDetail: {} as Record<string, string>,
  }
  for (const id of ids) {
    const cl = byId.get(id) ?? ethListsById.get(id)
    const safe = safeById.get(id)
    const rpcs = (kept.get(id) ?? []).map((c) => ({ ...c, probe: dump.probes[key(id, c.url)] }))
    const ranked = rank(id, rpcs as (Candidate & { probe: RpcProbe })[])
    const { detail, ...check } = rootCheck(id, zkStack.has(id), rpcs)
    coverage.rootCheck[check.status] = (coverage.rootCheck[check.status] ?? 0) + 1
    if (detail) coverage.rootCheckDetail[String(id)] = detail
    if (/tip mode/.test(check.reason)) coverage.tipOnly.push(id)
    // Chains where no RPC proves latest - 3 but some prove recent blocks: the tip-mode binding result per RPC.
    const windowed = rpcs.filter((r) => usable(r.probe) && r.probe.proof?.status === "window")
    if (!rpcs.some((r) => proves(r.probe)) && windowed.length) {
      tipProbe.push({
        chainId: id,
        name: byId.get(id)?.name ?? `Chain ${id}`,
        rpcs: windowed.map((r) => ({
          url: r.url,
          tip: r.probe?.tip?.status ?? "not-run",
          block: r.probe?.tip?.block ?? null,
          detail: r.probe?.tip?.detail ?? null,
        })),
      })
    }

    // Operators: a primary that proves, plus a cross-check of another operator (never two aggregators) that serves
    // the header. Counted with and without header-only cross-checks.
    const primaries = ranked.filter((r) => proves(r.probe))
    const ref = (r: (typeof ranked)[number]) => ({ operator: r.operator.id, aggregator: r.operator.aggregator })
    const pairs = (pool: typeof ranked) => primaries.some((p) => pool.some((c) => canPair(ref(p), ref(c))))
    const bucket = primaries.length === 0 ? coverage.zero : pairs(ranked) ? coverage.twoPlus : coverage.one
    bucket.push(id)
    if (pairs(primaries)) coverage.twoPlusProofsOnly++

    // Explorer links are https only: a plain-http explorer is dropped rather than linked.
    const https = (url: string | undefined) => (url && /^https:\/\//i.test(url) ? url : undefined)
    const explorer = (cl?.explorers ?? [])
      .filter((e) => https(e.url))
      .sort((a, b) => Number(b.standard === "EIP3091") - Number(a.standard === "EIP3091"))[0]
    const safeExplorer = https(safe?.blockExplorerUriTemplate?.address)
    const bs = dump.blockscout[String(id)]
    const service = safe?.transactionService?.replace(/\/+$/, "")
    const shortName = cl?.shortName ?? ""
    chains[String(id)] = {
      chainId: id,
      name: cl?.name ?? `Chain ${id}`,
      shortName,
      shortNameAliases: safe && safe.shortName !== shortName ? [safe.shortName] : [],
      explorer: safeExplorer
        ? { addressUrl: safeExplorer.replace("{{address}}", "{address}") }
        : explorer
          ? { addressUrl: `${explorer.url.replace(/\/+$/, "")}/address/{address}` }
          : null,
      blockscoutApi: bs?.ok ? bs.apiBase : null,
      safeTxServiceApi: service ? `${service}/api/v1` : null,
      safeWallet: !!safe,
      detectRank: detectOrder.includes(id) ? detectOrder.indexOf(id) : 1_000 + ids.indexOf(id),
      rootCheck: check,
      rpcs: ranked.map((r): DefaultRpc => ({
        url: r.url,
        operator: r.operator.id,
        operatorKind: r.operator.kind === "team" ? "team" : "provider",
        aggregator: r.operator.aggregator,
        proofs: proves(r.probe),
      })),
    }
  }

  // No timestamps here: a refresh diff of chains.json then shows only RPCs added, removed and re-ranked. Times and
  // sources go to refresh-meta.json.
  const generatedAt = new Date().toISOString()
  const file: ChainsFile = { schema: 1, safeDeploymentsVersion: deploymentsVersion, providers, chains }
  await writeJson(CHAINS_OUT, file)

  const meta = {
    schema: 1,
    generatedAt,
    probedAt: dump.probedAt,
    probeSeconds,
    sources: metas,
    safeDeployments: { package: SAFE_DEPLOYMENTS, version: deploymentsVersion, chains: ids.length },
    policy: {
      providers: PROVIDERS,
      teamDomainAliases: TEAM_DOMAIN_ALIASES,
      team: "host has the registrable domain of the chain's chainlist infoURL, and that domain is not a hosting or infrastructure domain",
      tracking: {
        none: "kept",
        unlabelled: "kept (chain-team URLs come from ethereum-lists, which has no tracking field)",
        limited: "kept only for allowlisted providers, ranked last",
        yes: "removed",
      },
      relayHostSuffixes: RELAY_HOST_SUFFIXES,
      curatedPrimary: CURATED_PRIMARY,
      detectFirst: DETECT_FIRST,
      probe: {
        origin: PROBE_ORIGIN,
        timeoutMs,
        blockOffset: Number(BLOCK_OFFSET),
        proofSlot: PROOF_SLOT,
        concurrency: Number(args.concurrency),
        perOperator: Number(args["per-operator"]),
        primary:
          "chainId, CORS preflight and POST, header at latest - 3, eth_getProof there verified with src/core/proof.ts",
        crossCheckOnly: "chainId, CORS preflight and POST, header at latest - 3 (proofs: false)",
      },
    },
    filterStats,
    coverage: {
      chains: ids.length,
      rootCheck: coverage.rootCheck,
      operators: {
        zero: coverage.zero.length,
        one: coverage.one.length,
        twoPlus: coverage.twoPlus.length,
        twoPlusProofsOnly: coverage.twoPlusProofsOnly,
      },
      tipModeOnly: coverage.tipOnly,
      // Tip mode: the newest proof bound to a header by keccak256(accountProof[0]) == stateRoot, then verified.
      tipProbe,
      oneOperatorIds: coverage.one,
      rootCheckDetail: coverage.rootCheckDetail,
    },
  }
  await writeJson(META_OUT, meta)
  console.log(
    JSON.stringify({
      chainsBytes: JSON.stringify(file).length,
      coverage: meta.coverage.operators,
      rootCheck: coverage.rootCheck,
      tipModeOnly: coverage.tipOnly.length,
    }),
  )
}

await main()
