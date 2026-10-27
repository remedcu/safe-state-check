import { type Address, decodeEventLog, getAddress, type Hex, isAddressEqual, zeroAddress } from "viem"
import { SAFE_EVENTS_INDEXED, SAFE_EVENTS_PLAIN } from "@/core/abis"
import { EVENT_TOPICS, SENTINEL } from "@/core/constants"
import { finding } from "@/core/findings"
import type {
  ConfigState,
  Finding,
  FindingCode,
  HandlerSlot,
  HistoryEvent,
  HistorySection,
  Part,
  ServiceRef,
} from "@/core/report"
import type { RawLog } from "@/data/types"

type TopicName = keyof typeof EVENT_TOPICS

// topic0 of the events the Safe itself emits, which any code it delegatecalls can also emit from its address.
const SAFE_TOPICS = new Set<string>(
  [
    "SafeSetup",
    "AddedOwner",
    "RemovedOwner",
    "ChangedThreshold",
    "EnabledModule",
    "DisabledModule",
    "ChangedGuard",
    "ChangedModuleGuard",
    "ChangedFallbackHandler",
    "ChangedMasterCopy",
    "ApproveHash",
    "SignMsg",
    "ExecutionSuccess",
    "ExecutionFailure",
    "ExecutionFromModuleSuccess",
    "ExecutionFromModuleFailure",
  ].map((name) => EVENT_TOPICS[name as TopicName]),
)

// Events that set a setting, an approval or a signed message: the ones whose presence clears a finding, so the ones
// an independent RPC must confirm.
export const CLEARING_EVENTS: ReadonlySet<string> = new Set([
  "SafeSetup",
  "AddedOwner",
  "RemovedOwner",
  "ChangedThreshold",
  "EnabledModule",
  "DisabledModule",
  "ChangedGuard",
  "ChangedModuleGuard",
  "ChangedFallbackHandler",
  "ChangedMasterCopy",
  "ApproveHash",
  "SignMsg",
])

export type SafeLog = { name: TopicName; args: Record<string, unknown> }

// One log, decoded with whichever event shape fits it (1.4.1+ indexed, or 1.3.0 plain); null for a log that fits
// neither. A delegatecall can emit any log from the Safe's address, so a malformed one is skipped, never fatal.
export function decodeSafeLog(log: RawLog): SafeLog | null {
  if (!SAFE_TOPICS.has(log.topics[0]?.toLowerCase() ?? "")) return null
  for (const abi of [SAFE_EVENTS_INDEXED, SAFE_EVENTS_PLAIN]) {
    try {
      const { eventName, args } = decodeEventLog({
        abi,
        data: log.data,
        topics: log.topics as [Hex, ...Hex[]],
        strict: true,
      })
      return { name: eventName as TopicName, args: args as Record<string, unknown> }
    } catch {
      // The other shape may fit.
    }
  }
  return null
}

// Logs with a Safe event topic that do not decode in either shape.
export function undecodable(logs: readonly RawLog[]): number {
  return logs.filter((log) => SAFE_TOPICS.has(log.topics[0]?.toLowerCase() ?? "") && decodeSafeLog(log) === null).length
}

export type DecodedLog = { event: HistoryEvent; name: TopicName }

const text = (value: unknown) => (typeof value === "bigint" ? value.toString() : String(value))

function eventArgs({ name, args }: SafeLog): Record<string, string> {
  switch (name) {
    case "SafeSetup":
      return {
        owners: (args.owners as Address[]).join(","),
        threshold: text(args.threshold),
        to: text(args.initializer),
        fallbackHandler: text(args.fallbackHandler),
      }
    case "ChangedThreshold":
      return { threshold: text(args.threshold) }
    case "ApproveHash":
      return { hash: text(args.approvedHash), owner: text(args.owner) }
    case "SignMsg":
      return { hash: text(args.msgHash) }
    case "ExecutionSuccess":
    case "ExecutionFailure":
      return { txHash: text(args.txHash) }
    default: {
      // Owner, module, guard, handler and master-copy events carry one address.
      const address = Object.values(args)[0]
      return typeof address === "string" ? { address: getAddress(address) } : {}
    }
  }
}

