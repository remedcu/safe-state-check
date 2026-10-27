// Typed reports for UI tests, the Markdown snapshots and the fixture player. The green report is the Reward
// Distribution Safe at block 26176126 (docs/SPEC.md appendix B1, with the transactions and modules from its review). The
// other reports are variations on synthetic Safe addresses; their roots come from appendix B where one applies.
import { type Address, type Hex, keccak256, toHex } from "viem"
import { finding, UNVERIFIED_REASONS } from "@/core/findings"
import { type IssueVars, makeIssue } from "@/data/errors"
import type {
  CheckEvent,
  CreationSection,
  HandlersSection,
  HistorySection,
  Identification,
  IssueKind,
  KnownRef,
  Report,
  ReportIssue,
  StepId,
  StepRecord,
  StorageSlotRow,
  SummaryCard,
} from "@/core/report"

export const GREEN_SAFE: Address = "0xAd219b3c26fe42BF5FC66F67490745a4fa5dff59"
export const RED_SAFE: Address = "0x5afE5aFE5Afe5afe5aFe5afE5afE5aFE5afe0001"
export const SELF_TRUSTED_SAFE: Address = "0x5afE5AFe5afE5AfE5afe5Afe5AfE5aFe5afE0002"
export const ZKSYNC_SAFE: Address = "0x5Afe5aFe5afe5AFE5AFE5aFE5aFE5AFE5AFe0324"

const OWNER: Address = "0x802cbafa6133c493A7c67f685f97AdA5918d1dF9"
const AMBIRE_7702: Address = "0x5A7FC11397E9a8AD41BF10bf13F22B0a63f96f6d"
const VETO_MODULE: Address = "0x4210382652A5e3C9aF7e1D3c88085818A465449b"
const REALITY_MODULE: Address = "0x8DFc5Db2C83200Cf0cC84d7e3C441d7721ef83dC"
const REALITY_MASTERCOPY: Address = "0x7276813b21623d89BA8984B225d5792943DD7dbF"
const SINGLETON_141: Address = "0x41675C099F32341bf84BFc5382aF534df5C7461a"
const HANDLER_141: Address = "0xfd0732Dc9E303f09fCEf3a7388Ad10A83459Ec99"
const FACTORY_141: Address = "0x4e1DCf7AD4e460CfD30791CCC4F9c8a4f820ec67"
const SAFE_TO_L2_SETUP: Address = "0xBD89A1CE4DDe368FFAB0eC35506eEcE0b1fFdc54"
const SHADOW_OWNER: Address = "0x0000000000000000000000000000000000000002"
const ZERO: Address = "0x0000000000000000000000000000000000000000"

const BLOCK = "26176126"
const BLOCK_HASH: Hex = "0xbca7f5c0cd31c75f3e3221c076713002cf9952022b18060c16f4eeedf35ea119"
const STATE_ROOT: Hex = "0x076e2e1a0629ea82b1069570b7426e70d1d2e9011c1674b882b4c02c10c40fe7"
const B1_ROOT: Hex = "0x4321ab747900a628bc24642a1cff166280215c287be657997cff8468934b693e"
const B1_NEG_ROOT: Hex = "0x7fbd1922de71c80aabaac95fcf30df7cfdc3359e159b9c7ed6979920e18983f3"
const CREATION_TX: Hex = "0xf422629777a4982cd7805e1d215cf3e481a1ff853d4f5303fd140971c2087cf0"

// Code hashes the packages do not ship are stand-ins, derived from a label so they cannot be mistaken for real ones.
const standIn = (label: string): Hex => keccak256(toHex(`fixture:${label}`))

function known(ref: Omit<KnownRef, "reviewed">, codeHash: Hex, extra: Partial<Identification> = {}): Identification {
  return {
    status: "known",
    codeHash,
    via: "codehash",
    implementation: null,
    matches: [{ ...ref, reviewed: null }],
    address: "listed",
    sourcify: "not-checked",
    ...extra,
  }
}

