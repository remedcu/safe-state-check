// A fake data layer over appendix B slot maps: every account, slot, call and creation detail comes from a plain
// description of the chain, so pipeline tests run without a network. Proofs are not re-verified here (the reader does
// that, see src/core/__tests__/proof.test.ts); values come straight from the slot maps.
import {
  type Address,
  decodeFunctionData,
  encodeAbiParameters,
  encodeFunctionResult,
  getAddress,
  type Hex,
  isAddressEqual,
  keccak256,
  pad,
  toHex,
} from "viem"
import { B1, B3 } from "@/core/__tests__/fixtures/appendixB"
import { ADDRESS, HASH } from "@/core/__tests__/fixtures/registry"
import { SAFE_ABI, ZODIAC_ABI } from "@/core/abis"
import { EMPTY_CODE_HASH, EVENT_TOPICS, FALLBACK_HANDLER_SLOT, SENTINEL } from "@/core/constants"
import { walkList } from "@/core/linkedList"
import type { IssueKind, ReportIssue, ServiceRef } from "@/core/report"
import { slotKey } from "@/core/slots"
import { type StorageEntry, storageRoot } from "@/core/trie"
import {
  type Anchor,
  type CallFrame,
  type ChainInfo,
  type CheckDeps,
  type CreationLookup,
  type Endpoint,
  type EndpointPair,
  IoError,
  type ProvenAccountRead,
  type RawLog,
  type StateReader,
  type StorageDiff,
  type StsDelegate,
  type StsMessage,
  type StsMultisigTx,
  type TxRead,
} from "@/data/types"

export const B1_SAFE: Address = "0xAd219b3c26fe42BF5FC66F67490745a4fa5dff59"
export const B3_SAFE: Address = "0xB6b571A5Ea224152c57A230bf47c97574f6F2FaE"
export const B1_OWNER: Address = "0x802cbafa6133c493A7c67f685f97AdA5918d1dF9"
export const B1_REALITY: Address = "0x8DFc5Db2C83200Cf0cC84d7e3C441d7721ef83dC"
// eth_getCode at block 26176126.
export const B1_OWNER_CODE: Hex = "0xef01005a7fc11397e9a8ad41bf10bf13f22b0a63f96f6d"
export const B1_REALITY_CODE: Hex =
  "0x363d3d373d3d3d363d737276813b21623d89ba8984b225d5792943dd7dbf5af43d82803e903d91602b57fd5bf3"

export function issue(kind: IssueKind, overrides: Partial<ReportIssue> = {}): ReportIssue {
  return {
    kind,
    title: `Fake ${kind}`,
    explanation: `A fake ${kind} issue.`,
    actions: [],
    service: "rpc",
    host: "eth.drpc.org",
    role: "primary",
    operation: "read the Safe",
    step: null,
    transient: false,
    recovered: false,
    raw: {
      url: "https://eth.drpc.org",
      method: "eth_getProof",
      params: null,
      httpStatus: null,
      rpcCode: null,
      message: null,
      body: null,
      elapsedMs: 0,
      attempts: 1,
      at: "2026-10-12T00:00:00.000Z",
    },
    ...overrides,
  }
}

export function ioError(kind: IssueKind, overrides: Partial<ReportIssue> = {}): IoError {
  return new IoError(issue(kind, overrides))
}

export type FakeAccount = {
  // Runtime code; the code hash is its keccak256 unless `codeHash` is given (registry hashes without the code).
  code?: Hex
  codeHash?: Hex
  storage?: readonly StorageEntry[]
  // VERSION() for a Safe proxy.
  version?: string
  // Extra eth_call answers by function name (Zodiac getters), or an error to throw.
  calls?: Record<string, unknown>
  // getModulesPaginated paging as 1.3.0 does it (`next` is the first entry not returned).
  paging130?: boolean
}

