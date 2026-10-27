// The report model: the one contract between the checks (src/core, src/check), the data layer (src/data) and the UI
// (src/ui). Everything here is plain JSON (no bigint, no Map, no class), so `JSON.parse(JSON.stringify(report))`
// gives back an equal value and the downloadable report is just `JSON.stringify(report, null, 2)`.
import type { Address, Hex } from "viem"

// Bump when a field is removed or changes meaning.
export const REPORT_SCHEMA = 1

// A non-negative integer in decimal. Storage words and block numbers can exceed 2^53.
export type DecString = string
// ISO 8601, UTC.
export type IsoTime = string

// ---------------------------------------------------------------------------------------------------------------
// Request and chain

export type CheckRequest = { address: Address; chainId: number; block: DecString | null }

// `rootCheck` from the generated chain list; a run can still find proofs work through a user RPC.
export type RootCheckStatus = "supported" | "unsupported" | "no-proof-rpc" | "no-rpc"

export type ChainRef = {
  chainId: number
  name: string
  shortName: string
  explorerAddressUrl: string | null
  rootCheck: RootCheckStatus
}

// ---------------------------------------------------------------------------------------------------------------
// Findings and verdict

export type Severity = "critical" | "high" | "medium" | "info"

// Severity is a fixed function of the code (table in docs/ARCHITECTURE.md, catalogue in src/core/findings.ts).
export type FindingCode =
  // critical
  | "shadow-owner"
  | "shadow-module"
  | "eoa-module"
  | "module-public-forwarder"
  // a slot that acts as a signature nobody gave: classified by preimage only, no matching event
  | "approval-without-event"
  | "signed-message-without-event"
  | "singleton-not-canonical"
  | "proxy-not-canonical"
  // high
  | "unexplained-storage"
  | "unknown-module"
  | "unknown-fallback-handler"
  | "setup-delegatecall-unknown"
  | "config-without-event"
  | "module-owner-not-safe"
  | "list-corrupt"
  | "getter-mismatch"
  | "owner-count-mismatch"
  | "threshold-invalid"
  | "slot6-unexpected"
  | "codehash-mismatch"
  // medium
  | "unknown-guard"
  | "unknown-module-guard"
  | "delegated-owner"
  | "contract-owner"
  | "pending-approved-hash"
  | "queued-transaction"
  | "factory-not-canonical"
  | "creation-callback-unknown"
  | "faulty-version"
  // the only source for the missing event was an indexer, which can drop events
  | "config-without-event-unconfirmed"
  // info
  | "setup-payment"
  | "version-behind"
  | "inert-owners"
  | "legacy-domain-separator"
  | "passkey-signer-slots"
  | "signed-message"
  | "handler-keeps-own-state"
  | "history-incomplete"
  | "same-address-other-chains"

export type SectionId =
  | "identity"
  | "owners"
  | "modules"
  | "handlers"
  | "storage"
  | "creation"
  | "history"
  | "pending"
  | "diagnosis"
  | "verification"
  | "crossChain"

export type Evidence =
  | { kind: "slot"; key: Hex; value: Hex }
  | { kind: "code"; address: Address; codeHash: Hex }
  | { kind: "event"; name: string; txHash: Hex; logIndex: number; block: DecString }
  | { kind: "tx"; txHash: Hex }
  | { kind: "call"; to: Address; fn: string; result: string }
  | { kind: "link"; label: string; url: string }

export type Finding = {
  code: FindingCode
  severity: Severity
  // Plain label first ("Hidden owner entry"), technical second ("owners[0x…02] = 0x…01 outside the list").
  title: string
  technical: string
  explanation: string
  subject: Address | Hex | null
  section: SectionId
  evidence: Evidence[]
}

// explained: root matches, proofs verify, anchor agreed by two operators, canonical code.
// unexplained: a verified root mismatch remains after the event pass and diagnosis.
// unverified: any reason below. Precedence: unverified, then unexplained, then explained.
export type VerdictKind = "explained" | "unexplained" | "unverified"

export type UnverifiedReason =
  | "root-check-unsupported"
  | "no-proof-rpc"
  | "single-operator"
  | "rpc-disagreement"
  | "proof-invalid"
  | "version-unsupported"
  | "code-not-canonical"
  | "reorg"
  | "read-failed"
  // a module, guard, handler or owner could not be inspected, so the finding counts are incomplete
  | "inspection-incomplete"
  // state was read without a proof on a chain whose proofs work
  | "unproven-read"
  // a slot looks like an approval or signed message, but its event may lie outside the history that was read
  | "history-incomplete"

// Which key set made the rebuilt root equal the real one.
export type RootMatch = "config" | "events" | "enumeration" | "traces" | "candidates"