const PROXY_ID = known(
  { id: "SafeProxy@1.4.1", name: "SafeProxy", version: "1.4.1", origin: "derived" },
  "0xd7d408ebcd99b2b70be43e20253d6d92a8ea8fab29bd3be7f55b10032331fb4c",
  { address: null },
)
const SINGLETON_ID = known(
  { id: "Safe@1.4.1/canonical", name: "Safe", version: "1.4.1", origin: "safe-deployments" },
  "0x1fe2df852ba3299d6534ef416eefa406e56ced995bca886ab7a553e6d0c5e1c4",
)
const HANDLER_ID = known(
  {
    id: "CompatibilityFallbackHandler@1.4.1/canonical",
    name: "CompatibilityFallbackHandler",
    version: "1.4.1",
    origin: "safe-deployments",
  },
  "0x7c6007a5d711cea8dfd5d91f5940ec29c7f200fe511eb1fc1397b367af3c42f9",
)
const SAFE_TO_L2_SETUP_ID = known(
  { id: "SafeToL2Setup@1.4.1/canonical", name: "SafeToL2Setup", version: "1.4.1", origin: "safe-deployments" },
  "0x2f25df28caf984366ee584e13241707e85dcd5a6ea0c14267928dafc1fd6274b",
)
const FACTORY_ID = known(
  { id: "SafeProxyFactory@1.4.1/canonical", name: "SafeProxyFactory", version: "1.4.1", origin: "safe-deployments" },
  "0x50c3cdc4074750a7a974204a716c999edd37482f907608d960b2b025ee0b3317",
)
const VETO_ID: Identification = {
  status: "reviewed",
  codeHash: standIn("veto"),
  via: "codehash",
  implementation: null,
  matches: [
    {
      id: `reviewed/RealityVetoModule/1/${VETO_MODULE}`,
      name: "RealityVetoModule",
      version: "",
      origin: "reviewed",
      reviewed: { url: `https://sourcify.dev/server/v2/contract/1/${VETO_MODULE}`, on: "2026-10-12" },
    },
  ],
  address: "listed",
  sourcify: "exact_match",
}
const REALITY_ID = known(
  { id: "zodiac/realityERC20@2.0.0", name: "RealityModuleERC20", version: "2.0.0", origin: "zodiac" },
  // keccak256 of the EIP-1167 runtime that points at the mastercopy.
  "0x45aafd69c6cc1e44ba3df4f323299fadc011f8475c781fe7ad9015d1ead21f81",
  { via: "eip1167", implementation: REALITY_MASTERCOPY, address: "other-address" },
)

const STEP_LABELS: Record<StepId, string> = {
  anchor: "Pin the block",
  identity: "Identify the Safe's code",
  config: "Read the configuration",
  storage: "Rebuild the storage root",
  owners: "Check the owners",
  modules: "Check the modules",
  handlers: "Check the guard and fallback handler",
  creation: "Decode the creation",
  history: "Read the event history",
  pending: "Look for pending actions",
  "storage-events": "Add slots from events",
  diagnosis: "Look for the extra storage",
  reorg: "Re-check the block",
  verdict: "Decide the verdict",
}

export const STEP_IDS = Object.keys(STEP_LABELS) as StepId[]

export function stepRecords(
  status: StepRecord["status"],
  overrides: Partial<Record<StepId, Partial<StepRecord>>> = {},
): StepRecord[] {
  return STEP_IDS.map((id) => ({
    id,
    label: STEP_LABELS[id],
    status,
    note: null,
    startedAt: status === "pending" ? null : "2026-10-12T11:35:00Z",
    finishedAt: status === "pending" || status === "running" ? null : "2026-10-12T11:35:09Z",
    ...overrides[id],
  }))
}

function slot(key: Hex, value: Hex, meaning: string, technical: string, extra: Partial<StorageSlotRow> = {}) {
  return {
    key,
    value,
    meaning,
    technical,
    source: "config",
    status: "expected",
    proven: true,
    cross: "match",
    ...extra,
  } satisfies StorageSlotRow
}

const word = (hex: string): Hex => `0x${hex.replace(/^0x/, "").padStart(64, "0")}`

