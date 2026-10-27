// Contracts of the data layer: generated data files, settings, endpoints, capabilities, the I/O error class and the
// interfaces the check pipeline (src/check) calls. Implementations live in the other src/data files; the pipeline
// tests use fakes of these interfaces.
import { type Address, BaseError, type Hex } from "viem"
import type {
  CapabilityName,
  Comparison,
  EndpointRole,
  IssueKind,
  RawIoDetail,
  ReportIssue,
  RootCheckStatus,
  ServiceKind,
  ServiceRef,
  SourcifyStatus,
} from "@/core/report"
import type { ProvenAccount } from "@/core/proof"

// ---------------------------------------------------------------------------------------------------------------
// Generated: src/data/generated/chains.json (scripts/refresh-rpcs.ts)

export type ProviderPolicy = { id: string; name: string; hostSuffixes: string[]; aggregator: boolean }

export type DefaultRpc = {
  url: string
  // "drpc", "publicnode", ... or "team:<registrable domain>"
  operator: string
  operatorKind: "team" | "provider"
  aggregator: boolean
  // eth_getProof at latest - 3 verified against the block's stateRoot when probed. false: reachable with CORS and
  // serves the header at latest - 3, so it can be a cross-check but not a primary.
  proofs: boolean
  // Older files only; the probe times live in data/rpcs/refresh-meta.json.
  probedAt?: string
}

export type ChainInfo = {
  chainId: number
  name: string
  shortName: string
  // Safe{Wallet} prefixes that differ from EIP-3770 (for example "matic" for 137).
  shortNameAliases: string[]
  // Not written by the generator any more (nothing reads them); kept optional for fixtures.
  isTestnet?: boolean
  nativeCurrency?: { name: string; symbol: string; decimals: number }
  // https only.
  explorer: { url?: string; addressUrl: string } | null
  // Probed Blockscout API v2 base, for example "https://gnosisscan.io/api/v2"; null when none passed.
  blockscoutApi: string | null
  // From the Safe Config Service `transactionService`, with "/api/v1" appended; null when Safe has no service.
  safeTxServiceApi: string | null
  safeWallet: boolean
  // Lower is tried first by chain detection.
  detectRank: number
  rootCheck: { status: RootCheckStatus; reason: string }
  // Ranked; primaries come from entries with `proofs: true`.
  rpcs: DefaultRpc[]
}

export type SourceMeta = { url: string; fetchedAt: string; etag: string | null; sha256: string; bytes: number }

// Sources, probe times and coverage are in data/rpcs/refresh-meta.json; this file holds only what the app reads, so a
// refresh diff shows RPCs added, removed and re-ranked.
export type ChainsFile = {
  schema: 1
  generatedAt?: string
  probedAt?: string[]
  safeDeploymentsVersion: string
  sources?: Record<string, SourceMeta>
  providers: ProviderPolicy[]
  chains: Record<string, ChainInfo>
}

// ---------------------------------------------------------------------------------------------------------------
// Generated: src/data/generated/known-contracts.json (scripts/build-registry.ts)

export type ContractKind =
  | "singleton"
  | "proxy"
  | "proxy-factory"
  | "fallback-handler"
  | "module"
  | "modifier"
  | "guard"
  | "setup-helper"
  | "library"
  | "owner-signer"
  | "factory"
  | "other"

export type KnownFlag = "l2" | "zksync" | "eip155" | "faulty" | "legacy" | "writes-safe-storage" | "keeps-safe-state"

export type KnownContract = {
  // "Safe@1.4.1/canonical", "zodiac/delay@1.1.1", "SafeProxy@1.3.0", "reviewed/RealityVetoModule/1/0x4210…"
  id: string
  name: string
  version: string
  kind: ContractKind
  roles: ContractKind[]
  address: Address | null
  // keccak256 of the runtime code, the account codeHash in eth_getProof.
  codeHash: Hex | null
  // "package" | "onchain:<chainId>@<block>" | "derived:proxyCreationCode@<chainId>:<block>" | "sampled:<chainId>:<address>"
  codeHashSource: string
  chains: number[] | "any-evm"
  flags: KnownFlag[]
  // For "writes-safe-storage": which slots, in words.
  writes: string | null
  source: {
    origin: "safe-deployments" | "safe-modules-deployments" | "zodiac" | "reviewed" | "derived"
    package: string | null
    version: string | null
    path: string | null
    deploymentType: "canonical" | "eip155" | "zksync" | null
    url: string | null
    reviewedOn: string | null
  }
}

export type KnownContractsFile = {
  schema: 1
  packages: { name: string; version: string }[]
  contracts: KnownContract[]
}