export type Verdict = {
  kind: VerdictKind
  headline: string
  // At most three, most severe first.
  reasons: string[]
  unverified: { reason: UnverifiedReason; detail: string }[]
  matchedBy: RootMatch | null
  counts: Record<Severity, number>
}

// ---------------------------------------------------------------------------------------------------------------
// Summary cards (pre-rendered so UI, Markdown and CLI show the same words)

export type CardId =
  "version" | "owners" | "modules" | "guard" | "moduleGuard" | "fallbackHandler" | "nonce" | "storage"
export type Tone = "ok" | "warn" | "bad" | "neutral" | "unknown"
export type SummaryCard = { id: CardId; label: string; value: string; detail: string | null; tone: Tone }

// ---------------------------------------------------------------------------------------------------------------
// Sections

// A section the run could not fill completely says so instead of being absent.
export type Part<T> =
  | { state: "complete"; data: T }
  | { state: "partial"; data: T; gaps: string[] }
  | { state: "unavailable"; reason: string }
  | { state: "skipped"; reason: string }

export type Comparison = "match" | "mismatch" | "not-served" | "not-run"

export type RegistryOrigin = "safe-deployments" | "safe-modules-deployments" | "zodiac" | "reviewed" | "derived"

export type KnownRef = {
  id: string
  name: string
  version: string
  origin: RegistryOrigin
  // Reviewed entries are shown as "reviewed list", never as official.
  reviewed: { url: string; on: string } | null
}

export type SourcifyStatus = "exact_match" | "match" | "not-verified" | "not-checked" | "error"

// Identification goes by proven code hash first; the address is only a hint.
export type Identification = {
  status: "known" | "reviewed" | "unknown"
  codeHash: Hex
  via: "codehash" | "eip1167"
  implementation: Address | null
  matches: KnownRef[]
  address: "listed" | "other-address" | "listed-code-differs" | null
  sourcify: SourcifyStatus
}

// "unknown": the account could not be read, so its kind is not known (the row stays so the counts stay right).
export type AccountKind = "eoa" | "delegated-eoa" | "contract" | "safe" | "precompile" | "none" | "unknown"

export type IdentitySection = {
  proxy: { codeHash: Hex; identification: Identification }
  singleton: { address: Address; codeHash: Hex | null; identification: Identification | null }
  version: string | null
  l2: boolean | null
  // VERSION() through the proxy, compared with the singleton's registry version.
  versionCall: string | null
  supported: boolean
  latestVersion: string
}

export type OwnerRow = {
  address: Address
  kind: AccountKind
  delegate: Address | null
  identification: Identification | null
  // One level deep, for owners that are Safes.
  safe: { version: string | null; owners: Address[]; threshold: DecString } | null
  flags: FindingCode[]
}

export type OwnersSection = {
  owners: OwnerRow[]
  threshold: DecString
  ownerCount: DecString
  inertOnly: boolean
}

export type ZodiacDetails = {
  owner: Address | null
  avatar: Address | null
  target: Address | null
  // "absent" when the mastercopy has no getGuard (Delay 1.1.x, Roles 2.x).
  guard: Address | null | "absent"
  ownerIsSafe: boolean
  avatarIsSafe: boolean
  targetIsSafe: boolean
  reality: {
    oracle: Address
    templateId: DecString
    timeout: DecString
    cooldown: DecString
    expiration: DecString
    minimumBond: DecString
    arbitrator: Address
  } | null
  // A modifier's own module list, one level.
  modules: Address[] | null
  cross: Comparison
}

export type ModuleRow = {
  address: Address
  kind: AccountKind
  delegate: Address | null
  identification: Identification | null
  zodiac: ZodiacDetails | null
  flags: FindingCode[]
}

export type ModulesSection = { modules: ModuleRow[] }

export type HandlerSlot = {
  role: "guard" | "moduleGuard" | "fallbackHandler"
  // false for the module guard below 1.5.0
  applicable: boolean
  address: Address | null
  kind: AccountKind | null
  identification: Identification | null
  // Whether the history holds the event that set the current value.
  announced: "yes" | "no" | "unknown"
  flags: FindingCode[]
}

export type HandlersSection = { guard: HandlerSlot; moduleGuard: HandlerSlot; fallbackHandler: HandlerSlot }

export type SlotSource = "config" | "derived" | "event" | "trace" | "enumeration" | "candidate"
export type SlotStatus = "expected" | "benign" | "suspicious" | "unexplained"

export type StorageSlotRow = {
  key: Hex
  // 32-byte word.
  value: Hex
  meaning: string
  technical: string
  source: SlotSource
  status: SlotStatus
  // Verified against the account's storageHash; false only where the chain has no usable proofs.
  proven: boolean
  cross: Comparison
  // An approval or signed message found by its slot whose event was not in the part of the history that was read.
  eventNotRead?: true
}