const B1_SLOTS: StorageSlotRow[] = [
  slot(word("0"), word(SINGLETON_141.slice(2).toLowerCase()), "Safe logic contract (singleton)", "slot 0"),
  slot(word("3"), word("1"), "Number of owners", "slot 3, ownerCount"),
  slot(word("4"), word("1"), "Signatures required", "slot 4, threshold"),
  slot(word("5"), word("3"), "Transactions executed (nonce)", "slot 5, nonce"),
  slot(
    "0x6c9a6c4a39284e37ed1cf53d337577d14212a4870fb976a4366c693b939918d5",
    word(HANDLER_141.slice(2).toLowerCase()),
    "Fallback handler",
    "keccak256(fallback_manager.handler.address)",
  ),
  slot(
    "0xe90b7bceb6e7df5418fb78d8ee546e97c83a08bbccc01a0644d599ccd2a7c2e0",
    word(OWNER.slice(2).toLowerCase()),
    "Start of the owner list",
    "owners[0x…01]",
  ),
  slot(
    "0x987836d13f39f6cc07c34830a39d9f3a4645b530338199ebb6048d69d0146f2b",
    word("1"),
    "Owner list entry for 0x802c…1dF9",
    "owners[0x802c…1dF9]",
  ),
  slot(
    "0xcc69885fda6bcc1a4ace058b4a62bf5e179ea78fd58a1ccd71c22cc9b688792f",
    word(VETO_MODULE.slice(2).toLowerCase()),
    "Start of the module list",
    "modules[0x…01]",
  ),
  slot(
    "0xe3ebe3cb924116f2e42323265a69b434816a67760d5bb395a26b66f97c0cded5",
    word(REALITY_MODULE.slice(2).toLowerCase()),
    "Module list entry for 0x4210…449b",
    "modules[0x4210…449b]",
  ),
  slot(
    "0x3c87853bd1943cff64926293357392dc9e0942fc33fa81a241c22b70a47343e2",
    word("1"),
    "Module list entry for 0x8DFc…83dC",
    "modules[0x8DFc…83dC]",
  ),
]

const FORMULA = {
  total: 10,
  parts: [
    { label: "singleton", count: 1 },
    { label: "owner count", count: 1 },
    { label: "threshold", count: 1 },
    { label: "nonce", count: 1 },
    { label: "owner entries", count: 2 },
    { label: "module entries", count: 3 },
    { label: "fallback handler", count: 1 },
  ],
  // src/core/accounting.ts writes the whole sentence.
  text: "Expected non-zero slots: 10 = 1 singleton + 1 owner count + 1 threshold + 1 nonce + 2 owner entries + 3 module entries + 1 fallback handler.",
}

const GREEN_CARDS: SummaryCard[] = [
  { id: "version", label: "Version", value: "1.4.1", detail: "Canonical Safe 1.4.1 (not L2)", tone: "ok" },
  { id: "owners", label: "Owners", value: "1 of 1", detail: "1 owner with an EIP-7702 delegation", tone: "warn" },
  { id: "modules", label: "Modules", value: "2", detail: "1 known, 1 on the reviewed list", tone: "ok" },
  { id: "guard", label: "Guard", value: "None", detail: null, tone: "neutral" },
  { id: "moduleGuard", label: "Module guard", value: "Not in 1.4.1", detail: null, tone: "neutral" },
  {
    id: "fallbackHandler",
    label: "Fallback handler",
    value: "CompatibilityFallbackHandler 1.4.1",
    detail: "Known",
    tone: "ok",
  },
  { id: "nonce", label: "Nonce", value: "3", detail: null, tone: "neutral" },
  { id: "storage", label: "Storage", value: "Root matches", detail: FORMULA.text, tone: "ok" },
]

const NOT_CHECKED = [
  "The code of the singleton, modules, guard, fallback handler and owner contracts is identified by its hash, not reviewed.",
  "Who holds the owner keys and how they are kept.",
  "Signatures held offchain that were never shared with any service.",
  "Offchain governance and the processes around this Safe.",
  "Token balances.",
]

// Every issue kind with the context its text needs; the words come from src/data/errors.ts, as in a real run.
const ISSUE_VARS: Record<IssueKind, IssueVars> = {
  unreachable: {},
  "csp-blocked": {},
  timeout: { timeoutMs: 15_000 },
  "rate-limited": {},
  "access-denied": {},
  "server-error": {},
  "method-unsupported": {},
  "proof-window": { block: 26176126n },
  "not-archive": { block: 26176126n },
  "block-unavailable": { block: 26176126n },
  "range-too-large": { range: 10_000n },
  "wrong-chain": { expectedChainId: 1, actualChainId: 100 },
  "invalid-response": {},
  "proof-invalid": {},
  "non-mpt": {},
  disagreement: { otherHost: "eth-mainnet.public.blastapi.io", what: "block hashes", block: 26176126n },
  reverted: {},
  "key-required": {},
  "key-rejected": {},
  "plan-unsupported": {},
  "not-found": {},
  cancelled: {},
  unknown: {},
}

const TRANSIENT = new Set<IssueKind>(["unreachable", "timeout", "rate-limited", "server-error", "block-unavailable"])

const API_KINDS: Partial<Record<IssueKind, ReportIssue["service"]>> = {
  "key-required": "etherscan",
  "key-rejected": "etherscan",
  "plan-unsupported": "etherscan",
  "not-found": "safe-tx-service",
}