export type FakeWorld = {
  accounts: Record<string, FakeAccount>
  anchor?: Partial<Anchor>
  pair?: Partial<EndpointPair>
  chain?: Partial<ChainInfo>
  creation?: {
    lookup: CreationLookup
    tx?: TxRead
    trace?: CallFrame
    logs?: RawLog[]
    diff?: StorageDiff
  }
  // Answers of recheckAnchor, one per call; "unchanged" when exhausted.
  rechecks?: ("unchanged" | "changed")[]
  // Throws for these reads: `${method}:${lowercase address}` or `${method}`.
  failures?: Record<string, IoError>
  // Throws for the proofs it returns an error for (for example only the read that holds a given slot).
  proofFailure?: (address: Address, slots: readonly Hex[]) => IoError | undefined
  // Block every proven read reports (default: the anchor's).
  readBlock?: bigint
  // The cross-check's comparison for every proven read (default: all match).
  cross?: ProvenAccountRead["cross"]
  // The Safe's event history. Default: a SafeSetup and an EnabledModule per module, so the history is complete and
  // explains the config. "none" makes the source return no logs (history-incomplete).
  history?: RawLog[] | "none"
  // Whether the fetched history covers creation to the anchor (default true) and who served it (default the RPC).
  historyComplete?: boolean
  historySource?: ServiceRef
  // Where and why an incomplete history read stopped: `at` is the last block read; `from` the oldest, for an indexer
  // that walks back from the anchor.
  historyStop?: { by: "time" | "cap" | "failure"; at: bigint; from?: bigint }
  // The Transaction Service queue. "off" removes the service (safeTxService null).
  queued?: StsMultisigTx[] | "off"
  // The Transaction Service's messages and delegates.
  stsMessages?: StsMessage[]
  stsDelegates?: StsDelegate[]
  // Logs the cross-check cannot confirm (default: it confirms every log).
  unconfirmed?: (log: RawLog) => boolean
  // The session's public-indexers setting (default: on).
  publicIndexers?: boolean
  // debug_storageRangeAt result for diagnosis.
  storageRange?: { values: ReadonlyMap<Hex, bigint>; complete: boolean }
}

export const PRIMARY: Endpoint = {
  url: "https://eth.drpc.org",
  host: "eth.drpc.org",
  operator: "drpc",
  operatorName: "dRPC",
  aggregator: true,
  origin: "default",
}
export const CROSS: Endpoint = {
  url: "https://ethereum-rpc.publicnode.com",
  host: "ethereum-rpc.publicnode.com",
  operator: "publicnode",
  operatorName: "PublicNode",
  aggregator: false,
  origin: "default",
}

export const CHAIN: ChainInfo = {
  chainId: 1,
  name: "Ethereum",
  shortName: "eth",
  shortNameAliases: [],
  isTestnet: false,
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  explorer: { url: "https://etherscan.io", addressUrl: "https://etherscan.io/address/{address}" },
  blockscoutApi: "https://eth.blockscout.com/api/v2",
  safeTxServiceApi: "https://api.safe.global/tx-service/eth/api/v1",
  safeWallet: true,
  detectRank: 0,
  rootCheck: { status: "supported", reason: "" },
  rpcs: [],
}

// Block 26176126 as recorded in src/core/__tests__/fixtures/proof-reward-distribution-26176126.json.
export const ANCHOR: Anchor = {
  number: 26176126n,
  hash: "0xbca7f5c0cd31c75f3e3221c076713002cf9952022b18060c16f4eeedf35ea119",
  stateRoot: "0x076e2e1a0629ea82b1069570b7426e70d1d2e9011c1674b882b4c02c10c40fe7",
  timestamp: 1791763200n,
  pinnedBy: "offset",
  note: null,
  header: "match",
}

function lower(value: string): string {
  return value.toLowerCase()
}

let logSeq = 0

// An event log attributed to `safe`, for the default and crafted test histories.
export function configEventLog(safe: Address, topics: Hex[], data: Hex = "0x"): RawLog {
  logSeq += 1
  return {
    address: getAddress(safe),
    topics,
    data,
    blockNumber: BigInt(logSeq),
    transactionHash: pad(toHex(logSeq), { size: 32 }),
    logIndex: 0,
  }
}

function addressFromWord(value: bigint): Address | null {
  if (value === 0n) return null
  return getAddress(toHex(value & ((1n << 160n) - 1n), { size: 20 }))
}

// A SafeSetup (1.4.1/1.5.0 indexing) plus an indexed EnabledModule per module and a ChangedFallbackHandler, so the
// replayed config matches the Safe's current state.
export function defaultHistory(world: FakeWorld): RawLog[] {
  const safeEntry = Object.entries(world.accounts).find(([, state]) => state.storage !== undefined)
  if (safeEntry === undefined) return []
  const safe = getAddress(safeEntry[0])
  const values = storageMap(safeEntry[1].storage ?? [])
  const owners = walkList("owners", values).entries
  const modules = walkList("modules", values).entries
  const handler = addressFromWord(values.get(FALLBACK_HANDLER_SLOT.toLowerCase() as Hex) ?? 0n)
  const threshold = values.get(slotKey(4n).toLowerCase() as Hex) ?? 1n

  const setupData = encodeAbiParameters(
    [{ type: "address[]" }, { type: "uint256" }, { type: "address" }, { type: "address" }],
    [
      owners,
      threshold,
      "0x0000000000000000000000000000000000000000",
      handler ?? "0x0000000000000000000000000000000000000000",
    ],
  )
  const logs: RawLog[] = [configEventLog(safe, [EVENT_TOPICS.SafeSetup, pad(safe, { size: 32 })], setupData)]
  if (handler !== null)
    logs.push(configEventLog(safe, [EVENT_TOPICS.ChangedFallbackHandler, pad(handler, { size: 32 })]))
  for (const module of modules) logs.push(configEventLog(safe, [EVENT_TOPICS.EnabledModule, pad(module, { size: 32 })]))
  return logs
}