export type RootPass = { by: RootMatch; slotCount: number; expectedRoot: Hex; match: boolean }

export type StorageSection = {
  support: "supported" | "unsupported" | "no-proof-rpc"
  supportReason: string
  actualRoot: Hex | null
  // For reading only; the root comparison is the check.
  formula: { total: number; parts: { label: string; count: number }[]; text: string }
  passes: RootPass[]
  matchedBy: RootMatch | null
  slots: StorageSlotRow[]
}

export type ServiceKind = "rpc" | "blockscout" | "safe-tx-service" | "etherscan" | "sourcify"
export type ServiceRef = { service: ServiceKind; host: string }

export type BatchCall = {
  operation: "call" | "delegatecall"
  to: Address
  value: DecString
  data: Hex
  fn: string | null
  identification: Identification | null
}

export type CreationSection = {
  txHash: Hex
  block: DecString
  timestamp: IsoTime | null
  source: ServiceRef
  factory: { address: Address; identification: Identification | null; method: string }
  singleton: Address | null
  saltNonce: DecString | null
  callback: { address: Address; identification: Identification | null } | null
  setup: {
    owners: Address[]
    threshold: DecString
    to: Address
    data: Hex
    toIdentification: Identification | null
    batch: BatchCall[] | null
    fallbackHandler: Address
    paymentToken: Address
    payment: DecString
    paymentReceiver: Address
  } | null
  // From a prestate diff trace, when the RPC has one.
  storageDiff: { key: Hex; before: Hex; after: Hex; meaning: string }[] | null
}

export type HistoryEvent = {
  name: string
  block: DecString
  txHash: Hex
  logIndex: number
  args: Record<string, string>
  // Present in the primary RPC's receipt (indexer events are confirmed before they clear a finding).
  confirmed: boolean
}

export type ConfigState = {
  singleton: Address | null
  owners: Address[]
  threshold: DecString | null
  modules: Address[]
  guard: Address | null
  moduleGuard: Address | null
  fallbackHandler: Address | null
}

export type HistorySection = {
  source: ServiceRef
  fromBlock: DecString
  toBlock: DecString
  complete: boolean
  configEvents: HistoryEvent[]
  executions: { success: number; failure: number; moduleSuccess: number; moduleFailure: number; recent: HistoryEvent[] }
  rebuilt: ConfigState
  differences: { field: keyof ConfigState; current: string; fromEvents: string }[]
}

export type PendingSection = {
  approvedHashes: { owner: Address; hash: Hex; slot: Hex; nonce: DecString | null }[]
  signedMessages: { hash: Hex; slot: Hex }[]
  queued: {
    nonce: DecString
    safeTxHash: Hex
    to: Address
    value: DecString
    operation: "call" | "delegatecall"
    confirmations: number
    required: number
  }[]
  messages: { hash: Hex; confirmations: number; created: IsoTime }[]
  delegates: { delegate: Address; delegator: Address; label: string }[]
  sources: ServiceRef[]
}

export type CapabilityName =
  "proofs" | "archiveCall" | "storageAt" | "logs" | "prestateTrace" | "callTrace" | "storageRange"

export type DiagnosisSection = {
  steps: {
    id: "events" | "enumeration" | "traces" | "candidates"
    status: "explained" | "partial" | "nothing-found" | "unavailable" | "failed"
    detail: string
    missing: CapabilityName[]
  }[]
  unexplained: StorageSlotRow[]
  candidatesTried: string[]
}

export type EndpointRef = {
  // Host only: a user RPC's path and query can hold a key and never enter the report.
  host: string
  operator: string
  operatorName: string
  origin: "default" | "user"
  aggregator: boolean
  clientVersion: string | null
}

export type VerificationSection = {
  anchor: {
    number: DecString
    hash: Hex
    stateRoot: Hex
    timestamp: IsoTime
    pinnedBy: "offset" | "user" | "tip"
    note: string
  }
  primary: EndpointRef
  crossCheck: EndpointRef | null
  crossCheckMissing: string | null
  // "self-trusted": the user marked their own primary RPC as trusted alone; never set for a default RPC.
  agreement: "agreed" | "disagreed" | "single-operator" | "self-trusted"
  // What the cross-check RPC could compare at the anchor block.
  coverage: { header: Comparison; storageRoot: Comparison; slotValues: Comparison; calls: Comparison }
  // `blocks` has one entry (the anchor) except in tip mode, where other accounts are proven a few blocks later.
  proofs: { accounts: number; slots: number; allVerified: boolean; servedBy: string[]; blocks: DecString[] }
  reorg: "unchanged" | "restarted" | "not-run"
  capabilities: { host: string; available: CapabilityName[]; missing: CapabilityName[] }[]
}