const API_HOSTS: Record<ReportIssue["service"], string> = {
  rpc: "eth.drpc.org",
  blockscout: "eth.blockscout.com",
  "safe-tx-service": "api.safe.global",
  etherscan: "api.etherscan.io",
  sourcify: "sourcify.dev",
}

export function issue(kind: IssueKind, overrides: Partial<ReportIssue> = {}): ReportIssue {
  const service = overrides.service ?? API_KINDS[kind] ?? "rpc"
  const host = overrides.host ?? API_HOSTS[service]
  const ctx = {
    service,
    host,
    role: overrides.role ?? (service === "rpc" ? ("primary" as const) : ("api" as const)),
    operation: overrides.operation ?? "read the storage proof of the Safe",
    raw: {
      url: service === "rpc" ? `https://${host}` : `https://${host}/v2/api?chainid=1&module=logs`,
      method: service === "rpc" ? "eth_getProof" : "GET",
      params: service === "rpc" ? `["${GREEN_SAFE}",["0x0"],"0x18f6a7e"]` : null,
      httpStatus: kind === "access-denied" ? 403 : kind === "rate-limited" ? 429 : 200,
      rpcCode: kind === "proof-window" ? -32602 : null,
      message: `${kind} detail from the server`,
      body: null,
      elapsedMs: 412,
      attempts: TRANSIENT.has(kind) ? 3 : 1,
      at: "2026-10-12T11:35:02Z",
    },
  }
  return { ...makeIssue(kind, ctx, ISSUE_VARS[kind], TRANSIENT.has(kind)), step: "storage", ...overrides }
}

const ISSUE_KINDS = Object.keys(ISSUE_VARS) as IssueKind[]

// One issue per kind, for the error rendering tests.
export const issuesByKind = Object.fromEntries(ISSUE_KINDS.map((kind) => [kind, issue(kind)])) as Record<
  IssueKind,
  ReportIssue
>

const RATE_LIMITED_RECOVERED = issue("rate-limited", {
  operation: "read the owner's account proof",
  step: "owners",
  recovered: true,
})

const CREATION: CreationSection = {
  txHash: CREATION_TX,
  block: "25952825",
  timestamp: "2026-09-11T08:00:23Z",
  source: { service: "blockscout", host: "eth.blockscout.com" },
  factory: { address: FACTORY_141, identification: FACTORY_ID, method: "createProxyWithNonce" },
  singleton: SINGLETON_141,
  saltNonce: "0",
  callback: null,
  setup: {
    owners: [OWNER],
    threshold: "1",
    to: SAFE_TO_L2_SETUP,
    // setupToL2(SafeL2 1.4.1); on chain 1 it leaves the singleton as it is.
    data: "0xfe51f64300000000000000000000000029fcb43b46531bca003ddc8fcb67ffe91900c762",
    toIdentification: SAFE_TO_L2_SETUP_ID,
    batch: null,
    fallbackHandler: HANDLER_141,
    paymentToken: ZERO,
    payment: "0",
    paymentReceiver: ZERO,
  },
  storageDiff: null,
}

const HISTORY: HistorySection = {
  source: { service: "blockscout", host: "eth.blockscout.com" },
  fromBlock: "25952825",
  toBlock: BLOCK,
  complete: true,
  configEvents: [
    {
      name: "SafeSetup",
      block: "25952825",
      txHash: CREATION_TX,
      logIndex: 0,
      args: {
        initiator: FACTORY_141,
        owners: OWNER,
        threshold: "1",
        initializer: SAFE_TO_L2_SETUP,
        fallbackHandler: HANDLER_141,
      },
      confirmed: true,
    },
    {
      name: "EnabledModule",
      block: "25975249",
      txHash: "0x1db0e9b211007c54e89f3481265228c0a5fa045263f9b0140958b299493e6aed",
      logIndex: 1,
      args: { module: REALITY_MODULE },
      confirmed: true,
    },
    {
      name: "EnabledModule",
      block: "26154994",
      txHash: "0xf79b5430b9c10151ec65bff86072b254acede9d49ae111404ca1a6e4e8fa8055",
      logIndex: 1,
      args: { module: VETO_MODULE },
      confirmed: true,
    },
  ],
  executions: { success: 3, failure: 0, moduleSuccess: 0, moduleFailure: 0, recent: [] },
  rebuilt: {
    singleton: SINGLETON_141,
    owners: [OWNER],
    threshold: "1",
    modules: [VETO_MODULE, REALITY_MODULE],
    guard: null,
    moduleGuard: null,
    fallbackHandler: HANDLER_141,
  },
  differences: [],
}