// Decodes the Safe events this tool reads into `HistoryEvent`s, ordered as they happened. `confirmed` comes from the
// caller (an independent RPC's receipts). Logs that do not decode are left out; `undecodable` counts them.
export function decodeHistory(logs: readonly RawLog[], confirmed: (log: RawLog) => boolean = () => true): DecodedLog[] {
  const decoded: DecodedLog[] = []
  for (const log of logs) {
    const safeLog = decodeSafeLog(log)
    if (safeLog === null) continue
    decoded.push({
      name: safeLog.name,
      event: {
        name: safeLog.name,
        block: log.blockNumber.toString(),
        txHash: log.transactionHash,
        logIndex: log.logIndex,
        args: eventArgs(safeLog),
        confirmed: confirmed(log),
      },
    })
  }
  return decoded.sort(
    (a, b) => Number(BigInt(a.event.block) - BigInt(b.event.block)) || a.event.logIndex - b.event.logIndex,
  )
}

const EXECUTION_EVENTS: TopicName[] = [
  "ExecutionSuccess",
  "ExecutionFailure",
  "ExecutionFromModuleSuccess",
  "ExecutionFromModuleFailure",
]

function listWithout(list: readonly Address[], address: Address): Address[] {
  return list.filter((entry) => !isAddressEqual(entry, address))
}

// Replays the config events into the state they describe; by default only the confirmed ones. Owners start from
// SafeSetup; without it the initial owner set is unknown (`ownersKnown` false).
export function replayConfig(
  events: readonly DecodedLog[],
  { includeUnconfirmed = false }: { includeUnconfirmed?: boolean } = {},
): { state: ConfigState; ownersKnown: boolean } {
  const state: ConfigState = {
    singleton: null,
    owners: [],
    threshold: null,
    modules: [],
    guard: null,
    moduleGuard: null,
    fallbackHandler: null,
  }
  let ownersKnown = false
  const set = (address: Address | undefined) =>
    address !== undefined && !isAddressEqual(address, zeroAddress) ? address : null

  for (const { name, event } of events) {
    if (!event.confirmed && !includeUnconfirmed) continue
    const address = event.args.address === undefined ? undefined : getAddress(event.args.address)
    switch (name) {
      case "SafeSetup":
        state.owners = event.args.owners ? event.args.owners.split(",").filter(Boolean).map(getAddress) : []
        state.threshold = event.args.threshold ?? null
        state.fallbackHandler = set(event.args.fallbackHandler ? getAddress(event.args.fallbackHandler) : undefined)
        ownersKnown = true
        break
      case "AddedOwner":
        if (address) state.owners = [...listWithout(state.owners, address), address]
        break
      case "RemovedOwner":
        if (address) state.owners = listWithout(state.owners, address)
        break
      case "ChangedThreshold":
        state.threshold = event.args.threshold ?? state.threshold
        break
      case "EnabledModule":
        if (address) state.modules = [...listWithout(state.modules, address), address]
        break
      case "DisabledModule":
        if (address) state.modules = listWithout(state.modules, address)
        break
      case "ChangedGuard":
        state.guard = set(address)
        break
      case "ChangedModuleGuard":
        state.moduleGuard = set(address)
        break
      case "ChangedFallbackHandler":
        state.fallbackHandler = set(address)
        break
      case "ChangedMasterCopy":
        state.singleton = set(address)
        break
    }
  }
  return { state, ownersKnown }
}

// How the history was read, which decides the severity of a setting with no event: a missing event in a node's full
// log range is a fact (High); an indexer can drop events, so there it is unconfirmed (Medium).
export type HistoryCoverage = "node-full" | "indexer" | "partial"

export type HistoryInput = {
  source: ServiceRef
  fromBlock: bigint
  toBlock: bigint
  coverage: HistoryCoverage
  logs: readonly RawLog[]
  confirmed: (log: RawLog) => boolean
  // The proven current state.
  current: ConfigState
  // True when the Safe was created before 1.3.0, so there is no SafeSetup to seed the owners.
  createdBeforeSetup: boolean
  // The singleton the creation set (factory call or ProxyCreation event); null when the creation is unknown.
  creationSingleton: Address | null
}

const CONFIG_EVENTS = new Set<TopicName>([
  "SafeSetup",
  "AddedOwner",
  "RemovedOwner",
  "ChangedThreshold",
  "EnabledModule",
  "DisabledModule",
  "ChangedGuard",
  "ChangedModuleGuard",
  "ChangedFallbackHandler",
  "ChangedMasterCopy",
])

