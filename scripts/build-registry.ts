// Builds the known-contracts registry from the packages (docs/ARCHITECTURE.md section 9.2):
//   src/data/generated/known-contracts.json  every contract with its code hash, kind and source
//   data/registry/codehashes.json            code hashes the packages do not ship, with chain and block
// It also checks src/data/reviewed-contracts.json (shape, and the code hash on its chain when online).
// safe-deployments ships code hashes. safe-modules-deployments and Zodiac do not: their code is read once on chains
// 1, 100 and 11155111, else on a chain the package lists for that address, and cached. SafeProxy runtimes come from a
// deployless eth_call of each factory's proxyCreationCode(). Output is deterministic: sorted, no timestamps.
//
//   npm run registry:build                  network only for addresses missing from the cache
//   npm run registry:build -- --offline     packages and cache only; fails on a missing hash
//   npm run registry:build -- --offline --check   rebuild in memory and fail on any difference (CI)
import { existsSync, readFileSync } from "node:fs"
import { join, relative, resolve } from "node:path"
import { parseArgs } from "node:util"
import { CanonicalAddresses, sanityCheckZodiacModuleAddress } from "@gnosis-guild/zodiac"
import { type Address, concat, encodeAbiParameters, getAddress, type Hex, isAddress, keccak256 } from "viem"
import { defaultEndpoint } from "@/data/endpoints"
import { ioErrorOf } from "@/data/errors"
import { Transport } from "@/data/transport"
import type {
  ChainsFile,
  ContractKind,
  KnownContract,
  KnownContractsFile,
  KnownFlag,
  ReviewedContract,
} from "@/data/types"
import { isSignedOff } from "@/data/reviewed"
import { formatJson, writeJson } from "./lib/output"
import {
  type DeploymentType,
  jsonFiles,
  packageDir,
  packageVersion,
  SAFE_DEPLOYMENTS,
  safeDeploymentAssets,
  typesOf,
} from "./lib/safe-deployments"

const ROOT = resolve(import.meta.dirname, "..")
const OUT = {
  known: join(ROOT, "src/data/generated/known-contracts.json"),
  cache: join(ROOT, "data/registry/codehashes.json"),
}
const CHAINS = join(ROOT, "src/data/generated/chains.json")
const REVIEWED = join(ROOT, "src/data/reviewed-contracts.json")
const SAFE_MODULES = "@safe-global/safe-modules-deployments"
const ZODIAC = "@gnosis-guild/zodiac"
// Chains read first for code the packages do not hash: Ethereum, Gnosis and Sepolia, whose default RPCs serve archive
// state.
const SAMPLE_CHAINS = [1, 100, 11155111]

const { values: args } = parseArgs({
  options: { offline: { type: "boolean", default: false }, check: { type: "boolean", default: false } },
})

type Kinds = [ContractKind, ContractKind[], KnownFlag[], string | null]

// safe-deployments files: kind, other roles, flags and, for code a Safe delegatecalls, which Safe slots it writes.
const SD_KIND: Record<string, Kinds> = {
  gnosis_safe: ["singleton", [], [], null],
  safe: ["singleton", [], [], null],
  gnosis_safe_l2: ["singleton", [], ["l2"], null],
  safe_l2: ["singleton", [], ["l2"], null],
  proxy_factory: ["proxy-factory", [], [], null],
  safe_proxy_factory: ["proxy-factory", [], [], null],
  compatibility_fallback_handler: ["fallback-handler", [], [], null],
  // Keeps each Safe's methods and domain verifiers in its own storage, outside the Safe's storage root.
  extensible_fallback_handler: ["fallback-handler", [], ["keeps-safe-state"], null],
  token_callback_handler: ["fallback-handler", [], [], null],
  default_callback_handler: ["fallback-handler", [], [], null],
  multi_send: ["setup-helper", ["library"], [], null],
  multi_send_call_only: ["setup-helper", ["library"], [], null],
  safe_to_l2_setup: ["setup-helper", [], ["writes-safe-storage"], "slot 0 (singleton) on chains other than 1"],
  create_and_add_modules: ["setup-helper", [], ["legacy", "writes-safe-storage"], "modules"],
  sign_message_lib: ["library", [], ["writes-safe-storage"], "signedMessages"],
  create_call: ["library", [], [], null],
  simulate_tx_accessor: ["library", [], [], null],
  safe_migration: ["library", [], ["writes-safe-storage"], "slot 0 (singleton) and the fallback handler"],
  safe_to_l2_migration: ["library", [], ["writes-safe-storage"], "slot 0 (singleton) and the fallback handler"],
}