const GREEN_HANDLERS: HandlersSection = {
  guard: {
    role: "guard",
    applicable: true,
    address: null,
    kind: null,
    identification: null,
    announced: "unknown",
    flags: [],
  },
  moduleGuard: {
    role: "moduleGuard",
    applicable: false,
    address: null,
    kind: null,
    identification: null,
    announced: "unknown",
    flags: [],
  },
  fallbackHandler: {
    role: "fallbackHandler",
    applicable: true,
    address: HANDLER_141,
    kind: "contract",
    identification: HANDLER_ID,
    announced: "unknown",
    flags: [],
  },
}

export const greenReport: Report = {
  schema: 1,
  tool: { name: "safe-state-check", version: "0.0.0", commit: null },
  createdAt: "2026-10-12T11:35:10Z",
  request: { address: GREEN_SAFE, chainId: 1, block: null },
  chain: {
    chainId: 1,
    name: "Ethereum Mainnet",
    shortName: "eth",
    explorerAddressUrl: "https://etherscan.io/address/{address}",
    rootCheck: "supported",
  },
  verdict: {
    kind: "explained",
    headline: "Every storage slot of this Safe is explained by its configuration.",
    reasons: [
      "The storage root matches the 10 slots the owners, modules and settings explain.",
      "Owner 0x802c…1dF9 is an EIP-7702 delegated account.",
    ],
    unverified: [],
    matchedBy: "config",
    counts: { critical: 0, high: 0, medium: 1, info: 1 },
  },
  findings: [
    finding("delegated-owner", "owners", {
      subject: OWNER,
      technical: `code 0xef0100 + ${AMBIRE_7702}`,
      evidence: [{ kind: "code", address: OWNER, codeHash: standIn("7702") }],
    }),
    finding("version-behind", "identity", { technical: "Safe 1.5.0 is deployed on chain 1" }),
  ],
  cards: GREEN_CARDS,
  identity: {
    state: "complete",
    data: {
      proxy: { codeHash: PROXY_ID.codeHash, identification: PROXY_ID },
      singleton: { address: SINGLETON_141, codeHash: SINGLETON_ID.codeHash, identification: SINGLETON_ID },
      version: "1.4.1",
      l2: false,
      versionCall: "1.4.1",
      supported: true,
      latestVersion: "1.5.0",
    },
  },
  owners: {
    state: "complete",
    data: {
      owners: [
        {
          address: OWNER,
          kind: "delegated-eoa",
          delegate: AMBIRE_7702,
          identification: null,
          safe: null,
          flags: ["delegated-owner"],
        },
      ],
      threshold: "1",
      ownerCount: "1",
      inertOnly: false,
    },
  },
  modules: {
    state: "complete",
    data: {
      modules: [
        { address: VETO_MODULE, kind: "contract", delegate: null, identification: VETO_ID, zodiac: null, flags: [] },
        {
          address: REALITY_MODULE,
          kind: "contract",
          delegate: null,
          identification: REALITY_ID,
          zodiac: {
            owner: GREEN_SAFE,
            avatar: GREEN_SAFE,
            target: GREEN_SAFE,
            guard: null,
            ownerIsSafe: true,
            avatarIsSafe: true,
            targetIsSafe: true,
            reality: {
              oracle: "0xdd34D37ABD603658b039BB46f25769E21e252A43",
              templateId: "5",
              timeout: "259200",
              cooldown: "432000",
              expiration: "604800",
              minimumBond: "10000000000000000000000",
              arbitrator: ZERO,
            },
            modules: null,
            cross: "match",
          },
          flags: [],
        },
      ],
    },
  },
  handlers: { state: "complete", data: GREEN_HANDLERS },
  storage: {
    state: "complete",
    data: {
      support: "supported",
      supportReason: "Proofs verified against the block's state root.",
      actualRoot: B1_ROOT,
      formula: FORMULA,
      passes: [{ by: "config", slotCount: 10, expectedRoot: B1_ROOT, match: true }],
      matchedBy: "config",
      slots: B1_SLOTS,
    },
  },
  creation: { state: "complete", data: CREATION },
  history: { state: "complete", data: HISTORY },
  pending: {
    state: "complete",
    data: {
      approvedHashes: [],
      signedMessages: [],
      queued: [],
      messages: [],
      delegates: [],
      sources: [
        { service: "rpc", host: "eth.drpc.org" },
        { service: "safe-tx-service", host: "api.safe.global" },
      ],
    },
  },
  diagnosis: null,
  verification: {
    anchor: {
      number: BLOCK,
      hash: BLOCK_HASH,
      stateRoot: STATE_ROOT,
      timestamp: "2026-10-12T11:34:47Z",
      pinnedBy: "offset",
      note: "",
    },
    primary: {
      host: "eth.drpc.org",
      operator: "drpc",
      operatorName: "dRPC",
      origin: "default",
      aggregator: true,
      clientVersion: null,
    },
    crossCheck: {
      host: "eth-mainnet.public.blastapi.io",
      operator: "blast",
      operatorName: "Blast",
      origin: "default",
      aggregator: false,
      clientVersion: null,
    },
    crossCheckMissing: null,
    agreement: "agreed",
    coverage: { header: "match", storageRoot: "match", slotValues: "match", calls: "match" },
    proofs: { accounts: 6, slots: 10, allVerified: true, servedBy: ["eth.drpc.org"], blocks: [BLOCK] },
    reorg: "unchanged",
    capabilities: [
      {
        host: "eth.drpc.org",
        available: ["proofs", "archiveCall", "storageAt", "logs", "prestateTrace", "callTrace"],
        missing: ["storageRange"],
      },
      { host: "eth-mainnet.public.blastapi.io", available: ["proofs", "archiveCall", "storageAt"], missing: [] },
    ],
  },
  crossChain: null,
  steps: stepRecords("done", {
    "storage-events": { status: "skipped", note: "The root matched in the first pass." },
    diagnosis: { status: "skipped", note: "Nothing to explain." },
  }),
  issues: [RATE_LIMITED_RECOVERED],
  notChecked: NOT_CHECKED,
}

