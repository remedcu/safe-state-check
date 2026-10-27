import { type Address, decodeFunctionResult, encodeFunctionData, type Hex, isAddressEqual, zeroAddress } from "viem"
import { SAFE_ABI } from "@/core/abis"
import { formula, pass1Slots, rootPass, storageRows } from "@/core/accounting"
import { checkConfig, type ConfigResult, nextModulesStart } from "@/core/config"
import {
  EMPTY_CODE_HASH,
  FALLBACK_HANDLER_SLOT,
  GUARD_SLOT,
  MODULE_GUARD_SLOT,
  SENTINEL,
  SLOTS,
} from "@/core/constants"
import { finding } from "@/core/findings"
import { checkIdentity, type IdentityResult } from "@/core/identity"
import { type ListWalk, MAX_LIST_LENGTH, walkList } from "@/core/linkedList"
import { identify, knownAs, named, parseEip7702, type Registry } from "@/core/registry"
import type { Finding, StorageSection } from "@/core/report"
import { moduleSlot, ownerSlot, sharedSignerSlot, slotKey, wordAddress } from "@/core/slots"
import { ioErrorOf } from "@/data/errors"
import type { ProvenAccountRead } from "@/data/types"
import { type RunState, StopRun } from "@/check/state"
import type { Inspected } from "@/check/steps/accounts"

// The Safe's first proof: every fixed slot and both list heads.
export const BASE_KEYS: readonly Hex[] = [
  slotKey(SLOTS.singleton),
  slotKey(SLOTS.ownerCount),
  slotKey(SLOTS.threshold),
  slotKey(SLOTS.nonce),
  slotKey(SLOTS.deprecatedDomainSeparator),
  GUARD_SLOT,
  FALLBACK_HANDLER_SLOT,
  MODULE_GUARD_SLOT,
  ownerSlot(SENTINEL),
  moduleSlot(SENTINEL),
]

const MODULES_PAGE = 100n

function word(read: ProvenAccountRead, key: Hex): bigint {
  return read.values.get(key.toLowerCase() as Hex) ?? 0n
}

function addressIn(value: bigint): Address | null {
  const address = wordAddress(value)
  return isAddressEqual(address, zeroAddress) ? null : address
}

export type IdentityOutcome = { read: ProvenAccountRead; result: IdentityResult }

// Whether the code answers getThreshold() and getOwners() like a Safe that is set up. A revert or an answer that does
// not decode is a no; any other failed read fails the step, because the answer is not known.
async function answersLikeSafe(run: RunState): Promise<boolean> {
  const read = async <T>(functionName: "getThreshold" | "getOwners"): Promise<T | null> => {
    try {
      const { data } = await run.call(run.safe, encodeFunctionData({ abi: SAFE_ABI, functionName }))
      return decodeFunctionResult({ abi: SAFE_ABI, functionName, data }) as T
    } catch (error) {
      const io = ioErrorOf(error)
      if (io !== null && io.kind !== "reverted") throw error
      return null
    }
  }
  const [threshold, owners] = await Promise.all([read<bigint>("getThreshold"), read<readonly Address[]>("getOwners")])
  return threshold !== null && owners !== null && threshold >= 1n && threshold <= BigInt(owners.length)
}