const SMD_KIND: Record<string, Kinds> = {
  // Both a module and the fallback handler (it inherits CompatibilityFallbackHandler).
  Safe4337Module: ["module", ["fallback-handler"], [], null],
  SafeModuleSetup: ["setup-helper", [], ["writes-safe-storage"], "modules"],
  AddModulesLib: ["setup-helper", [], ["writes-safe-storage"], "modules"],
  AllowanceModule: ["module", [], [], null],
  SocialRecoveryModule: ["module", [], [], null],
  SafeWebAuthnSharedSigner: ["owner-signer", ["setup-helper"], ["writes-safe-storage"], "SIGNER_SLOT, +1 and +2"],
  SafeWebAuthnSignerFactory: ["factory", [], [], null],
  DaimoP256Verifier: ["library", [], [], null],
}

const ZODIAC_KIND: Record<string, ContractKind> = {
  realityETH: "module",
  realityERC20: "module",
  bridge: "module",
  exit: "module",
  exitERC721: "module",
  tellor: "module",
  optimisticGovernor: "module",
  connext: "module",
  delay: "modifier",
  roles: "modifier",
  scopeGuard: "guard",
  metaGuard: "guard",
  factory: "factory",
}

// zkSync proxies cannot be derived (zksolc creation code holds a bytecode hash); one sampled proxy each on chain 324.
const ZKSYNC_PROXIES: [string, Hex, Address][] = [
  [
    "1.3.0",
    "0x3d70c4a51cf0b92f04e5e281833aeece55198933569c08f5d11fcc45c495253e",
    "0x1b5fb5645c8a542117f8844686e21e81254ff6d8",
  ],
  [
    "1.4.1",
    "0x9bc86fed432277d1eb833ac9eb5074f3f4b3b36528f0cb41736fedce9db346c7",
    "0xabe1db9597a092b3cd0f467bf196d84fbd506091",
  ],
]

type CacheEntry = { codeHash: Hex | null; chainId: number | null; block: number | null; checked: string[] }
type CodeHashCache = {
  schema: 1
  // Lowercase address to its code hash and where it was read; codeHash null with the chains checked when none had code.
  addresses: Record<string, CacheEntry>
  proxies: Record<string, { codeHash: Hex; factory: Address; chainId: number; block: number }>
}

function readJson<T>(path: string, fallback: T): T {
  return existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as T) : fallback
}

const cache = readJson<CodeHashCache>(OUT.cache, { schema: 1, addresses: {}, proxies: {} })
const chains = readJson<ChainsFile | null>(CHAINS, null)
const missing: string[] = []
const transport = new Transport()
const pinned = new Map<number, { block: bigint; url: string }>()

// Each read goes through the chain's default RPCs in rank order, at one pinned block per chain.
async function onChain<T>(
  chainId: number,
  read: (client: ReturnType<Transport["client"]>, block: bigint) => Promise<T>,
) {
  const chain = chains?.chains[String(chainId)]
  if (!chain || chain.rpcs.length === 0) throw new Error(`no default RPC for chain ${chainId} in chains.json`)
  let last: unknown = null
  for (const rpc of chain.rpcs) {
    const client = transport.client(defaultEndpoint(rpc, chain, chains?.providers ?? []), {
      role: "primary",
      operation: "read code for the registry",
    })
    try {
      let pin = pinned.get(chainId)
      if (!pin) pinned.set(chainId, (pin = { block: (await client.getBlockNumber()) - 3n, url: rpc.url }))
      return { value: await read(client, pin.block), block: pin.block }
    } catch (error) {
      if (!ioErrorOf(error)) throw error
      last = error
    }
  }
  throw last
}