const SHADOW_SLOT = slot(
  "0x679795a0195a1b76cdebb7c51d74e058aee92919b8c3389af86ef24535e8a28c",
  word("1"),
  "Hidden owner entry for 0x…02",
  "owners[0x…02] = 0x…01, outside the owner list",
  { source: "trace", status: "suspicious", cross: "match" },
)

// Appendix B1-neg: the B1 slots plus a shadow owner written by an unknown setup helper.
export const redShadowOwnerReport: Report = {
  ...greenReport,
  request: { address: RED_SAFE, chainId: 1, block: null },
  verdict: {
    kind: "unexplained",
    headline: "This Safe's storage holds an owner entry its owner list does not show.",
    reasons: [
      "Hidden owner entry for 0x…02: it can sign for the Safe but getOwners does not list it.",
      "The setup call ran code that is not a known setup helper.",
    ],
    unverified: [],
    matchedBy: "traces",
    counts: { critical: 1, high: 1, medium: 1, info: 1 },
  },
  findings: [
    finding("shadow-owner", "storage", {
      subject: SHADOW_OWNER,
      technical: "owners[0x…02] = 0x…01, written by the creation transaction",
      evidence: [{ kind: "slot", key: SHADOW_SLOT.key, value: SHADOW_SLOT.value }],
    }),
    finding("setup-delegatecall-unknown", "creation", {
      subject: "0x9999999999999999999999999999999999999999",
      technical: "setup to = 0x9999…9999, operation delegatecall",
    }),
    ...greenReport.findings,
  ],
  cards: GREEN_CARDS.map((card) =>
    card.id === "storage"
      ? {
          ...card,
          value: "Root mismatch",
          detail: "1 slot outside the configuration: a hidden owner entry",
          tone: "bad",
        }
      : card,
  ),
  storage: {
    state: "complete",
    data: {
      support: "supported",
      supportReason: "Proofs verified against the block's state root.",
      actualRoot: B1_NEG_ROOT,
      formula: FORMULA,
      passes: [
        { by: "config", slotCount: 10, expectedRoot: B1_ROOT, match: false },
        { by: "events", slotCount: 10, expectedRoot: B1_ROOT, match: false },
        { by: "traces", slotCount: 11, expectedRoot: B1_NEG_ROOT, match: true },
      ],
      matchedBy: "traces",
      slots: [...B1_SLOTS, SHADOW_SLOT],
    },
  },
  creation: {
    state: "complete",
    data: {
      ...CREATION,
      setup: {
        owners: [OWNER],
        threshold: "1",
        to: "0x9999999999999999999999999999999999999999",
        data: "0x5afe0001",
        toIdentification: {
          status: "unknown",
          codeHash: standIn("helper"),
          via: "codehash",
          implementation: null,
          matches: [],
          address: null,
          sourcify: "not-verified",
        },
        batch: null,
        fallbackHandler: HANDLER_141,
        paymentToken: ZERO,
        payment: "0",
        paymentReceiver: ZERO,
      },
      storageDiff: [
        {
          key: SHADOW_SLOT.key,
          before: word("0"),
          after: word("1"),
          meaning: "Hidden owner entry for 0x…02",
        },
      ],
    },
  },
  diagnosis: {
    steps: [
      { id: "events", status: "nothing-found", detail: "No ApproveHash or SignMsg events.", missing: [] },
      {
        id: "enumeration",
        status: "unavailable",
        detail: "No RPC serves debug_storageRangeAt.",
        missing: ["storageRange"],
      },
      {
        id: "traces",
        status: "explained",
        detail: "The creation transaction wrote owners[0x…02]. With that slot the root matches.",
        missing: [],
      },
    ],
    unexplained: [],
    candidatesTried: [],
  },
  steps: stepRecords("done", { "storage-events": { status: "done", note: "No event slots to add." } }),
  issues: [],
}