function storageMap(entries: readonly StorageEntry[]): Map<Hex, bigint> {
  return new Map(entries.map(({ slot, value }) => [slot.toLowerCase() as Hex, value]))
}

function codeHashOf(account: FakeAccount): Hex {
  if (account.codeHash !== undefined) return account.codeHash
  return account.code === undefined || account.code === "0x" ? EMPTY_CODE_HASH : keccak256(account.code)
}

export type CallLog = { method: string; address?: Address; slots?: readonly Hex[]; data?: Hex }[]

export function fakeDeps(world: FakeWorld): { deps: CheckDeps; log: CallLog; controller: AbortController } {
  const log: CallLog = []
  const controller = new AbortController()
  const anchor: Anchor = { ...ANCHOR, ...world.anchor }
  const pair: EndpointPair = { primary: PRIMARY, crossCheck: CROSS, crossCheckMissing: null, ...world.pair }
  const rechecks = [...(world.rechecks ?? [])]
  // Like src/data/reader.ts requireAnchor: reads at the anchor fail until anchor() ran.
  let anchored = false
  const requireAnchor = () => {
    if (!anchored) throw new Error("anchor() must run first")
  }
  const account = (address: Address) => world.accounts[lower(address)]
  const fail = (method: string, address?: Address) => {
    const error =
      world.failures?.[address === undefined ? method : `${method}:${lower(address)}`] ?? world.failures?.[method]
    if (error !== undefined) throw error
  }

  const safeCall = (to: Address, state: FakeAccount, data: Hex): Hex => {
    const { functionName, args } = decodeFunctionData({ abi: SAFE_ABI, data })
    const values = storageMap(state.storage ?? [])
    const word = (slot: bigint) => values.get(toHex(slot, { size: 32 })) ?? 0n
    switch (functionName) {
      case "getOwners":
        return encodeFunctionResult({ abi: SAFE_ABI, functionName, result: walkList("owners", values).entries })
      case "getThreshold":
        return encodeFunctionResult({ abi: SAFE_ABI, functionName, result: word(4n) })
      case "nonce":
        return encodeFunctionResult({ abi: SAFE_ABI, functionName, result: word(5n) })
      case "VERSION":
        if (state.version === undefined) throw ioError("reverted", { operation: `call VERSION() on ${to}` })
        return encodeFunctionResult({ abi: SAFE_ABI, functionName, result: state.version })
      case "getModulesPaginated": {
        const [start, pageSize] = args
        const all = walkList("modules", values).entries
        const from = isAddressEqual(start, SENTINEL) ? 0 : all.findIndex((m) => isAddressEqual(m, start)) + 1
        const page = all.slice(from, from + Number(pageSize))
        const more = from + page.length < all.length
        const next = !more ? SENTINEL : state.paging130 ? all[from + page.length] : page[page.length - 1]
        return encodeFunctionResult({ abi: SAFE_ABI, functionName, result: [page, next] })
      }
      default:
        throw ioError("reverted", { operation: `call ${functionName} on ${to}` })
    }
  }

  const reader: StateReader = {
    chain: { ...CHAIN, ...world.chain },
    pair: () => pair,
    async anchor() {
      log.push({ method: "anchor" })
      fail("anchor")
      anchored = true
      return anchor
    },
    async proveAccount(address, slots): Promise<ProvenAccountRead> {
      requireAnchor()
      log.push({ method: "proveAccount", address, slots })
      // Like the reader: a header-only anchor refuses every proof.
      if (anchor.headerOnly) throw ioError("method-unsupported", { operation: `prove the account ${address}` })
      fail("proveAccount", address)
      const refused = world.proofFailure?.(address, slots)
      if (refused !== undefined) throw refused
      const state = account(address)
      const values = new Map<Hex, bigint>()
      const storage = storageMap(state?.storage ?? [])
      for (const slot of slots) values.set(slot.toLowerCase() as Hex, storage.get(slot.toLowerCase() as Hex) ?? 0n)
      return {
        address,
        anchor: world.readBlock === undefined ? anchor : { ...anchor, number: world.readBlock },
        account:
          state === undefined
            ? null
            : {
                nonce: 1n,
                balance: 0n,
                storageHash: await storageRoot(state.storage ?? []),
                codeHash: codeHashOf(state),
              },
        values,
        servedBy: PRIMARY.host,
        cross: world.cross ?? { storageRoot: "match", values: "match", mismatched: [] },
      }
    },
    async readUnproven(address, slots) {
      requireAnchor()
      log.push({ method: "readUnproven", address, slots })
      fail("readUnproven", address)
      const state = account(address)
      const storage = storageMap(state?.storage ?? [])
      const values = new Map<Hex, bigint>()
      for (const slot of slots) values.set(slot.toLowerCase() as Hex, storage.get(slot.toLowerCase() as Hex) ?? 0n)
      return {
        address,
        anchor: world.readBlock === undefined ? anchor : { ...anchor, number: world.readBlock },
        codeHash: state === undefined ? null : codeHashOf(state),
        values,
        servedBy: PRIMARY.host,
        cross: { values: "not-served", mismatched: [] },
      }
    },
    async code(address, provenCodeHash) {
      requireAnchor()
      log.push({ method: "code", address })
      fail("code", address)
      const state = account(address)
      const code = state?.code ?? "0x"
      if (keccak256(code) !== provenCodeHash)
        throw ioError("invalid-response", { operation: `read the code of ${address}` })
      return code
    },
    async call(to, data) {
      requireAnchor()
      log.push({ method: "call", address: to, data })
      fail("call", to)
      const state = account(to)
      if (state === undefined) return { data: "0x", servedBy: PRIMARY.host, cross: "match" }
      try {
        const { functionName } = decodeFunctionData({ abi: ZODIAC_ABI, data })
        if (state.calls !== undefined && functionName in state.calls) {
          const answer = state.calls[functionName]
          if (answer instanceof Error) throw answer
          return {
            data: encodeFunctionResult({ abi: ZODIAC_ABI, functionName, result: answer as never }),
            servedBy: PRIMARY.host,
            cross: "match",
          }
        }
      } catch (error) {
        if (error instanceof IoError) throw error
      }
      if (state.storage === undefined) throw ioError("reverted", { operation: `call ${to}` })
      return { data: safeCall(to, state, data), servedBy: PRIMARY.host, cross: "match" }
    },
    async transaction(hash) {
      log.push({ method: "transaction" })
      fail("transaction")
      if (world.creation?.tx === undefined) throw ioError("not-found", { operation: `read transaction ${hash}` })
      return world.creation.tx
    },
    async receiptLogs() {
      log.push({ method: "receiptLogs" })
      fail("receiptLogs")
      return world.creation?.logs ?? []
    },
    async callTrace() {
      log.push({ method: "callTrace" })
      fail("callTrace")
      if (world.creation?.trace === undefined) {
        throw ioError("method-unsupported", { operation: "trace the creation transaction", recovered: true })
      }
      return world.creation.trace
    },
    async storageDiff() {
      log.push({ method: "storageDiff" })
      fail("storageDiff")
      if (world.creation?.diff === undefined) {
        throw ioError("method-unsupported", { operation: "read the creation's storage diff", recovered: true })
      }
      return world.creation.diff
    },
    async storageRange() {
      requireAnchor()
      log.push({ method: "storageRange" })
      fail("storageRange")
      if (world.storageRange === undefined)
        throw ioError("method-unsupported", { operation: "enumerate the Safe's storage" })
      return world.storageRange
    },
    async recheckAnchor() {
      log.push({ method: "recheckAnchor" })
      fail("recheckAnchor")
      return rechecks.shift() ?? "unchanged"
    },
    capabilities: () => [{ host: PRIMARY.host, available: ["proofs", "archiveCall"], missing: ["logs"] }],
  }

  const historyLogs = world.history === "none" ? [] : (world.history ?? defaultHistory(world))
  const deps: CheckDeps = {
    reader,
    events: {
      async logs(query) {
        log.push({ method: "logs" })
        fail("logs")
        const matches = (entry: RawLog) =>
          !query.topic0?.length || query.topic0.some((t) => t.toLowerCase() === entry.topics[0]?.toLowerCase())
        return {
          logs: historyLogs.filter(matches),
          source: world.historySource ?? { service: "rpc", host: PRIMARY.host },
          fromBlock: world.historyStop?.from ?? query.fromBlock,
          toBlock: world.historyStop?.at ?? query.toBlock,
          complete: world.historyStop === undefined && (world.historyComplete ?? true),
          issues: [],
          ...(world.historyStop === undefined ? {} : { stoppedBy: world.historyStop.by }),
        }
      },
      async confirm(logs) {
        log.push({ method: "confirm", slots: logs.map((entry) => entry.transactionHash) })
        const unconfirmed = world.unconfirmed ?? (() => false)
        return { confirmed: logs.filter((entry) => !unconfirmed(entry)), unconfirmed: logs.filter(unconfirmed) }
      },
    },
    creation: {
      async find() {
        log.push({ method: "findCreation" })
        return (
          world.creation?.lookup ?? {
            found: false,
            tried: [{ service: "blockscout", host: "eth.blockscout.com" }],
            issues: [],
          }
        )
      },
    },
    safeTxService:
      world.queued === "off"
        ? null
        : {
            host: "api.safe.global",
            async creation() {
              return { ok: false, issue: issue("not-found", { service: "safe-tx-service", host: "api.safe.global" }) }
            },
            async queued() {
              return {
                ok: true,
                data: (world.queued ?? []) as never,
                source: { service: "safe-tx-service", host: "api.safe.global" },
              }
            },
            async messages() {
              const data = world.stsMessages ?? []
              return { ok: true, data, source: { service: "safe-tx-service", host: "api.safe.global" } }
            },
            async delegates() {
              const data = world.stsDelegates ?? []
              return { ok: true, data, source: { service: "safe-tx-service", host: "api.safe.global" } }
            },
          },
    sourcify: {
      async match() {
        log.push({ method: "sourcify" })
        return { ok: true, data: "not-verified", source: { service: "sourcify", host: "sourcify.dev" } }
      },
    },
    publicIndexers: world.publicIndexers,
    signal: controller.signal,
  }
  return { deps, log, controller }
}