// Hand-reviewed contracts that no package lists, in src/data/reviewed-contracts.json. Contracts with immutables have
// one code hash per deployment, so an entry matches only on its chain, address and code hash together. An entry counts
// only once a maintainer filled `reviewedBy` and `reviewedOn` (YYYY-MM-DD); empty strings mean not reviewed yet, and
// `reviewedContracts()` in src/data/reviewed.ts leaves such entries out.
export type ReviewedContract = {
  name: string
  version: string | null
  kind: ContractKind
  chainId: number
  address: Address
  codeHash: Hex
  sourceUrl: string
  reviewedOn: string
  reviewedBy: string
  note: string
}

// ---------------------------------------------------------------------------------------------------------------
// Settings (localStorage, src/data/settings.ts). Keys stay here and in request headers or query strings only: never
// in the URL hash, the report, the Markdown summary or an issue's raw detail.

// Defined in src/data/constants.ts so the settings code stays out of viem.
export { SETTINGS_STORAGE_KEY } from "@/data/constants"

export type ChainRpcSettings = {
  primary: string | null
  crossCheck: string | null
  // false: use only the RPCs above, never the defaults (the address goes nowhere else).
  useDefaults: boolean
  // The primary is the user's own node: when no other operator can cross-check, its header is accepted alone
  // (agreement "self-trusted"). Off by default; never applies to a default RPC.
  ownNode?: boolean
}

export type Settings = {
  schema: 1
  rpcs: Record<string, ChainRpcSettings>
  safeTxService: { enabled: boolean; apiKey: string | null }
  etherscan: { apiKey: string | null }
  // Keyless public indexers (Blockscout, Sourcify); on when absent. Independent of the default RPCs.
  publicIndexers?: boolean
}

// ---------------------------------------------------------------------------------------------------------------
// Endpoints and capabilities

export type Endpoint = {
  url: string
  host: string
  // Same ids as DefaultRpc.operator; a user URL on a known provider's host gets that provider's id, anything else
  // "user:<registrable domain>".
  operator: string
  operatorName: string
  aggregator: boolean
  origin: "default" | "user"
  // The user marked this primary as their own node (ChainRpcSettings.ownNode).
  ownNode?: boolean
}

// The cross-check is a different operator and never a second aggregator.
export type EndpointPair = { primary: Endpoint; crossCheck: Endpoint | null; crossCheckMissing: string | null }

export type Capability<T = true> =
  { status: "unknown" } | { status: "yes"; value: T } | { status: "no"; issue: ReportIssue }

// Probed lazily on first need and cached per (chainId, url) for the page session.
export type EndpointCapabilities = {
  chainId: Capability<number>
  clientVersion: string | null
  proofs: Capability<"archive" | "recent" | "tip-only">
  archiveCall: Capability
  storageAt: Capability
  logs: Capability<{ maxRange: number }>
  prestateTrace: Capability
  callTrace: Capability
  storageRange: Capability
}

export type CapabilityReport = {
  host: string
  available: CapabilityName[]
  missing: CapabilityName[]
  // web3_clientVersion, for the verification section's endpoint refs; null when the node did not say.
  clientVersion?: string | null
}

// ---------------------------------------------------------------------------------------------------------------
// Errors

// What the transport saw, before classification into an IssueKind.
export type RawFailure =
  | { kind: "fetch-failed"; message: string; answeredBefore: boolean }
  | { kind: "csp"; url: string }
  | { kind: "timeout"; afterMs: number }
  | { kind: "aborted" }
  | { kind: "http"; status: number; body: string; retryAfterMs: number | null }
  | { kind: "json"; body: string }
  | { kind: "rpc"; code: number; message: string; data: unknown }
  | { kind: "shape"; message: string }
  | { kind: "api"; message: string; status: number | null }

export type IssueContext = {
  service: ServiceKind
  host: string
  role: EndpointRole
  operation: string
  raw: RawIoDetail
}

// Every failed I/O call throws this. It extends viem's BaseError and has no `code` field, so viem's request wrapper
// rethrows it unchanged when it comes out of our custom transport. Find it in a viem error with
// `err.walk((e) => e instanceof IoError)`.
export class IoError extends BaseError {
  override name = "IoError"
  readonly issue: ReportIssue

  constructor(issue: ReportIssue) {
    super(`${issue.title}: ${issue.host} (${issue.operation})`)
    this.issue = issue
  }