// One operator only: everything else is green, so the verdict says exactly what is missing.
export const amberSingleOperatorReport: Report = {
  ...greenReport,
  verdict: {
    kind: "unverified",
    headline: "Could not verify: only one RPC operator confirmed the block.",
    reasons: [UNVERIFIED_REASONS["single-operator"], "The storage root matches the configuration on that one RPC."],
    unverified: [{ reason: "single-operator", detail: UNVERIFIED_REASONS["single-operator"] }],
    matchedBy: "config",
    counts: greenReport.verdict.counts,
  },
  verification: {
    ...greenReport.verification,
    crossCheck: null,
    crossCheckMissing: "No default RPC of another operator answered for this block.",
    agreement: "single-operator",
    coverage: { header: "not-run", storageRoot: "not-run", slotValues: "not-run", calls: "not-run" },
  },
  issues: [
    issue("unreachable", {
      role: "cross-check",
      host: "eth-mainnet.public.blastapi.io",
      operation: "read block 26176126",
      step: "anchor",
      raw: {
        url: "https://eth-mainnet.public.blastapi.io",
        method: "eth_getBlockByNumber",
        params: '["0x18f6a7e",false]',
        httpStatus: null,
        rpcCode: null,
        message: "TypeError: Failed to fetch",
        body: null,
        elapsedMs: 1203,
        attempts: 1,
        at: "2026-10-12T11:35:01Z",
      },
    }),
  ],
}

// zkSync: proofs are not standard Ethereum proofs, so the root check does not run.
export const amberUnsupportedChainReport: Report = {
  ...greenReport,
  request: { address: ZKSYNC_SAFE, chainId: 324, block: null },
  chain: {
    chainId: 324,
    name: "zkSync Mainnet",
    shortName: "zksync",
    explorerAddressUrl: "https://explorer.zksync.io/address/{address}",
    rootCheck: "unsupported",
  },
  verdict: {
    kind: "unverified",
    headline: "Could not verify: this chain does not serve standard storage proofs.",
    reasons: [UNVERIFIED_REASONS["root-check-unsupported"]],
    unverified: [{ reason: "root-check-unsupported", detail: UNVERIFIED_REASONS["root-check-unsupported"] }],
    matchedBy: null,
    counts: { critical: 0, high: 0, medium: 0, info: 0 },
  },
  findings: [],
  cards: GREEN_CARDS.map((card) =>
    card.id === "storage"
      ? { ...card, value: "Not checked", detail: "zkSync does not serve eth_getProof", tone: "unknown" }
      : card.id === "owners"
        ? { ...card, value: "1 of 1", detail: null, tone: "ok" }
        : card,
  ),
  owners: {
    state: "complete",
    data: {
      owners: [{ address: OWNER, kind: "eoa", delegate: null, identification: null, safe: null, flags: [] }],
      threshold: "1",
      ownerCount: "1",
      inertOnly: false,
    },
  },
  storage: {
    state: "complete",
    data: {
      support: "unsupported",
      supportReason: "ZK Stack (EraVM) keeps state in a different tree and does not serve eth_getProof.",
      actualRoot: null,
      formula: FORMULA,
      passes: [],
      matchedBy: null,
      slots: B1_SLOTS.map((row) => ({ ...row, proven: false, cross: "not-served" })),
    },
  },
  creation: {
    state: "unavailable",
    reason: "No source found the creation transaction (tried Blockscout and the RPC).",
  },
  history: {
    state: "partial",
    data: { ...HISTORY, complete: false, source: { service: "blockscout", host: "zksync.blockscout.com" } },
    gaps: ["Blocks before 51000000 were not read."],
  },
  pending: { state: "skipped", reason: "The Safe Transaction Service is off in settings." },
  verification: {
    ...greenReport.verification,
    primary: {
      host: "mainnet.era.zksync.io",
      operator: "team:zksync.io",
      operatorName: "zkSync",
      origin: "default",
      aggregator: false,
      clientVersion: null,
    },
    crossCheck: {
      host: "zksync.drpc.org",
      operator: "drpc",
      operatorName: "dRPC",
      origin: "default",
      aggregator: true,
      clientVersion: null,
    },
    coverage: { header: "match", storageRoot: "not-served", slotValues: "match", calls: "match" },
    proofs: { accounts: 0, slots: 0, allVerified: false, servedBy: [], blocks: [] },
    capabilities: [],
  },
  issues: [
    issue("method-unsupported", {
      host: "mainnet.era.zksync.io",
      operation: "read the storage proof of the Safe",
      recovered: false,
    }),
  ],
}