// The Reward Distribution Safe (appendix B1) and every account it points at, as on Ethereum at block 26176126.
export function b1World(): FakeWorld {
  return {
    accounts: {
      [lower(B1_SAFE)]: { codeHash: HASH.proxy141, storage: B1, version: "1.4.1" },
      [lower(ADDRESS.safe141)]: { codeHash: HASH.safe141 },
      [lower(B1_OWNER)]: { code: B1_OWNER_CODE },
      [lower(ADDRESS.vetoModule)]: { codeHash: HASH.vetoModule },
      [lower(B1_REALITY)]: {
        code: B1_REALITY_CODE,
        calls: {
          owner: B1_SAFE,
          avatar: B1_SAFE,
          target: B1_SAFE,
          getGuard: "0x0000000000000000000000000000000000000000",
          oracle: "0x5b7dD1E86623548AF054A4985F7fc8Ccbb554E2c",
          template: 0n,
          questionTimeout: 86400,
          questionCooldown: 86400,
          answerExpiration: 604800,
          minimumBond: 10n ** 18n,
          questionArbitrator: "0x0000000000000000000000000000000000000000",
        },
      },
      [lower(ADDRESS.realityERC20)]: { codeHash: HASH.realityERC20 },
      [lower(ADDRESS.compat141)]: { codeHash: HASH.compat141 },
    },
  }
}

// The SEF veto Safe (appendix B3): 1.5.0, three EOA owners, no modules.
export function b3World(): FakeWorld {
  return {
    accounts: {
      [lower(B3_SAFE)]: { codeHash: HASH.proxy150, storage: B3, version: "1.5.0" },
      [lower(ADDRESS.safe150)]: { codeHash: HASH.safe150 },
      [lower(ADDRESS.compat150)]: { codeHash: HASH.compat150 },
      [lower("0xa3840d235de294e55c5ba4a3c57942617c7e3c05")]: { code: "0x" },
    },
  }
}

export function withStorage(world: FakeWorld, safe: Address, change: (entries: StorageEntry[]) => StorageEntry[]) {
  const key = lower(safe)
  const state = world.accounts[key]
  return { ...world, accounts: { ...world.accounts, [key]: { ...state, storage: change([...(state.storage ?? [])]) } } }
}

export function account(world: FakeWorld, address: Address, state: FakeAccount): FakeWorld {
  return { ...world, accounts: { ...world.accounts, [lower(getAddress(address))]: state } }
}