// Stops the run when the address is not a Safe: an EIP-7702 account, or code that is no known Safe proxy, whose slot 0
// is no known singleton, and that does not answer like a Safe. A Safe on unknown proxy code goes on (its findings say
// the code is not canonical).
async function stopUnlessSafe(run: RunState, codeHash: Hex, singleton: Address, singletonCodeHash: Hex | null) {
  const proxy = identify(run.registry, run.chainId, { address: run.safe, codeHash })
  if (knownAs(run.registry, proxy, ["proxy"])) return
  const code = await run.deps.reader.code(run.safe, codeHash)
  const delegate = parseEip7702(code)
  if (delegate !== null) {
    throw new StopRun(
      "not-a-safe",
      `${run.safe} is an account with an EIP-7702 delegation to ${delegate} on ${run.chain.name}, not a Safe. Check the address and the chain.`,
    )
  }
  const singletonId =
    singletonCodeHash === null
      ? null
      : identify(run.registry, run.chainId, { address: singleton, codeHash: singletonCodeHash })
  if (knownAs(run.registry, singletonId, ["singleton"]) || (await answersLikeSafe(run))) return
  throw new StopRun(
    "not-a-safe",
    `${run.safe} holds a contract that is not a Safe on ${run.chain.name}: its code is not a Safe proxy and it does not answer like one. Check the address and the chain.`,
  )
}

export async function identityStep(run: RunState): Promise<IdentityOutcome | null> {
  return run.step("identity", async (finish) => {
    const read = await run.prove(run.safe, BASE_KEYS)
    const block = read.anchor.number
    if (read.account === null) {
      throw new StopRun(
        "not-deployed",
        `There is no account at ${run.safe} on ${run.chain.name} at block ${block}. Check the address and the chain.`,
      )
    }
    if (read.account.codeHash.toLowerCase() === EMPTY_CODE_HASH) {
      throw new StopRun(
        "no-code",
        `${run.safe} has no contract code on ${run.chain.name} at block ${block}, so it is not a Safe. Check the address and the chain.`,
      )
    }

    const singletonSlot = word(read, slotKey(SLOTS.singleton))
    const singleton = wordAddress(singletonSlot)
    const singletonRead = await run.prove(singleton, [])
    const singletonCodeHash = singletonRead.account?.codeHash ?? null
    await stopUnlessSafe(
      run,
      read.account.codeHash,
      singleton,
      singletonCodeHash?.toLowerCase() === EMPTY_CODE_HASH ? null : singletonCodeHash,
    )
    const versionRead = await run.tryCall(run.safe, encodeFunctionData({ abi: SAFE_ABI, functionName: "VERSION" }))
    let versionCall: string | null = null
    try {
      if (versionRead !== null) {
        versionCall = decodeFunctionResult({ abi: SAFE_ABI, functionName: "VERSION", data: versionRead.data })
      }
    } catch {
      // A VERSION() that does not decode as a string reads as no answer.
    }

    const result = checkIdentity(run.registry, {
      chainId: run.chainId,
      safe: run.safe,
      proxyCodeHash: read.account.codeHash,
      singletonSlot,
      singletonCodeHash: singletonCodeHash?.toLowerCase() === EMPTY_CODE_HASH ? null : singletonCodeHash,
      versionCall,
    })
    run.addFindings(result.findings)
    run.setSection("identity", { state: "complete", data: result.section })
    if (result.unverified.length > 0) finish("degraded", result.unverified.map((item) => item.detail).join(" "))
    return { read, result }
  })
}

export type ConfigOutcome = {
  config: ConfigResult
  read: ProvenAccountRead
  // The walks the config rules judged, so the storage step can tell a corrupt list from one that changed.
  walks: { owners: ListWalk; modules: ListWalk }
  guard: Address | null
  moduleGuard: Address | null
  fallbackHandler: Address | null
}

async function getters(run: RunState) {
  const call = async <T>(fn: "getOwners" | "getThreshold" | "nonce"): Promise<T | null> => {
    const read = await run.tryCall(run.safe, encodeFunctionData({ abi: SAFE_ABI, functionName: fn }))
    if (read === null) return null
    try {
      return decodeFunctionResult({ abi: SAFE_ABI, functionName: fn, data: read.data }) as T
    } catch {
      return null
    }
  }
  const [owners, threshold, nonce] = await Promise.all([
    call<readonly Address[]>("getOwners"),
    call<bigint>("getThreshold"),
    call<bigint>("nonce"),
  ])

  let modules: Address[] | null = []
  let start: Address | null = SENTINEL
  while (start !== null && modules !== null) {
    const read = await run.tryCall(
      run.safe,
      encodeFunctionData({ abi: SAFE_ABI, functionName: "getModulesPaginated", args: [start, MODULES_PAGE] }),
    )
    if (read === null) {
      modules = null
      break
    }
    try {
      const [page, next] = decodeFunctionResult({ abi: SAFE_ABI, functionName: "getModulesPaginated", data: read.data })
      modules.push(...page)
      start = nextModulesStart(page, next)
    } catch {
      modules = null
    }
    if (modules !== null && modules.length > MAX_LIST_LENGTH) break
  }
  return { owners, threshold, nonce, modules }
}