// Rebuilds the config from the events and names anything set now that no event set, when the history is complete.
// A setting explained only by events an independent RPC did not confirm is unconfirmed (Medium), never cleared.
export function checkHistory(input: HistoryInput): { section: HistorySection; findings: Finding[]; skipped: number } {
  const decoded = decodeHistory(input.logs, input.confirmed)
  const confirmedReplay = replayConfig(decoded)
  const claimedReplay = replayConfig(decoded, { includeUnconfirmed: true })
  // Slot 0 is set by the creation and changed only by ChangedMasterCopy (SafeMigration, SafeToL2Migration,
  // SafeToL2Setup); without either the singleton is unknown.
  const withSingleton = (state: ConfigState): ConfigState => ({
    ...state,
    singleton: state.singleton ?? input.creationSingleton,
  })
  const rebuilt = withSingleton(confirmedReplay.state)
  const claimed = withSingleton(claimedReplay.state)
  const findings: Finding[] = []
  const complete = input.coverage !== "partial" && !input.createdBeforeSetup && claimedReplay.ownersKnown

  const configEvents = decoded.filter(({ name }) => CONFIG_EVENTS.has(name)).map(({ event }) => event)
  const executions = {
    success: decoded.filter(({ name }) => name === "ExecutionSuccess").length,
    failure: decoded.filter(({ name }) => name === "ExecutionFailure").length,
    moduleSuccess: decoded.filter(({ name }) => name === "ExecutionFromModuleSuccess").length,
    moduleFailure: decoded.filter(({ name }) => name === "ExecutionFromModuleFailure").length,
    recent: decoded
      .filter(({ name }) => EXECUTION_EVENTS.includes(name))
      .map(({ event }) => event)
      .slice(-50),
  }

  const differences: HistorySection["differences"] = []
  // What a setting with no confirmed event gets: none when the history is incomplete; unconfirmed when only an
  // unconfirmed event explains it or the history came from an indexer; otherwise config-without-event.
  const judge = (subject: Address, inClaimed: boolean, technical: string) => {
    if (!complete) return
    const code: FindingCode =
      inClaimed || input.coverage === "indexer" ? "config-without-event-unconfirmed" : "config-without-event"
    findings.push(
      finding(code, "history", {
        subject,
        technical: inClaimed ? `${technical}; the event that set it was not confirmed by a second RPC` : technical,
      }),
    )
  }
  const inList = (list: readonly Address[], address: Address) => list.some((entry) => isAddressEqual(entry, address))
  const same = (a: Address | null, b: Address) => a !== null && isAddressEqual(a, b)

  for (const module of input.current.modules) {
    if (inList(rebuilt.modules, module)) continue
    differences.push({ field: "modules", current: module, fromEvents: "not enabled by any confirmed event" })
    judge(
      module,
      inList(claimed.modules, module),
      `Module ${module} is enabled now, but no EnabledModule event announced it`,
    )
  }
  for (const [field, label] of [
    ["guard", "guard"],
    ["moduleGuard", "module guard"],
    ["fallbackHandler", "fallback handler"],
  ] as const) {
    const current = input.current[field]
    if (current === null || same(rebuilt[field], current)) continue
    differences.push({ field, current, fromEvents: rebuilt[field] ?? "none" })
    judge(current, same(claimed[field], current), `The ${label} is ${current} now, but no event in the history set it`)
  }
  // Slot 0 differs from the creation's singleton and from the last ChangedMasterCopy: something wrote it without the
  // event (for example a delegatecall swapping one canonical singleton for another).
  const singleton = input.current.singleton
  if (singleton !== null && rebuilt.singleton !== null && !isAddressEqual(singleton, rebuilt.singleton)) {
    differences.push({ field: "singleton", current: singleton, fromEvents: rebuilt.singleton })
    judge(
      singleton,
      same(claimed.singleton, singleton),
      `The singleton (slot 0) is ${singleton} now, but the creation set ${input.creationSingleton ?? "another one"} and no ChangedMasterCopy changed it`,
    )
  }
  for (const owner of complete ? input.current.owners : []) {
    if (inList(rebuilt.owners, owner)) continue
    differences.push({ field: "owners", current: owner, fromEvents: "not added by any confirmed event" })
    judge(owner, inList(claimed.owners, owner), `Owner ${owner} is set now, but no event added it`)
  }

  if (!complete) {
    findings.push(
      finding("history-incomplete", "history", {
        technical: input.createdBeforeSetup
          ? "The Safe was created before version 1.3.0, which has no SafeSetup event, so its initial owners are unknown"
          : input.coverage === "partial"
            ? "Not every block since creation could be read, so a setting changed without its event cannot be ruled out"
            : "The history has no SafeSetup event, so the initial owners are unknown",
      }),
    )
  }

  return {
    section: {
      source: input.source,
      fromBlock: input.fromBlock.toString(),
      toBlock: input.toBlock.toString(),
      complete,
      configEvents,
      executions,
      rebuilt,
      differences,
    },
    findings,
    skipped: undecodable(input.logs),
  }
}