// Code hash of an address the packages do not hash: the cache, else the sample chains, else the chains the package
// lists for it (in list order).
async function codeHashOf(address: Address, listed: readonly number[]): Promise<CacheEntry> {
  const key = address.toLowerCase()
  const cached = cache.addresses[key]
  if (cached?.codeHash) return cached
  const candidates = [...SAMPLE_CHAINS, ...listed.filter((id) => !SAMPLE_CHAINS.includes(id))]
  const checked = new Set(cached?.checked ?? [])
  const untried = candidates.filter((id) => ![...checked].some((c) => c.startsWith(`${id}@`)))
  if (args.offline) {
    if (untried.some((id) => chains?.chains[String(id)]?.rpcs.length))
      missing.push(`${address} (chains ${untried.join(",")})`)
    return cached ?? { codeHash: null, chainId: null, block: null, checked: [] }
  }
  for (const chainId of untried) {
    if (!chains?.chains[String(chainId)]?.rpcs.length) continue
    try {
      const { value: code, block } = await onChain(chainId, (client, blockNumber) =>
        client.getCode({ address, blockNumber }),
      )
      if (code && code !== "0x") {
        return (cache.addresses[key] = { codeHash: keccak256(code), chainId, block: Number(block), checked: [] })
      }
      checked.add(`${chainId}@${block}`)
    } catch (error) {
      console.warn(`code of ${address} on chain ${chainId}: ${(error as Error).message.split("\n")[0]}`)
    }
  }
  const sorted = [...checked].sort()
  return (cache.addresses[key] = { codeHash: null, chainId: null, block: null, checked: sorted })
}

const source = (
  s: Partial<KnownContract["source"]> & Pick<KnownContract["source"], "origin">,
): KnownContract["source"] => ({
  package: null,
  version: null,
  path: null,
  deploymentType: null,
  url: null,
  reviewedOn: null,
  ...s,
})

const withoutCodeHash = (entry: CacheEntry, listed: readonly number[]) =>
  entry.codeHash
    ? `onchain:${entry.chainId}@${entry.block}`
    : `none: no code on ${entry.checked.join(", ") || "any chain read"} (package lists ${listed.slice(0, 8).join(",") || "no chain"})`