// The getters seed the list keys; the lists are then walked from proven raw slots until the walk completes. Without
// eth_call that is one proof per entry.
export async function configStep(run: RunState): Promise<ConfigOutcome | null> {
  return run.step("config", async () => {
    const seeds = await getters(run)
    const keys = new Set<Hex>(BASE_KEYS)
    // Getters of an unknown singleton can return anything; they only seed the keys, so cap them.
    for (const owner of (seeds.owners ?? []).slice(0, MAX_LIST_LENGTH)) keys.add(ownerSlot(owner))
    for (const module of (seeds.modules ?? []).slice(0, MAX_LIST_LENGTH)) keys.add(moduleSlot(module))

    let read = await run.prove(run.safe, [...keys])
    for (let round = 0; round <= 2 * MAX_LIST_LENGTH + 2; round++) {
      const owners = walkList("owners", read.values)
      const modules = walkList("modules", read.values)
      const missing = [owners, modules].flatMap((walk, index) =>
        walk.problem?.kind === "unread" ? [(index === 0 ? ownerSlot : moduleSlot)(walk.problem.at)] : [],
      )
      if (missing.length === 0) break
      for (const key of missing) keys.add(key)
      read = await run.prove(run.safe, [...keys])
    }

    const walks = { owners: walkList("owners", read.values), modules: walkList("modules", read.values) }
    const config = checkConfig({ safe: run.safe, values: read.values, ...walks, getters: seeds })
    run.addFindings(config.findings)
    return {
      config,
      read,
      walks,
      guard: addressIn(word(read, GUARD_SLOT)),
      moduleGuard: addressIn(word(read, MODULE_GUARD_SLOT)),
      fallbackHandler: addressIn(word(read, FALLBACK_HANDLER_SLOT)),
    }
  })
}

// Owners the registry lists by address as the shared passkey signer. Their slots are read; whether they count as
// benign waits for the owner's proven code hash.
export function passkeyCandidates(registry: Registry, owners: readonly Address[]): Address[] {
  return owners.filter((owner) =>
    (registry.byAddress.get(owner.toLowerCase() as Hex) ?? []).some(
      (entry) => entry.ref.name === "SafeWebAuthnSharedSigner",
    ),
  )
}