export type CrossChainSection = {
  chains: {
    chainId: number
    name: string
    status: "safe" | "contract" | "empty" | "error"
    ownersMatch: boolean | null
    thresholdMatch: boolean | null
    note: string | null
  }[]
}

// ---------------------------------------------------------------------------------------------------------------
// I/O issues (every I/O failure maps to one kind; the text is filled by src/data/errors.ts)

export type IssueKind =
  | "unreachable"
  | "csp-blocked"
  | "timeout"
  | "rate-limited"
  | "access-denied"
  | "server-error"
  | "method-unsupported"
  | "proof-window"
  | "not-archive"
  | "block-unavailable"
  | "range-too-large"
  | "wrong-chain"
  | "invalid-response"
  | "proof-invalid"
  | "non-mpt"
  | "disagreement"
  | "reverted"
  | "key-required"
  | "key-rejected"
  | "plan-unsupported"
  | "not-found"
  | "cancelled"
  | "unknown"

export type EndpointRole = "primary" | "cross-check" | "fallback" | "detection" | "api"

// Shown behind a "technical details" toggle. URLs are redacted to the host for user RPCs and lose `apikey`.
export type RawIoDetail = {
  url: string
  method: string
  params: string | null
  httpStatus: number | null
  rpcCode: number | null
  message: string | null
  body: string | null
  elapsedMs: number
  attempts: number
  at: IsoTime
}

export type ReportIssue = {
  kind: IssueKind
  title: string
  explanation: string
  actions: string[]
  service: ServiceKind
  host: string
  role: EndpointRole
  // Plain words: "read the storage proof of the Safe".
  operation: string
  step: StepId | null
  transient: boolean
  // The run worked around it (retry, another endpoint, another source).
  recovered: boolean
  raw: RawIoDetail
}

// ---------------------------------------------------------------------------------------------------------------
// Steps and streaming

export type StepId =
  | "anchor"
  | "identity"
  | "config"
  | "storage"
  | "owners"
  | "modules"
  | "handlers"
  | "creation"
  | "history"
  | "pending"
  | "storage-events"
  | "diagnosis"
  | "reorg"
  | "verdict"

export type StepStatus = "pending" | "running" | "done" | "degraded" | "skipped" | "failed"

export type StepRecord = {
  id: StepId
  label: string
  status: StepStatus
  note: string | null
  startedAt: IsoTime | null
  finishedAt: IsoTime | null
}

export type Report = {
  schema: typeof REPORT_SCHEMA
  tool: { name: "safe-state-check"; version: string; commit: string | null }
  createdAt: IsoTime
  request: CheckRequest
  chain: ChainRef
  verdict: Verdict
  findings: Finding[]
  cards: SummaryCard[]
  identity: Part<IdentitySection>
  owners: Part<OwnersSection>
  modules: Part<ModulesSection>
  handlers: Part<HandlersSection>
  storage: Part<StorageSection>
  creation: Part<CreationSection>
  history: Part<HistorySection>
  pending: Part<PendingSection>
  diagnosis: DiagnosisSection | null
  verification: VerificationSection
  crossChain: Part<CrossChainSection> | null
  steps: StepRecord[]
  issues: ReportIssue[]
  // "What this does not check": the fixed lines plus run-specific ones (for example ExtensibleFallbackHandler).
  notChecked: string[]
}

export type SectionKey =
  | "identity"
  | "owners"
  | "modules"
  | "handlers"
  | "storage"
  | "creation"
  | "history"
  | "pending"
  | "diagnosis"
  | "verification"
  | "crossChain"

export type SectionPatch = { [K in SectionKey]: { key: K; value: Report[K] } }[SectionKey]

// The run stops without a report only when there is nothing to check.
// "not-a-safe": code that is neither a known Safe proxy nor a known singleton and does not answer the Safe getters,
// or an EIP-7702 delegated account.
export type StopReason =
  "not-deployed" | "no-code" | "not-a-safe" | "unknown-chain" | "no-rpc" | "anchor-failed" | "cancelled"

// Events arrive in this order: started, then step, section, finding and issue events in any order, then exactly one
// of finished or stopped. A reorg restart sends `restarted` and starts the steps again.
export type CheckEvent =
  | { type: "started"; at: IsoTime; request: CheckRequest; chain: ChainRef; steps: StepRecord[] }
  | { type: "step"; step: StepRecord }
  | { type: "section"; patch: SectionPatch }
  | { type: "finding"; finding: Finding }
  | { type: "issue"; issue: ReportIssue }
  | { type: "restarted"; reason: string }
  | { type: "finished"; report: Report }
  | { type: "stopped"; reason: StopReason; message: string; issues: ReportIssue[] }