// The part of the event history that was read, when it is not the whole range from creation to the anchor: an
// absent event is then not proven absent. Null when the whole range was read (a missing SafeSetup alone does not
// matter here); "none" when no block was read.
export type ReadRange = { from: string; to: string } | "none" | null

export function historyReadRange(history: Part<HistorySection>, createdAt: bigint | null, anchor: bigint): ReadRange {
  if (history.state === "unavailable" || history.state === "skipped") return "none"
  const { fromBlock, toBlock, complete } = history.data
  if (complete || (BigInt(fromBlock) <= (createdAt ?? 0n) && BigInt(toBlock) >= anchor)) return null
  return { from: fromBlock, to: toBlock }
}

// Ends "its event was not found ...".
export function readRangeText(range: Exclude<ReadRange, null>): string {
  return range === "none"
    ? "in the event history, which could not be read"
    : `in blocks ${range.from} to ${range.to}, the part of the event history that was read`
}

// Whether a confirmed event set a handler's current value: "unknown" while the history is incomplete.
export function announced(section: HistorySection, slot: HandlerSlot): HandlerSlot["announced"] {
  if (slot.address === null || !section.complete) return "unknown"
  const field = slot.role
  const rebuilt = section.rebuilt[field]
  return rebuilt !== null && isAddressEqual(rebuilt, slot.address) ? "yes" : "no"
}

export type EventApproval = { owner: Address; hash: Hex; confirmed: boolean }

// ApproveHash(bytes32 hash, address owner) events: both indexed on every version.
export function approveHashEvents(
  logs: readonly RawLog[],
  confirmed: (log: RawLog) => boolean = () => true,
): EventApproval[] {
  return logs.flatMap((log) => {
    const decoded = decodeSafeLog(log)
    if (decoded?.name !== "ApproveHash") return []
    return [
      {
        hash: (decoded.args.approvedHash as Hex).toLowerCase() as Hex,
        owner: getAddress(decoded.args.owner as Address),
        confirmed: confirmed(log),
      },
    ]
  })
}

export type EventMessage = { hash: Hex; confirmed: boolean }

// SignMsg(bytes32 msgHash) events: indexed on every version.
export function signMsgEvents(
  logs: readonly RawLog[],
  confirmed: (log: RawLog) => boolean = () => true,
): EventMessage[] {
  return logs.flatMap((log) => {
    const decoded = decodeSafeLog(log)
    if (decoded?.name !== "SignMsg") return []
    return [{ hash: (decoded.args.msgHash as Hex).toLowerCase() as Hex, confirmed: confirmed(log) }]
  })
}

// safeTxHashes an ExecutionSuccess ran (indexed from 1.4.1, the first data word on 1.3.0).
export function executedHashes(logs: readonly RawLog[]): Set<string> {
  const hashes = new Set<string>()
  for (const log of logs) {
    const decoded = decodeSafeLog(log)
    if (decoded?.name === "ExecutionSuccess") hashes.add((decoded.args.txHash as Hex).toLowerCase())
  }
  return hashes
}

// Addresses the config events name, for diagnosis classification.
export function eventAddresses(section: HistorySection): Address[] {
  const addresses = new Set<Address>([SENTINEL])
  for (const event of section.configEvents) {
    for (const key of ["address", "fallbackHandler", "to"]) {
      if (event.args[key]) addresses.add(getAddress(event.args[key]))
    }
    for (const owner of (event.args.owners ?? "").split(",").filter(Boolean)) addresses.add(getAddress(owner))
  }
  return [...addresses]
}