// Storage pass 1: one proven read holding every key the configuration explains, its rows, and the root comparison.
export async function storageStep(
  run: RunState,
  identity: IdentityOutcome,
  configOutcome: ConfigOutcome,
  owners: Promise<Inspected[] | null>,
): Promise<StorageSection | null> {
  return run.step("storage", async (finish) => {
    const { config } = configOutcome
    const candidates = passkeyCandidates(run.registry, config.owners)
    const signers =
      candidates.length === 0
        ? []
        : ((await owners) ?? [])
            .filter((owner) => named(run.registry, owner.identification, "SafeWebAuthnSharedSigner"))
            .map((owner) => owner.address)
    const slots = pass1Slots({
      version: identity.result.section.version,
      owners: config.owners,
      modules: config.modules,
      slot6: config.slot6,
      passkeyCandidates: candidates,
      passkeySigners: signers,
    })

    run.pass1Slots = slots
    const read = await run.prove(
      run.safe,
      slots.map((slot) => slot.key),
    )
    run.safeAnchor = read.anchor
    if (read.account === null) throw new Error("The Safe's account disappeared between two reads")

    // No endpoint proves this block: the slots are shown unproven and the root is not rebuilt.
    const headerOnly = run.headerOnly
    if (headerOnly !== null) {
      const unprovenRows = storageRows(slots, {
        values: read.values,
        cross: read.cross.values,
        mismatched: read.cross.mismatched,
      }).map((row) => ({ ...row, proven: false }))
      const section: StorageSection = {
        support: headerOnly,
        supportReason:
          headerOnly === "no-proof-rpc"
            ? "No RPC served storage proofs (eth_getProof) for this block, so the storage root cannot be rebuilt. Add an RPC that serves eth_getProof for recent blocks."
            : run.chain.rootCheck === "unsupported"
              ? `${run.chain.name} uses its own storage proof format, not standard Ethereum proofs, so the storage root cannot be rebuilt. This is the chain's design, not a fault of the RPC.`
              : "The RPCs answered with storage proofs that are not standard Ethereum proofs, so the storage root cannot be rebuilt.",
        actualRoot: null,
        formula: formula(slots, unprovenRows),
        passes: [],
        matchedBy: null,
        slots: unprovenRows,
      }
      run.setStorage(section)
      finish("degraded", section.supportReason)
      return section
    }

    // A list that changed between the config read and this one (tip mode) leaves the result unsure; a corrupt list
    // that walks the same way both times is already a list-corrupt finding.
    const gaps: string[] = []
    const same = (now: ListWalk, then: ListWalk) =>
      now.entries.length === then.entries.length &&
      now.entries.every((entry, index) => isAddressEqual(entry, then.entries[index])) &&
      now.problem?.kind === then.problem?.kind
    if (
      !same(walkList("owners", read.values), configOutcome.walks.owners) ||
      !same(walkList("modules", read.values), configOutcome.walks.modules)
    ) {
      gaps.push("The owner or module list changed between two reads of the same check. Run the check again.")
    }

    const rows = storageRows(slots, {
      values: read.values,
      cross: read.cross.values,
      mismatched: read.cross.mismatched,
    })
    const pass = await rootPass("config", rows, read.account.storageHash)
    const section: StorageSection = {
      support: "supported",
      supportReason: "",
      actualRoot: read.account.storageHash,
      formula: formula(slots, rows),
      passes: [pass],
      matchedBy: pass.match ? "config" : null,
      slots: rows,
    }

    const findings: Finding[] = []
    for (const row of rows) {
      // Slot 6 has its own finding from the config rules.
      if (row.status !== "suspicious" || row.key === slotKey(SLOTS.deprecatedDomainSeparator)) continue
      findings.push(
        finding("unexplained-storage", "storage", {
          subject: row.key,
          technical: `${row.technical} holds ${row.value}: ${row.meaning}`,
          evidence: [{ kind: "slot", key: row.key, value: row.value }],
        }),
      )
    }
    for (const signer of signers) {
      const base = BigInt(sharedSignerSlot(signer))
      const keys = new Set([0n, 1n, 2n].map((offset) => slotKey(base + offset)))
      const present = rows.filter((row) => keys.has(row.key))
      if (present.length === 0) continue
      findings.push(
        finding("passkey-signer-slots", "storage", {
          subject: signer,
          technical: `${present.length} slots at SIGNER_SLOT of ${signer} hold the passkey's x, y and verifiers`,
          evidence: present.map((row) => ({ kind: "slot" as const, key: row.key, value: row.value })),
        }),
      )
    }
    // A pass-1 mismatch is not a finding yet: pass 2 or diagnosis may still explain it.
    run.addFindings(findings)
    run.setStorage(section, gaps)
    if (gaps.length > 0) finish("degraded", gaps.join(" "))
    else if (!pass.match) finish("done", "The rebuilt root does not match the proven storage root.")
    return section
  })
}