async function main() {
  const contracts: KnownContract[] = []
  const sdVersion = packageVersion(SAFE_DEPLOYMENTS)
  const smdVersion = packageVersion(SAFE_MODULES)
  const zodiacVersion = packageVersion(ZODIAC)

  // safe-deployments: one entry per deployment type.
  const sdAssets = safeDeploymentAssets()
  for (const asset of sdAssets) {
    const [kind, roles, flags, writes] = SD_KIND[asset.file] ?? ["other", [], [], null]
    for (const [type, deployment] of Object.entries(asset.deployments) as [
      DeploymentType,
      { address: Address; codeHash: Hex },
    ][]) {
      const listed = Object.entries(asset.networkAddresses)
        .filter(([, types]) => typesOf(types).includes(type))
        .map(([id]) => Number(id))
        .sort((a, b) => a - b)
      contracts.push({
        id: `${asset.contractName}@${asset.version}/${type}`,
        name: asset.contractName,
        version: asset.version,
        kind,
        roles,
        address: getAddress(deployment.address),
        codeHash: deployment.codeHash.toLowerCase() as Hex,
        codeHashSource: "package",
        chains: listed,
        flags: [
          ...flags,
          ...(type === "zksync" ? (["zksync"] as const) : []),
          ...(type === "eip155" ? (["eip155"] as const) : []),
        ],
        writes,
        source: source({
          origin: "safe-deployments",
          package: SAFE_DEPLOYMENTS,
          version: sdVersion,
          path: asset.path,
          deploymentType: type,
        }),
      })
    }
  }

  // safe-modules-deployments: one entry per (contract, version, address).
  const smdRoot = packageDir(SAFE_MODULES)
  for (const path of jsonFiles(join(smdRoot, "src", "assets"))) {
    const asset = JSON.parse(readFileSync(path, "utf8")) as {
      contractName: string
      version: string
      abi: unknown
      networkAddresses: Record<string, string>
    }
    const [kind, roles, flags, writes] = SMD_KIND[asset.contractName] ?? ["other", [], [], null]
    const byAddress = new Map<Address, number[]>()
    for (const [id, address] of Object.entries(asset.networkAddresses)) {
      byAddress.set(getAddress(address), [...(byAddress.get(getAddress(address)) ?? []), Number(id)])
    }
    for (const [address, listed] of byAddress) {
      listed.sort((a, b) => a - b)
      const hash = await codeHashOf(address, listed)
      contracts.push({
        id: `${asset.contractName}@${asset.version}/${address}`,
        name: asset.contractName,
        version: asset.version,
        kind,
        roles,
        address,
        codeHash: hash.codeHash,
        codeHashSource: withoutCodeHash(hash, listed),
        chains: listed,
        flags,
        writes,
        source: source({
          origin: "safe-modules-deployments",
          package: SAFE_MODULES,
          version: smdVersion,
          path: relative(smdRoot, path),
        }),
      })
    }
  }

  // Zodiac: CanonicalAddresses, one address on every chain (5.x has no per-chain list).
  for (const [name, versions] of Object.entries(CanonicalAddresses as Record<string, Record<string, string>>)) {
    const ordered = Object.keys(versions).sort()
    for (const version of ordered) {
      const address = versions[version]
      if (!address || !isAddress(address, { strict: false })) continue // optimisticGovernor 1.0.0 is "" in 5.0.1
      const flags: KnownFlag[] = []
      try {
        sanityCheckZodiacModuleAddress(address)
      } catch (error) {
        if (/faulty/i.test((error as Error).message)) flags.push("faulty")
      }
      const hash = await codeHashOf(getAddress(address), [])
      contracts.push({
        id: `zodiac/${name}@${version}`,
        name,
        version,
        kind: ZODIAC_KIND[name] ?? "other",
        roles: [],
        address: getAddress(address),
        codeHash: hash.codeHash,
        codeHashSource: withoutCodeHash(hash, []),
        chains: "any-evm",
        flags,
        writes: null,
        source: source({ origin: "zodiac", package: ZODIAC, version: zodiacVersion, path: "dist/esm/contracts.js" }),
      })
    }
  }

  // SafeProxy runtimes: the proxy holds no immutables, so one hash covers every EVM chain.
  const factories = contracts.filter(
    (c) => c.kind === "proxy-factory" && c.source.deploymentType === "canonical" && c.address !== null,
  )
  for (const factory of factories) {
    const cached = cache.proxies[factory.version]
    let proxy = cached
    if (!proxy && args.offline) missing.push(`SafeProxy@${factory.version} (factory ${factory.address})`)
    if (!proxy && !args.offline) {
      const { value, block } = await onChain(1, async (client, blockNumber) => {
        const creation = await client.readContract({
          address: factory.address as Address,
          abi: [
            {
              type: "function",
              name: "proxyCreationCode",
              inputs: [],
              outputs: [{ type: "bytes" }],
              stateMutability: "pure",
            },
          ],
          functionName: "proxyCreationCode",
          blockNumber,
        })
        // Any singleton argument gives the same runtime: the constructor only stores it.
        const init = concat([
          creation,
          encodeAbiParameters([{ type: "address" }], ["0x0000000000000000000000000000000000000001"]),
        ])
        return (await client.call({ data: init, blockNumber })).data
      })
      if (!value) throw new Error(`no runtime from the ${factory.version} factory`)
      proxy = cache.proxies[factory.version] = {
        codeHash: keccak256(value),
        factory: factory.address as Address,
        chainId: 1,
        block: Number(block),
      }
    }
    if (!proxy || contracts.some((c) => c.id === `SafeProxy@${factory.version}`)) continue
    contracts.push({
      id: `SafeProxy@${factory.version}`,
      name: "SafeProxy",
      version: factory.version,
      kind: "proxy",
      roles: [],
      address: null,
      codeHash: proxy.codeHash,
      codeHashSource: `derived:proxyCreationCode@${proxy.chainId}:${proxy.block}`,
      chains: "any-evm",
      flags: [],
      writes: null,
      source: source({ origin: "derived", package: SAFE_DEPLOYMENTS, version: sdVersion, path: factory.source.path }),
    })
  }
  for (const [version, codeHash, sample] of ZKSYNC_PROXIES) {
    contracts.push({
      id: `SafeProxy@${version}/zksync`,
      name: "SafeProxy",
      version,
      kind: "proxy",
      roles: [],
      address: null,
      codeHash,
      codeHashSource: `sampled:324:${sample}`,
      chains: [324],
      flags: ["zksync"],
      writes: null,
      source: source({ origin: "derived", package: SAFE_DEPLOYMENTS, version: sdVersion }),
    })
  }

  // The reviewed list is not merged (its entries match on chain, address and code hash, not code hash alone), but
  // each entry is checked here.
  const reviewed = readJson<ReviewedContract[]>(REVIEWED, [])
  for (const entry of reviewed) {
    const problems = [
      !isAddress(entry.address, { strict: true }) && "address is not checksummed",
      !/^0x[0-9a-f]{64}$/.test(entry.codeHash) && "codeHash is not a lowercase 32-byte hash",
      !chains?.chains[String(entry.chainId)] && "chainId is not in chains.json",
      !/^https:\/\//.test(entry.sourceUrl) && "sourceUrl is not https",
      // Waiting for review: both empty. Signed off: a maintainer's name and the review date.
      (entry.reviewedBy === "") !== (entry.reviewedOn === "") &&
        "reviewedBy and reviewedOn must both be set or both empty",
      entry.reviewedOn !== "" && !isSignedOff(entry) && "reviewedOn is not a YYYY-MM-DD date",
      /awaiting|todo|tbd|pending/i.test(entry.reviewedBy) &&
        "reviewedBy must name the reviewer; leave it empty until then",
    ].filter(Boolean)
    if (problems.length) throw new Error(`reviewed-contracts.json ${entry.address}: ${problems.join("; ")}`)
    const onchain = await codeHashOf(entry.address, [entry.chainId])
    if (!args.offline && onchain.codeHash !== entry.codeHash) {
      throw new Error(
        `reviewed-contracts.json ${entry.address}: code hash on chain ${entry.chainId} is ${onchain.codeHash}`,
      )
    }
  }

  if (missing.length) {
    throw new Error(
      `Code hashes missing from data/registry/codehashes.json; run npm run registry:build online:\n  ${missing.join("\n  ")}`,
    )
  }

  contracts.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  const known: KnownContractsFile = {
    schema: 1,
    packages: [
      { name: SAFE_DEPLOYMENTS, version: sdVersion },
      { name: SAFE_MODULES, version: smdVersion },
      { name: ZODIAC, version: zodiacVersion },
    ],
    contracts,
  }
  const sortedCache: CodeHashCache = {
    schema: 1,
    addresses: Object.fromEntries(Object.entries(cache.addresses).sort(([a], [b]) => (a < b ? -1 : 1))),
    proxies: Object.fromEntries(Object.entries(cache.proxies).sort(([a], [b]) => (a < b ? -1 : 1))),
  }
  const outputs: [string, unknown][] = [
    [OUT.known, known],
    [OUT.cache, sortedCache],
  ]

  if (args.check) {
    const stale: string[] = []
    for (const [path, value] of outputs) {
      const current = existsSync(path) ? readFileSync(path, "utf8") : ""
      if (current !== (await formatJson(path, value))) stale.push(relative(ROOT, path))
    }
    if (stale.length) {
      console.error(`Out of date: ${stale.join(", ")}. Run npm run registry:build and commit the result.`)
      process.exit(1)
    }
    console.log("registry up to date")
    return
  }
  for (const [path, value] of outputs) await writeJson(path, value)
  const noHash = contracts.filter((c) => c.codeHash === null)
  console.log(
    JSON.stringify(
      {
        contracts: contracts.length,
        withoutCodeHash: noHash.map((c) => `${c.id} (${c.codeHashSource})`),
        reviewed: reviewed.length,
        pinned: Object.fromEntries([...pinned].map(([id, p]) => [id, `${p.block} via ${new URL(p.url).host}`])),
      },
      null,
      1,
    ),
  )
}

await main()
