import { type Address, decodeFunctionResult, encodeFunctionData, type Hex } from "viem"
import { SAFE_ABI, ZODIAC_ABI } from "@/core/abis"
import { EMPTY_CODE_HASH, SENTINEL, SLOTS } from "@/core/constants"
import { type ZodiacPlan, type ZodiacReads } from "@/core/modules"
import { accountKind, isPrecompile } from "@/core/owners"
import { entriesOf, identify, knownAs, parseEip1167, parseEip7702, SUPPORTED_VERSIONS } from "@/core/registry"
import type { AccountKind, Comparison, Identification, OwnerRow } from "@/core/report"
import { slotKey, wordAddress } from "@/core/slots"
import { type RunState, worst } from "@/check/state"

export type Inspected = {
  address: Address
  kind: AccountKind
  delegate: Address | null
  // null for accounts without code of their own (EOA, delegated EOA, precompile).
  identification: Identification | null
  safe: OwnerRow["safe"]
}

// Proves the account, identifies its code by hash (resolving EIP-1167 and EIP-7702 through its code when the hash is
// not known), and for owners and modules looks one level into an account that is a Safe.
export async function inspectAccount(
  run: RunState,
  address: Address,
  { oneLevel = false, sourcify = false }: { oneLevel?: boolean; sourcify?: boolean } = {},
): Promise<Inspected> {
  if (isPrecompile(address)) return { address, kind: "precompile", delegate: null, identification: null, safe: null }

  const read = await run.prove(address, [])
  const codeHash = read.account?.codeHash ?? null
  if (codeHash === null || codeHash.toLowerCase() === EMPTY_CODE_HASH) {
    return { address, kind: "eoa", delegate: null, identification: null, safe: null }
  }

  let identification = identify(run.registry, run.chainId, { address, codeHash })
  let code: Hex | null = null
  if (identification.status === "unknown") {
    code = await run.deps.reader.code(address, codeHash)
    const delegate = parseEip7702(code)
    if (delegate !== null) return { address, kind: "delegated-eoa", delegate, identification: null, safe: null }
    const implementation = parseEip1167(code)
    if (implementation !== null) {
      const implementationRead = await run.prove(implementation, [])
      identification = identify(run.registry, run.chainId, {
        address,
        codeHash,
        implementation: { address: implementation, codeHash: implementationRead.account?.codeHash ?? EMPTY_CODE_HASH },
      })
    }
  }
  // Sourcify is a public indexer: asked only when the user allows public indexers.
  if (sourcify && identification.status === "unknown" && run.deps.publicIndexers !== false) {
    const result = await run.deps.sourcify.match(run.chainId, address)
    if (result.ok) identification = { ...identification, sourcify: result.data }
    else {
      run.issue(result.issue)
      identification = { ...identification, sourcify: "error" }
    }
  }

  const safe = oneLevel && knownAs(run.registry, identification, ["proxy"]) ? await safeOneLevel(run, address) : null
  const { kind, delegate } = accountKind({ address, codeHash, code, safe: safe !== null })
  return { address, kind, delegate, identification, safe }
}

// Version, owners and threshold of an owner that is a Safe, one level deep; null when its singleton is not supported.
export async function safeOneLevel(run: RunState, address: Address): Promise<OwnerRow["safe"]> {
  const read = await run.prove(address, [slotKey(SLOTS.singleton), slotKey(SLOTS.ownerCount), slotKey(SLOTS.threshold)])
  const singleton = wordAddress(read.values.get(slotKey(SLOTS.singleton)) ?? 0n)
  const singletonRead = await run.prove(singleton, [])
  if (singletonRead.account === null) return null
  const identification = identify(run.registry, run.chainId, {
    address: singleton,
    codeHash: singletonRead.account.codeHash,
  })
  const version = entriesOf(run.registry, identification).find((entry) => entry.kind === "singleton")?.ref.version
  if (version === undefined || !SUPPORTED_VERSIONS.includes(version)) return null

  const call = await run.tryCall(address, encodeFunctionData({ abi: SAFE_ABI, functionName: "getOwners" }))
  let owners: Address[] = []
  try {
    if (call !== null) owners = [...decodeFunctionResult({ abi: SAFE_ABI, functionName: "getOwners", data: call.data })]
  } catch {
    // An answer that does not decode leaves the owners unknown; the version and threshold still come from proofs.
  }
  return { version, owners, threshold: (read.values.get(slotKey(SLOTS.threshold)) ?? 0n).toString() }
}

type ZodiacGetter =
  | "owner"
  | "avatar"
  | "target"
  | "getGuard"
  | "oracle"
  | "template"
  | "questionTimeout"
  | "questionCooldown"
  | "answerExpiration"
  | "minimumBond"
  | "questionArbitrator"

// The Zodiac getters of `plan`, each by eth_call at the anchor. A getter that fails reads as null ("not read").
export async function zodiacReads(run: RunState, module: Address, plan: ZodiacPlan): Promise<ZodiacReads> {
  const cross: Comparison[] = []
  const get = async (functionName: ZodiacGetter): Promise<Address | bigint | number | null> => {
    const read = await run.tryCall(module, encodeFunctionData({ abi: ZODIAC_ABI, functionName }))
    if (read === null) return null
    cross.push(read.cross)
    try {
      return decodeFunctionResult({ abi: ZODIAC_ABI, functionName, data: read.data }) as Address | bigint | number
    } catch {
      return null
    }
  }
  const address = async (name: ZodiacGetter) => {
    const value = await get(name)
    return typeof value === "string" ? value : null
  }
  const number = async (name: ZodiacGetter) => {
    const value = await get(name)
    return typeof value === "bigint" || typeof value === "number" ? BigInt(value).toString() : null
  }

  const [owner, avatar, target] = await Promise.all([address("owner"), address("avatar"), address("target")])
  const guard = plan.guard ? await address("getGuard") : null

  let reality: ZodiacReads["reality"] = null
  if (plan.reality) {
    const [oracle, templateId, timeout, cooldown, expiration, minimumBond, arbitrator] = await Promise.all([
      address("oracle"),
      number("template"),
      number("questionTimeout"),
      number("questionCooldown"),
      number("answerExpiration"),
      number("minimumBond"),
      address("questionArbitrator"),
    ])
    if (
      oracle !== null &&
      templateId !== null &&
      timeout !== null &&
      cooldown !== null &&
      expiration !== null &&
      minimumBond !== null &&
      arbitrator !== null
    ) {
      reality = { oracle, templateId, timeout, cooldown, expiration, minimumBond, arbitrator }
    }
  }

  let modules: Address[] | null = null
  if (plan.modules) {
    const read = await run.tryCall(
      module,
      encodeFunctionData({ abi: ZODIAC_ABI, functionName: "getModulesPaginated", args: [SENTINEL, 100n] }),
    )
    if (read !== null) {
      cross.push(read.cross)
      try {
        const [array] = decodeFunctionResult({ abi: ZODIAC_ABI, functionName: "getModulesPaginated", data: read.data })
        modules = [...array]
      } catch {
        // A list that does not decode reads as not read.
      }
    }
  }
  return { owner, avatar, target, guard, reality, modules, cross: cross.length === 0 ? "not-run" : worst(cross) }
}