// Checked against the user's own node alone, with a handler whose event only an indexer could have shown.
export const selfTrustedReport: Report = {
  ...greenReport,
  request: { address: SELF_TRUSTED_SAFE, chainId: 1, block: null },
  verdict: {
    ...greenReport.verdict,
    // Long enough that three reasons do not fit the banner at 400 px, so the list has to scroll.
    reasons: [
      "The storage root matches the root rebuilt from the owners, modules and settings, read from your own node at 127.0.0.1 without a second operator to confirm the block.",
      "Owner 0x802cbafa6133c493A7c67f685f97AdA5918d1dF9 is an EIP-7702 delegated account; its security also depends on the delegate contract 0x5A7FC11397E9a8AD41BF10bf13F22B0a63f96f6d.",
      "No event for the fallback handler 0xfd0732Dc9E303f09fCEf3a7388Ad10A83459Ec99; the history came from an indexer only, which can miss events.",
    ],
    counts: { critical: 0, high: 0, medium: 2, info: 1 },
  },
  findings: [
    ...greenReport.findings,
    // Built by hand: the catalogue entry for this code is added in src/core/findings.ts.
    {
      code: "config-without-event-unconfirmed",
      severity: "medium",
      title: "Setting without its event (indexer only)",
      technical:
        "fallback handler 0xfd07…Ec99 set, no ChangedFallbackHandler or SafeSetup event from eth.blockscout.com",
      explanation:
        "The history came only from an indexer, which can miss events, so this may be a gap in the indexer rather than a direct storage write.",
      subject: HANDLER_141,
      section: "handlers",
      evidence: [],
    },
  ],
  handlers: {
    state: "complete",
    data: {
      ...GREEN_HANDLERS,
      fallbackHandler: {
        ...GREEN_HANDLERS.fallbackHandler,
        announced: "unknown",
        flags: ["config-without-event-unconfirmed"],
      },
    },
  },
  verification: {
    ...greenReport.verification,
    primary: {
      host: "127.0.0.1",
      operator: "user:127.0.0.1",
      operatorName: "your RPC",
      origin: "user",
      aggregator: false,
      clientVersion: "reth/v1.8.2",
    },
    crossCheck: null,
    crossCheckMissing: "You marked your own node as trusted, and no RPC of another operator answered for this block.",
    agreement: "self-trusted",
    coverage: { header: "not-run", storageRoot: "not-run", slotValues: "not-run", calls: "not-run" },
    proofs: { ...greenReport.verification.proofs, servedBy: ["127.0.0.1"] },
    capabilities: [],
  },
  issues: [],
}

export const stoppedNotDeployed: Extract<CheckEvent, { type: "stopped" }> = {
  type: "stopped",
  reason: "not-deployed",
  message: `There is no account at ${RED_SAFE} on Ethereum Mainnet at block ${BLOCK}. Check the address and the chain.`,
  issues: [],
}

export const FIXTURE_REPORTS = {
  green: greenReport,
  selfTrusted: selfTrustedReport,
  red: redShadowOwnerReport,
  amberSingle: amberSingleOperatorReport,
  amberUnsupported: amberUnsupportedChainReport,
}