  get kind(): IssueKind {
    return this.issue.kind
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Reads

// A block header that proven reads verify against. `header` says whether a second operator returned the same hash and
// stateRoot for `number` ("match"), a different one ("mismatch"), or could not be asked ("not-served", "not-run").
export type Anchor = {
  number: bigint
  hash: Hex
  stateRoot: Hex
  timestamp: bigint
  pinnedBy: "offset" | "user" | "tip"
  // Why the pin is not `latest - 3`, in plain words; null when it is.
  note: string | null
  header: Comparison
  // The primary is the user's own node and no other operator confirmed the header (verification.agreement
  // "self-trusted").
  selfTrusted?: boolean
  // Set when no endpoint proves this block. proveAccount then always throws method-unsupported, and state comes from
  // readUnproven. "unsupported": the chain's proofs are not Merkle Patricia proofs; "no-proof-rpc": no RPC serves
  // eth_getProof for this block.
  headerOnly?: "unsupported" | "no-proof-rpc"
}

export type ProvenAccountRead = {
  address: Address
  // The header this read verified against. Every read of a run shares the run's anchor, except in tip mode, where
  // each eth_getProof is taken at "latest" and tied to its block by matching keccak256(accountProof[0]) to a header's
  // stateRoot. In tip mode a read of the Safe re-requests every key asked for so far, so the last read of the Safe
  // holds the whole key set at one block.
  anchor: Anchor
  // null: the proof shows there is no account.
  account: ProvenAccount | null
  // Lowercase 32-byte keys to proven values; a requested key that is absent maps to 0n.
  values: ReadonlyMap<Hex, bigint>
  servedBy: string
  cross: { storageRoot: Comparison; values: Comparison; mismatched: Hex[] }
}

// Unproven: eth_getStorageAt per key and keccak256(eth_getCode) at the anchor, compared with the cross-check. For a
// header-only anchor or a chain without Merkle Patricia proofs (the primary's capabilities list "proofs" as missing,
// and proveAccount throws).
export type UnprovenAccountRead = {
  address: Address
  anchor: Anchor
  // null: no code.
  codeHash: Hex | null
  values: ReadonlyMap<Hex, bigint>
  servedBy: string
  cross: { values: Comparison; mismatched: Hex[] }
}

export type CallRead = { data: Hex; servedBy: string; cross: Comparison }

export type RawLog = {
  address: Address
  topics: Hex[]
  data: Hex
  blockNumber: bigint
  transactionHash: Hex
  logIndex: number
}

export type LogsQuery = { address: Address; fromBlock: bigint; toBlock: bigint; topic0?: Hex[] }

export type LogsRead = {
  logs: RawLog[]
  source: ServiceRef
  fromBlock: bigint
  // Last block covered; less than the query's toBlock when the read stopped early.
  toBlock: bigint
  complete: boolean
  issues: ReportIssue[]
  // Why an incomplete read stopped: the history time budget, the chunk or page cap, or a failure every log-capable
  // endpoint shared. Absent when complete.
  stoppedBy?: "time" | "cap" | "failure"
}

export type TxRead = {
  hash: Hex
  from: Address
  to: Address | null
  input: Hex
  blockNumber: bigint
  status: boolean
  // The same transaction and status read from the cross-check RPC, compared field by field.
  cross?: Comparison
  // Only the cross-check RPC had the transaction (every other RPC failed or answered null, as pruned indexes do):
  // one source, nothing compared.
  singleSource?: boolean
}

export type CallFrame = {
  type: string
  from: Address
  to: Address
  input: Hex
  value: bigint
  calls: CallFrame[]
}

// prestateTracer with diffMode: storage words per account before and after the transaction.
export type StorageDiff = Record<Address, { pre: Record<Hex, Hex>; post: Record<Hex, Hex> }>

export type CreationLookup =
  | { found: true; txHash: Hex; blockNumber: bigint; source: ServiceRef }
  | { found: false; tried: ServiceRef[]; issues: ReportIssue[] }

// ---------------------------------------------------------------------------------------------------------------
// Interfaces the pipeline uses

export interface StateReader {
  readonly chain: ChainInfo
  pair(): EndpointPair
  // Call once per run, first. Order: latest - 3 on the primary, the same block on the other proof candidates, then
  // tip mode, then a header-only anchor (storage unproven). A user block is used as given or the call fails.
  anchor(request: { block: bigint | null }): Promise<Anchor>
  // eth_getProof, verified with src/core/proof.ts against the read's anchor, cross-checked inline.
  proveAccount(address: Address, slots: readonly Hex[]): Promise<ProvenAccountRead>
  // eth_getCode at the anchor; throws invalid-response unless keccak256(code) equals `provenCodeHash`.
  code(address: Address, provenCodeHash: Hex): Promise<Hex>
  // eth_call at the anchor; reverts throw IoError kind "reverted".
  call(to: Address, data: Hex): Promise<CallRead>
  transaction(hash: Hex): Promise<TxRead>
  receiptLogs(hash: Hex): Promise<RawLog[]>
  callTrace(hash: Hex): Promise<CallFrame>
  storageDiff(hash: Hex): Promise<StorageDiff>
  // Every non-zero slot at the anchor, when an endpoint serves debug_storageRangeAt; keys are lowercase.
  storageRange(address: Address): Promise<{ values: ReadonlyMap<Hex, bigint>; complete: boolean }>
  // Re-reads the block hash of `anchor` on both endpoints.
  recheckAnchor(anchor: Anchor): Promise<"unchanged" | "changed">
  capabilities(): CapabilityReport[]
  // Storage and code without proofs, for when proveAccount cannot run (see UnprovenAccountRead).
  readUnproven(address: Address, slots: readonly Hex[]): Promise<UnprovenAccountRead>
}

export interface EventSource {
  // Picks RPC eth_getLogs, Blockscout or Etherscan by cost and availability (docs/ARCHITECTURE.md, history).
  logs(query: LogsQuery, onProgress?: (doneBlocks: bigint, totalBlocks: bigint) => void): Promise<LogsRead>
  // Keeps the logs whose transaction receipt on the cross-check RPC (the primary when there is none) contains them, so an
  // independent operator confirms every event that clears a finding.
  confirm(logs: readonly RawLog[]): Promise<{ confirmed: RawLog[]; unconfirmed: RawLog[] }>
}

export interface CreationFinder {
  find(safe: Address, anchorBlock: bigint): Promise<CreationLookup>
}

export type ApiResult<T> = { ok: true; data: T; source: ServiceRef } | { ok: false; issue: ReportIssue }

// Subsets of the Safe Transaction Service responses that the checks read.
// Only the hash: the RPC confirms the transaction, and the checks decode it from there.
export type StsCreation = { transactionHash: Hex }

export type StsMultisigTx = {
  safeTxHash: Hex
  nonce: string
  to: Address
  value: string
  data: Hex | null
  operation: 0 | 1
  confirmationsRequired: number
  confirmations: { owner: Address }[]
  isExecuted: boolean
}

export type StsMessage = { messageHash: Hex; created: string; confirmations: { owner: Address }[] }

export type StsDelegate = { delegate: Address; delegator: Address; label: string }

export interface SafeTxService {
  readonly host: string
  creation(safe: Address): Promise<ApiResult<StsCreation>>
  queued(safe: Address, fromNonce: bigint): Promise<ApiResult<StsMultisigTx[]>>
  messages(safe: Address): Promise<ApiResult<StsMessage[]>>
  delegates(safe: Address): Promise<ApiResult<StsDelegate[]>>
}

export interface Sourcify {
  match(chainId: number, address: Address): Promise<ApiResult<SourcifyStatus>>
}

export type CheckDeps = {
  reader: StateReader
  events: EventSource
  creation: CreationFinder
  // null when the user turned the service off or the chain has none.
  safeTxService: SafeTxService | null
  // With public indexers off, `match` answers "not-checked" without a request.
  sourcify: Sourcify
  // The user's "Use public indexers (Blockscout, Sourcify)" setting for this run.
  publicIndexers?: boolean
  signal: AbortSignal
}

export type SessionOptions = {
  signal?: AbortSignal
  // Issues as they happen, including recovered ones, for live display.
  onIssue?: (issue: ReportIssue) => void
  // Injected in tests; the CLI uses Node's global fetch.
  fetch?: typeof fetch
  // Wall-clock budget of one history read, 90 s when absent; the CLI can raise it.
  historyBudgetMs?: number
}

export type SessionResult =
  | { ok: true; deps: CheckDeps }
  | { ok: false; reason: "unknown-chain" | "no-rpc"; message: string; issues: ReportIssue[] }

// src/data/session.ts: openSession(chainId, settings, options).
export type OpenSession = (chainId: number, settings: Settings, options?: SessionOptions) => Promise<SessionResult>

// ---------------------------------------------------------------------------------------------------------------
// Input and chain detection (src/data/input.ts, src/data/detect.ts)

export type ParsedInput = {
  address: Address
  chainId: number | null
  block: bigint | null
  form: "address" | "eip3770" | "safe-url" | "permalink"
}

export type InputErrorKind =
  "empty" | "not-an-address" | "bad-checksum" | "unknown-prefix" | "unknown-chain" | "bad-block" | "unsupported-url"

export type InputResult = { ok: true; input: ParsedInput } | { ok: false; error: InputErrorKind; message: string }

export type DetectResult = {
  chainId: number
  status: "safe" | "contract" | "empty" | "error"
  singleton: Address | null
  version: string | null
  issue: ReportIssue | null
}

export type DetectOptions = {
  // "popular": Safe{Wallet} chains with a default RPC. "all": every chain with one. "all" needs a user click.
  scope: "popular" | "all"
  signal?: AbortSignal
  onResult?: (result: DetectResult) => void
  fetch?: typeof fetch
}
