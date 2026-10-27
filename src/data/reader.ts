// StateReader: the anchor, proven reads and every other RPC read of a run (docs/ARCHITECTURE.md sections 6.4 to 6.8).
// Proven reads verify against the anchor's stateRoot with src/core/proof.ts. The cross-check confirms the anchor header
// and compares what it can serve, so a read never fails over onto the cross-check's operator: one operator would then
// answer both sides of a comparison.
import { verifyMerkleProof } from "@ethereumjs/mpt"
import {
  type Address,
  createPublicClient,
  custom,
  fromRlp,
  type GetProofReturnType,
  getAddress,
  type Hex,
  hexToBigInt,
  hexToBytes,
  isHex,
  keccak256,
  numberToHex,
  pad,
  type PublicClient,
} from "viem"
import { ProofError, type ProvenAccount, verifyAccountProof, verifyStorageProof } from "@/core/proof"
import type { Comparison, EndpointRole, IssueKind, ReportIssue } from "@/core/report"
import { ENDPOINT_KINDS, ioErrorOf } from "@/data/errors"
import { crossMissingReason, crossOrder, type PoolEntry, primaryOrder } from "@/data/endpoints"
import { type CapabilityCache, isCapabilityGap, probeChainId } from "@/data/probe"
import type { CallContext, Transport } from "@/data/transport"
import {
  type Anchor,
  type CallFrame,
  type CallRead,
  type CapabilityReport,
  type ChainInfo,
  type Endpoint,
  type EndpointPair,
  IoError,
  type ProvenAccountRead,
  type RawLog,
  type Settings,
  type StateReader,
  type StorageDiff,
  type TxRead,
  type UnprovenAccountRead,
} from "@/data/types"

export const ANCHOR_OFFSET = 3n
// Any account works as the anchor's proof probe; a proof of absence is enough.
const PROBE_ADDRESS: Address = "0x0000000000000000000000000000000000000000"
// Tip mode looks for the proof's root in these headers, relative to eth_blockNumber after the proof (measured matches
// were at head-0 to head-2; head+1 covers a load balancer whose nodes disagree by one block).
const TIP_OFFSETS = [0n, 1n, 2n, 3n, 4n, -1n]
const LOG_RANGES = [10_000, 1_000, 100]
const STORAGE_RANGE_PAGE = 1024
const STORAGE_RANGE_PAGES = 20

type Header = { number: bigint; hash: Hex; stateRoot: Hex; timestamp: bigint }

type Mode = "pinned" | "tip" | "header-only"

type Outcome<T> = { ok: true; value: T } | { ok: false; issue: ReportIssue }

type Proven = { account: ProvenAccount | null; values: Map<Hex, bigint> }

async function settle<T>(work: Promise<T>): Promise<Outcome<T>> {
  try {
    return { ok: true, value: await work }
  } catch (error) {
    const io = ioErrorOf(error)
    if (!io) throw error
    return { ok: false, issue: io.issue }
  }
}

const isWord = (value: unknown): value is Hex => typeof value === "string" && /^0x[0-9a-fA-F]{64}$/.test(value)
const isQuantity = (value: unknown): value is Hex => typeof value === "string" && /^0x[0-9a-fA-F]+$/.test(value)
const short = (address: string) => `${address.slice(0, 6)}...${address.slice(-4)}`

export function storageKey(slot: Hex): Hex {
  return pad(slot, { size: 32 }).toLowerCase() as Hex
}

// Scroll names the field keccakCodeHash (it also returns poseidonCodeHash), and proof nodes that are not hex strings or
// not RLP lists are another trie (zkTrie 0x09, Cosmos protobuf 0x0a, Pharos objects). This looks at the shape only;
// once the run has verified a Merkle Patricia proof, the reader treats such an answer as invalid instead.
type ProofShape = { ok: true; proof: unknown } | { ok: false; kind: IssueKind; message: string }

export function checkProofShape(result: unknown): ProofShape {
  if (typeof result !== "object" || result === null) {
    return { ok: false, kind: "invalid-response", message: "eth_getProof returned no object" }
  }
  const proof = { ...(result as Record<string, unknown>) }
  if (proof.codeHash === undefined && typeof proof.keccakCodeHash === "string") proof.codeHash = proof.keccakCodeHash
  const { accountProof, storageProof } = proof
  if (!Array.isArray(accountProof) || !Array.isArray(storageProof)) {
    return { ok: false, kind: "invalid-response", message: "eth_getProof returned no proof lists" }
  }
  const nodes = [
    ...accountProof,
    ...storageProof.flatMap((entry: unknown) =>
      typeof entry === "object" && entry !== null && Array.isArray((entry as { proof?: unknown }).proof)
        ? ((entry as { proof: unknown[] }).proof as unknown[])
        : [],
    ),
  ]
  if (nodes.some((node) => !isHex(node))) {
    return { ok: false, kind: "non-mpt", message: "proof nodes are not hex strings (a chain-specific proof format)" }
  }
  const notList = (nodes as Hex[]).find((node) => node.length >= 4 && parseInt(node.slice(2, 4), 16) < 0xc0)
  // A client may prove an empty storage trie with the single node 0x80.
  if (notList && notList !== "0x80") {
    return {
      ok: false,
      kind: "non-mpt",
      message: `proof nodes are not RLP lists (first byte 0x${notList.slice(2, 4)})`,
    }
  }
  if (
    !isWord(proof.storageHash) ||
    !isWord(proof.codeHash) ||
    !isQuantity(proof.balance) ||
    !isQuantity(proof.nonce) ||
    storageProof.some(
      (e: unknown) => typeof e !== "object" || e === null || !isQuantity((e as { value?: unknown }).value),
    )
  ) {
    return { ok: false, kind: "invalid-response", message: "eth_getProof returned fields that are not hex quantities" }
  }
  return { ok: true, proof }
}

// viem's own getProof, so core/proof.ts gets exactly GetProofReturnType; the raw answer's shape is checked first.
export function proofClient(transport: Transport, endpoint: Endpoint, ctx: CallContext): PublicClient {
  const request = async ({ method, params }: { method: string; params?: unknown[] }) => {
    const result = await transport.rpc(endpoint, method, params ?? [], ctx)
    if (method !== "eth_getProof") return result
    const shape = checkProofShape(result)
    if (!shape.ok) throw new IoError(transport.issue(shape.kind, endpoint, method, ctx, shape.message))
    return shape.proof
  }
  return createPublicClient({ transport: custom({ request }, { retryCount: 0 }) })
}

// After a failed account check: does the path verify against the root, with a leaf that is not the four-field
// Ethereum account? Then the chain stores accounts differently (Avalanche, Blast, ApeChain, Kaia) and the RPC is not
// lying; anything else is an invalid proof.
export async function otherAccountFormat(
  stateRoot: Hex,
  address: Address,
  proof: GetProofReturnType,
): Promise<boolean> {
  let leaf: Uint8Array | null
  try {
    leaf = await verifyMerkleProof(
      hexToBytes(address),
      proof.accountProof.map((node) => hexToBytes(node)),
      { root: hexToBytes(stateRoot), useKeyHashing: true },
    )
  } catch {
    return false
  }
  if (leaf === null) return false
  try {
    const fields = fromRlp(leaf, "hex")
    return !Array.isArray(fields) || fields.length !== 4
  } catch {
    return true
  }
}

export type ReaderOptions = {
  transport: Transport
  capabilities: CapabilityCache
  settings: Settings
  onIssue?: (issue: ReportIssue) => void
  // The account whose proof tests an endpoint during anchor(); tests pass one they hold a recorded proof for.
  probeAddress?: Address
}

type FailoverOptions = {
  capability?: "proofs" | "archiveCall" | "storageAt" | "callTrace" | "prestateTrace" | "storageRange"
  // Proven reads move on after any failure: an honest node never answers eth_getProof with a revert, so a primary that
  // does must not stop the read.
  anyKind?: boolean
  alsoMoveOn?: IssueKind[]
  // Which failure to throw when every endpoint failed; the first one otherwise.
  prefer?: (issue: ReportIssue) => boolean
}

export class Reader implements StateReader {
  readonly chain: ChainInfo
  private readonly pool: PoolEntry[]
  private readonly transport: Transport
  private readonly caps: CapabilityCache
  private readonly settings: Settings
  private readonly onIssue: (issue: ReportIssue) => void
  private readonly probeAddress: Address
  private mode: Mode = "pinned"
  private primary: Endpoint | null = null
  private cross: Endpoint | null = null
  private crossMissing: string | null = null
  private anchorHeader: Header | null = null
  private current: Anchor | null = null
  // Endpoints that answered but did not prove the target block: tip-mode candidates.
  private windowed: Endpoint[] = []
  // The endpoint that served eth_getLogs in logsRange(); history chunks start there.
  private logsEndpoint: Endpoint | null = null
  private readonly tipKeys = new Map<string, Set<Hex>>()
  private readonly crossHeaders = new Map<bigint, Promise<Comparison>>()
  private readonly used = new Set<Endpoint>()

  constructor(chain: ChainInfo, pool: PoolEntry[], options: ReaderOptions) {
    this.chain = chain
    this.pool = pool
    this.transport = options.transport
    this.caps = options.capabilities
    this.settings = options.settings
    this.onIssue = options.onIssue ?? (() => undefined)
    this.probeAddress = options.probeAddress ?? PROBE_ADDRESS
  }

  pair(): EndpointPair {
    return {
      primary: this.primary ?? this.pool[0].endpoint,
      crossCheck: this.cross,
      crossCheckMissing: this.primary ? this.crossMissing : "The anchor block is not chosen yet.",
    }
  }

  capabilities(): CapabilityReport[] {
    return this.caps.report(this.chain.chainId, [...this.used])
  }

  // ---------------------------------------------------------------------------------------------------------------
  // Anchor

  async anchor(request: { block: bigint | null }): Promise<Anchor> {
    // A reorg restart calls anchor() again on the same reader: start from a clean pin.
    this.current = null
    this.anchorHeader = null
    this.primary = null
    this.cross = null
    this.crossMissing = null
    this.windowed = []
    this.logsEndpoint = null
    this.tipKeys.clear()
    this.crossHeaders.clear()
    this.mode = "pinned"
    const userBlock = request.block
    const failures: ReportIssue[] = []
    let target = userBlock
    let firstLive: { endpoint: Endpoint; header: Header } | null = null
    let proven: { endpoint: Endpoint; header: Header } | null = null
    let missingProofs = false
    let nonMpt = false
    // A user block above every live endpoint's newest block is a typo, not an RPC problem.
    let newestHead: { endpoint: Endpoint; head: bigint } | null = null
    let userBlockReached = false

    for (const { endpoint } of primaryOrder(this.pool)) {
      const live = await settle(this.checkChain(endpoint, "primary"))
      if (!live.ok) {
        failures.push(live.issue)
        continue
      }
      const head = await settle(this.blockNumber(endpoint, "primary"))
      if (!head.ok) {
        failures.push(head.issue)
        continue
      }
      if (!newestHead || head.value > newestHead.head) newestHead = { endpoint, head: head.value }
      if (target === null) target = head.value > ANCHOR_OFFSET ? head.value - ANCHOR_OFFSET : 0n
      if (userBlock !== null && userBlock > head.value) continue
      userBlockReached = true
      const header = await settle(this.header(endpoint, target, "primary"))
      if (!header.ok) {
        failures.push(header.issue)
        continue
      }
      firstLive ??= { endpoint, header: header.value }
      const proof = await settle(
        this.proveAt(endpoint, this.probeAddress, [], header.value, "primary", "prove the anchor block"),
      )
      if (proof.ok) {
        this.caps.set(this.chain.chainId, endpoint.url, "proofs", {
          status: "yes",
          value: userBlock === null ? "recent" : "archive",
        })
        proven = { endpoint, header: header.value }
        break
      }
      failures.push(proof.issue)
      this.caps.fail(this.chain.chainId, endpoint.url, "proofs", proof.issue)
      if (proof.issue.kind === "proof-window" || proof.issue.kind === "not-archive") this.windowed.push(endpoint)
      else missingProofs = true
      if (proof.issue.kind === "non-mpt") nonMpt = true
    }

    if (userBlock !== null && !userBlockReached && newestHead) {
      this.report(failures, false)
      throw new IoError(
        this.transport.issue("block-unavailable", newestHead.endpoint, "eth_blockNumber", {
          role: "primary",
          operation: `pin block ${userBlock}`,
          vars: { block: userBlock, afterHead: newestHead.head },
        }),
      )
    }

    let note: string | null = null
    if (proven) {
      if (firstLive && firstLive.endpoint !== proven.endpoint) {
        const why = failures.find((f) => f.host === firstLive.endpoint.host)
        note = `${firstLive.endpoint.host} could not prove block ${target}${why ? ` (${why.title.toLowerCase()})` : ""}; ${proven.endpoint.host} proves it.`
      }
    } else if (userBlock !== null && this.windowed.length > 0) {
      // A user block never moves (docs/ARCHITECTURE.md section 6.4).
      this.throwFirst(failures, (f) => f.kind === "proof-window" || f.kind === "not-archive")
    } else if (userBlock === null && this.windowed.length > 0) {
      for (const endpoint of this.windowed) {
        const tip = await settle(this.proveAtTip(endpoint, this.probeAddress, [], "primary", "prove the newest block"))
        if (tip.ok) {
          this.caps.set(this.chain.chainId, endpoint.url, "proofs", { status: "yes", value: "tip-only" })
          proven = { endpoint, header: tip.value.header }
          this.mode = "tip"
          note = `No RPC proves block ${target} (latest - 3), so storage is proven at the newest block of ${endpoint.host} (tip mode).`
          break
        }
        failures.push(tip.issue)
      }
    }
    let headerOnly: Anchor["headerOnly"]
    if (!proven && firstLive) {
      proven = firstLive
      this.mode = "header-only"
      headerOnly = this.chain.rootCheck.status === "unsupported" || nonMpt ? "unsupported" : "no-proof-rpc"
      note =
        headerOnly === "unsupported"
          ? "This chain's proofs are not standard Ethereum proofs, so the storage is read without proofs."
          : missingProofs
            ? "No RPC for this chain serves storage proofs, so the storage is read without proofs."
            : `No RPC proves block ${target}, so the storage is read without proofs.`
    }
    if (!proven) this.throwFirst(failures)

    const chosen = proven as { endpoint: Endpoint; header: Header }
    this.primary = chosen.endpoint
    this.used.add(chosen.endpoint)
    this.anchorHeader = chosen.header
    this.report(failures, true)
    const header = await this.chooseCrossCheck(chosen.header)
    const pinnedBy = this.mode === "tip" ? "tip" : userBlock !== null ? "user" : "offset"
    this.current = { ...chosen.header, pinnedBy, note, header }
    if (headerOnly) this.current.headerOnly = headerOnly
    // The user's own node stands alone only when no other operator could confirm the header.
    if (header === "not-run" && chosen.endpoint.ownNode && chosen.endpoint.origin === "user") {
      this.current.selfTrusted = true
      this.crossMissing = `No other operator confirmed block ${chosen.header.number}; ${chosen.endpoint.host} is trusted as your own node.`
    }
    return this.current
  }

  // Throws one failure (the first, or the first that `prefer` picks) and reports the others.
  private throwFirst(failures: readonly ReportIssue[], prefer?: (issue: ReportIssue) => boolean): never {
    if (failures.length === 0) throw new Error("The endpoint pool is empty")
    const thrown = (prefer && failures.find(prefer)) || failures[0]
    this.report(
      failures.filter((f) => f !== thrown),
      false,
    )
    throw new IoError(thrown)
  }

  private async chooseCrossCheck(header: Header): Promise<Comparison> {
    const primary = this.primary as Endpoint
    const candidates = crossOrder(this.pool, primary, this.settings, this.chain.chainId)
    const failures: ReportIssue[] = []
    for (const endpoint of candidates) {
      const live = await settle(this.checkChain(endpoint, "cross-check"))
      const other = live.ok ? await settle(this.header(endpoint, header.number, "cross-check")) : live
      if (!other.ok) {
        failures.push(other.issue)
        continue
      }
      this.cross = endpoint
      this.used.add(endpoint)
      this.report(failures, true)
      const comparison = this.compareHeader(header, other.value)
      this.crossHeaders.set(header.number, Promise.resolve(comparison))
      return comparison
    }
    this.report(failures, false)
    this.crossMissing = crossMissingReason(this.pool, primary, candidates.length)
    return "not-run"
  }

  private compareHeader(mine: Header, theirs: Header): Comparison {
    if (mine.hash === theirs.hash && mine.stateRoot === theirs.stateRoot) return "match"
    const cross = this.cross as Endpoint
    this.onIssue(
      this.transport.issue("disagreement", cross, "eth_getBlockByNumber", {
        role: "cross-check",
        operation: `confirm the header of block ${mine.number}`,
        vars: { block: mine.number, otherHost: this.primary?.host, what: "block hashes or state roots" },
      }),
    )
    return "mismatch"
  }

  // The cross-check's view of a header another operator returned; cached per block number.
  private crossHeader(header: Header): Promise<Comparison> {
    let comparison = this.crossHeaders.get(header.number)
    if (!comparison) {
      const cross = this.cross
      comparison = cross
        ? this.header(cross, header.number, "cross-check").then(
            (theirs) => this.compareHeader(header, theirs),
            (error: unknown) => {
              const io = ioErrorOf(error)
              if (!io) throw error
              this.onIssue(io.issue)
              return "not-served" as const
            },
          )
        : Promise.resolve("not-run" as const)
      this.crossHeaders.set(header.number, comparison)
    }
    return comparison
  }

  private requireAnchor(): Anchor {
    if (!this.current || !this.primary || !this.anchorHeader) throw new Error("anchor() must run first")
    return this.current
  }

  private report(issues: readonly ReportIssue[], recovered: boolean): void {
    for (const issue of issues) this.onIssue({ ...issue, recovered })
  }

  // ---------------------------------------------------------------------------------------------------------------
  // Proven reads

  async proveAccount(address: Address, slots: readonly Hex[]): Promise<ProvenAccountRead> {
    const anchor = this.requireAnchor()
    const keys = [...new Set(slots.map(storageKey))]
    const operation = `prove the account and storage of ${short(address)}`
    if (this.mode === "header-only") {
      // One kind for every header-only refusal; `anchor.headerOnly` says why.
      throw new IoError(
        this.transport.issue("method-unsupported", this.primary as Endpoint, "eth_getProof", {
          role: "primary",
          operation,
          vars: { hint: `No RPC proves block ${anchor.number}, so state is read without proofs.` },
        }),
      )
    }
    if (this.mode === "tip") return this.proveTip(address, keys, operation)

    const header = this.anchorHeader as Header
    const crossRead = this.crossValues(address, keys, header)
    const read = await settle(
      this.failover(this.proofEndpoints(), { capability: "proofs", anyKind: true }, (endpoint, role) =>
        this.proveAt(endpoint, address, keys, header, role, operation),
      ),
    )
    const cross = await crossRead
    if (read.ok) return this.provenRead(address, anchor, read.value.value, read.value.endpoint, keys, cross)
    // Every other endpoint failed, but the cross-check's own proof verified against the agreed root: the values are
    // proven either way, and nothing was compared.
    if (cross.proven && this.cross) {
      this.onIssue({ ...read.issue, recovered: true })
      return {
        address: getAddress(address),
        anchor,
        account: cross.proven.account,
        values: cross.proven.values,
        servedBy: this.cross.host,
        cross: { storageRoot: "not-served", values: keys.length ? "not-served" : "not-run", mismatched: [] },
      }
    }
    throw new IoError(read.issue)
  }

  private async proveTip(address: Address, keys: Hex[], operation: string): Promise<ProvenAccountRead> {
    const lower = address.toLowerCase()
    const all = this.tipKeys.get(lower) ?? new Set<Hex>()
    for (const key of keys) all.add(key)
    this.tipKeys.set(lower, all)
    const allKeys = [...all]
    // Never the cross-check's operator: it must confirm the tip block's header independently.
    const read = await this.failover(this.proofEndpoints(), { capability: "proofs", anyKind: true }, (endpoint, role) =>
      this.proveAtTip(endpoint, address, allKeys, role, operation),
    )
    const header = read.value.header
    const comparison = await this.crossHeader(header)
    const anchor: Anchor = { ...header, pinnedBy: "tip", note: this.current?.note ?? null, header: comparison }
    if (this.current?.selfTrusted && comparison === "not-run") anchor.selfTrusted = true
    this.current = anchor
    const cross = await this.crossValues(address, allKeys, header)
    return this.provenRead(address, anchor, read.value, read.endpoint, allKeys, cross)
  }

  private provenRead(
    address: Address,
    anchor: Anchor,
    proven: Proven,
    endpoint: Endpoint,
    keys: Hex[],
    cross: CrossValues,
  ): ProvenAccountRead {
    // One operator on both sides is never a comparison.
    const oneOperator = endpoint.operator === this.cross?.operator
    const storageRoot: Comparison = oneOperator
      ? "not-served"
      : cross.root === undefined
        ? cross.status
        : cross.root === (proven.account?.storageHash ?? null)
          ? "match"
          : "mismatch"
    const mismatched =
      cross.values === null || oneOperator
        ? []
        : keys.filter((key) => (cross.values?.get(key) ?? 0n) !== proven.values.get(key))
    const values: Comparison =
      keys.length === 0
        ? "not-run"
        : oneOperator
          ? "not-served"
          : cross.values === null
            ? cross.status
            : mismatched.length
              ? "mismatch"
              : "match"
    if (storageRoot === "mismatch" || values === "mismatch") {
      this.onIssue(
        this.transport.issue("disagreement", this.cross as Endpoint, "eth_getProof", {
          role: "cross-check",
          operation: `compare the storage of ${short(address)}`,
          vars: { block: anchor.number, otherHost: endpoint.host, what: "storage" },
        }),
      )
    }
    return {
      address: getAddress(address),
      anchor,
      account: proven.account,
      values: proven.values,
      servedBy: endpoint.host,
      cross: { storageRoot, values, mismatched },
    }
  }

  // Every endpoint outside the cross-check's operator that may serve proofs, the primary first.
  private proofEndpoints(): Endpoint[] {
    return this.independent().filter(
      (e, i) => i === 0 || this.caps.get(this.chain.chainId, e.url).proofs.status !== "no",
    )
  }

  private async proveAt(
    endpoint: Endpoint,
    address: Address,
    keys: Hex[],
    header: Header,
    role: EndpointRole,
    operation: string,
  ): Promise<Proven> {
    const ctx: CallContext = { role, operation, vars: { block: header.number } }
    const proof = await this.fetchProof(endpoint, address, keys, header.number, ctx)
    return this.verify(endpoint, ctx, header.stateRoot, address, keys, proof)
  }

  private async fetchProof(
    endpoint: Endpoint,
    address: Address,
    keys: Hex[],
    block: bigint | "latest",
    ctx: CallContext,
  ): Promise<GetProofReturnType> {
    this.used.add(endpoint)
    const client = proofClient(this.transport, endpoint, ctx)
    try {
      return block === "latest"
        ? await client.getProof({ address, storageKeys: keys, blockTag: "latest" })
        : await client.getProof({ address, storageKeys: keys, blockNumber: block })
    } catch (error) {
      throw this.afterMpt(error, endpoint, ctx)
    }
  }

  // Once this run verified a Merkle Patricia proof, an answer in another format is not a different trie but a wrong
  // answer: proof-invalid, so it can never open a path to unproven reads.
  private afterMpt(error: unknown, endpoint: Endpoint, ctx: CallContext): unknown {
    const io = ioErrorOf(error)
    if (io?.kind !== "non-mpt" || this.mode === "header-only" || !this.current) return error
    return new IoError(
      this.transport.issue("proof-invalid", endpoint, "eth_getProof", ctx, io.issue.raw.message ?? "non-MPT proof"),
    )
  }

  // eth_getProof at latest, tied to its block by matching keccak256(accountProof[0]) with a recent header's stateRoot.
  private async proveAtTip(
    endpoint: Endpoint,
    address: Address,
    keys: Hex[],
    role: EndpointRole,
    operation: string,
  ): Promise<Proven & { header: Header }> {
    const ctx: CallContext = { role, operation }
    const proof = await this.fetchProof(endpoint, address, keys, "latest", ctx)
    const root = keccak256(proof.accountProof[0] ?? "0x")
    const head = await this.blockNumber(endpoint, role)
    for (const offset of TIP_OFFSETS) {
      const header = await settle(this.header(endpoint, head - offset, role))
      if (header.ok && header.value.stateRoot === root) {
        const verified = await this.verify(endpoint, ctx, root, address, keys, proof)
        return { header: header.value, ...verified }
      }
    }
    throw new IoError(
      this.transport.issue(
        "invalid-response",
        endpoint,
        "eth_getProof",
        { ...ctx, vars: { hint: `Its newest proof matched none of the headers around block ${head}.` } },
        `proof root ${root} matched no header from ${head - 4n} to ${head + 1n}`,
      ),
    )
  }

  private async verify(
    endpoint: Endpoint,
    ctx: CallContext,
    stateRoot: Hex,
    address: Address,
    keys: Hex[],
    proof: GetProofReturnType,
  ): Promise<Proven> {
    const fail = async (error: unknown, kind?: IssueKind): Promise<never> => {
      if (!(error instanceof ProofError) && kind === undefined) throw error
      const message = error instanceof Error ? error.message : String(error)
      let found = kind ?? ((await otherAccountFormat(stateRoot, address, proof)) ? "non-mpt" : "proof-invalid")
      if (found === "non-mpt" && this.mode !== "header-only" && this.current) found = "proof-invalid"
      // While anchoring on a chain known not to use standard proofs (Avalanche roots proofs at another block), a
      // mismatch is the chain's format, not an RPC sending wrong data.
      if (found === "proof-invalid" && !this.current && this.chain.rootCheck.status === "unsupported") found = "non-mpt"
      throw new IoError(this.transport.issue(found, endpoint, "eth_getProof", ctx, message))
    }
    let account: ProvenAccount | null = null
    try {
      account = await verifyAccountProof(stateRoot, address, proof)
    } catch (error) {
      await fail(error)
    }
    const values = new Map<Hex, bigint>()
    for (const key of keys) {
      const entry = proof.storageProof.find(
        (p) => isHex(p.key) && p.key !== "0x" && hexToBigInt(p.key) === hexToBigInt(key),
      )
      if (!entry) await fail(new Error(`The proof of slot ${key} is missing`), "invalid-response")
      else if (account === null) {
        // No account, so no storage: every slot must read as zero.
        if (entry.value !== 0n) await fail(new ProofError(`Slot ${key} is non-zero on an account that does not exist`))
        values.set(key, 0n)
      } else {
        try {
          values.set(key, await verifyStorageProof(account.storageHash, key, entry))
        } catch (error) {
          await fail(error, error instanceof ProofError ? "proof-invalid" : undefined)
        }
      }
    }
    return { account, values }
  }

  // ---------------------------------------------------------------------------------------------------------------
  // Cross-check of proven reads: the same proof when the cross-check serves it, else eth_getStorageAt per key.

  private async crossValues(address: Address, keys: Hex[], header: Header): Promise<CrossValues> {
    const cross = this.cross
    if (!cross) return { status: "not-run", root: undefined, values: null, proven: null }
    const caps = this.caps.get(this.chain.chainId, cross.url)
    const operation = `compare the storage of ${short(address)}`
    if (caps.proofs.status !== "no") {
      const read = await settle(this.proveAt(cross, address, keys, header, "cross-check", operation))
      if (read.ok) {
        const root = read.value.account?.storageHash ?? null
        return { status: "match", root, values: read.value.values, proven: read.value }
      }
      if (read.issue.kind === "proof-invalid") {
        this.onIssue(read.issue)
        return { status: "mismatch", root: "invalid", values: null, proven: null }
      }
      // A cross-check without proofs is normal (header-only endpoints); only a passing failure is worth a line.
      this.caps.fail(this.chain.chainId, cross.url, "proofs", read.issue)
      if (!isCapabilityGap(read.issue)) this.onIssue({ ...read.issue, recovered: true })
    }
    if (keys.length === 0 || caps.storageAt.status === "no") {
      return { status: "not-served", root: undefined, values: null, proven: null }
    }
    const ctx: CallContext = { role: "cross-check", operation, vars: { block: header.number } }
    const read = await settle(this.storageWords(cross, address, keys, numberToHex(header.number), ctx))
    if (!read.ok) {
      this.caps.fail(this.chain.chainId, cross.url, "storageAt", read.issue)
      if (!isCapabilityGap(read.issue)) this.onIssue(read.issue)
      return { status: "not-served", root: undefined, values: null, proven: null }
    }
    this.caps.set(this.chain.chainId, cross.url, "storageAt", { status: "yes", value: true })
    return { status: "not-served", root: undefined, values: read.value, proven: null }
  }

  // ---------------------------------------------------------------------------------------------------------------
  // Unproven reads: header-only anchors and chains whose proofs are not Merkle Patricia proofs.

  async readUnproven(address: Address, slots: readonly Hex[]): Promise<UnprovenAccountRead> {
    const anchor = this.requireAnchor()
    const keys = [...new Set(slots.map(storageKey))]
    const block = numberToHex(anchor.number)
    const operation = `read the storage of ${short(address)} without proofs`
    const readAll = async (endpoint: Endpoint, role: EndpointRole) => {
      const ctx: CallContext = { role, operation, vars: { block: anchor.number } }
      const code = await this.codeWord(endpoint, address, block, ctx)
      const values = await this.storageWords(endpoint, address, keys, block, ctx)
      return { codeHash: code === "0x" ? null : keccak256(code), values }
    }
    const cross = this.cross
    const crossRead = cross ? settle(readAll(cross, "cross-check")) : null
    const read = await this.failover(this.independent(), { capability: "storageAt" }, readAll)
    let comparison: Comparison = "not-run"
    let mismatched: Hex[] = []
    if (crossRead) {
      const theirs = await crossRead
      if (theirs.ok) {
        mismatched = keys.filter((key) => theirs.value.values.get(key) !== read.value.values.get(key))
        comparison = mismatched.length || theirs.value.codeHash !== read.value.codeHash ? "mismatch" : "match"
        if (comparison === "mismatch") {
          this.onIssue(
            this.transport.issue("disagreement", cross as Endpoint, "eth_getStorageAt", {
              role: "cross-check",
              operation,
              vars: { block: anchor.number, otherHost: read.endpoint.host, what: "storage or code" },
            }),
          )
        }
      } else {
        this.onIssue(theirs.issue)
        comparison = "not-served"
      }
    }
    return {
      address: getAddress(address),
      anchor,
      codeHash: read.value.codeHash,
      values: read.value.values,
      servedBy: read.endpoint.host,
      cross: { values: comparison, mismatched },
    }
  }

  // ---------------------------------------------------------------------------------------------------------------
  // Other reads at the anchor

  async code(address: Address, provenCodeHash: Hex): Promise<Hex> {
    const anchor = this.requireAnchor()
    const read = await this.failover(this.independent(), {}, async (endpoint, role) => {
      const ctx: CallContext = { role, operation: `read the code of ${short(address)}`, vars: { block: anchor.number } }
      const code = await this.codeWord(endpoint, address, numberToHex(anchor.number), ctx)
      if (keccak256(code) !== provenCodeHash.toLowerCase()) {
        throw new IoError(
          this.transport.issue(
            "invalid-response",
            endpoint,
            "eth_getCode",
            { ...ctx, vars: { hint: "The code it sent does not match the proven code hash." } },
            `keccak256(code) differs from ${provenCodeHash}`,
          ),
        )
      }
      return code
    })
    return read.value
  }

  async call(to: Address, data: Hex): Promise<CallRead> {
    const anchor = this.requireAnchor()
    const block = numberToHex(anchor.number)
    const operation = `call ${data.slice(0, 10)} on ${short(to)}`
    const params = [{ to, data }, block]
    const cross = this.cross
    const crossCaps = cross ? this.caps.get(this.chain.chainId, cross.url) : null
    const crossCall =
      cross && crossCaps?.archiveCall.status !== "no"
        ? settle(
            this.transport.rpc(cross, "eth_call", params, {
              role: "cross-check",
              operation,
              vars: { block: anchor.number },
            }),
          )
        : null
    const read = await this.failover(this.independent(), { capability: "archiveCall" }, async (endpoint, role) => {
      const result = await this.transport.rpc(endpoint, "eth_call", params, {
        role,
        operation,
        vars: { block: anchor.number },
      })
      if (typeof result !== "string" || !isHex(result)) {
        throw new IoError(
          this.transport.issue("invalid-response", endpoint, "eth_call", { role, operation }, String(result)),
        )
      }
      return result as Hex
    })
    let comparison: Comparison = cross ? "not-served" : "not-run"
    if (crossCall && cross) {
      const theirs = await crossCall
      if (theirs.ok) {
        this.caps.set(this.chain.chainId, cross.url, "archiveCall", { status: "yes", value: true })
        comparison = theirs.value === read.value ? "match" : "mismatch"
      } else if (theirs.issue.kind === "reverted") {
        comparison = "mismatch"
      } else {
        this.caps.fail(this.chain.chainId, cross.url, "archiveCall", theirs.issue)
      }
      if (comparison === "mismatch") {
        this.onIssue(
          this.transport.issue("disagreement", cross, "eth_call", {
            role: "cross-check",
            operation,
            vars: { block: anchor.number, otherHost: read.endpoint.host, what: "call results" },
          }),
        )
      }
    }
    return { data: read.value, servedBy: read.endpoint.host, cross: comparison }
  }

  // The transaction and its status, compared with the cross-check's copy when it serves one.
  async transaction(hash: Hex): Promise<TxRead> {
    const operation = `read transaction ${short(hash)}`
    const cross = this.cross
    const crossRead = cross ? settle(this.readTransaction(cross, hash, "cross-check", operation)) : null
    const attempt = await settle(
      this.failover(this.independent(), {}, (endpoint, role) => this.readTransaction(endpoint, hash, role, operation)),
    )
    if (!attempt.ok) {
      // A transaction is not state: when only the cross-check has it (a pruned index elsewhere answers null), use it
      // and say it had one source. State reads never take this path.
      const theirs = crossRead ? await crossRead : null
      if (!theirs?.ok) throw new IoError(attempt.issue)
      this.onIssue({ ...attempt.issue, recovered: true })
      return { ...theirs.value, cross: "not-served", singleSource: true }
    }
    const read = attempt.value
    let comparison: Comparison = "not-run"
    if (crossRead && cross) {
      const theirs = await crossRead
      if (!theirs.ok) {
        comparison = "not-served"
      } else {
        const mine = read.value
        const same =
          theirs.value.from === mine.from &&
          theirs.value.to === mine.to &&
          theirs.value.input.toLowerCase() === mine.input.toLowerCase() &&
          theirs.value.blockNumber === mine.blockNumber &&
          theirs.value.status === mine.status
        comparison = same ? "match" : "mismatch"
        if (!same) {
          this.onIssue(
            this.transport.issue("disagreement", cross, "eth_getTransactionByHash", {
              role: "cross-check",
              operation,
              vars: { otherHost: read.endpoint.host, what: `copies of transaction ${short(hash)}` },
            }),
          )
        }
      }
    }
    return { ...read.value, cross: comparison }
  }

  private async readTransaction(endpoint: Endpoint, hash: Hex, role: EndpointRole, operation: string) {
    const ctx: CallContext = { role, operation }
    const [tx, receipt] = await Promise.all([
      this.transport.rpc(endpoint, "eth_getTransactionByHash", [hash], ctx),
      this.transport.rpc(endpoint, "eth_getTransactionReceipt", [hash], ctx),
    ])
    if (tx === null || receipt === null) {
      throw new IoError(this.transport.issue("not-found", endpoint, "eth_getTransactionByHash", ctx))
    }
    const t = tx as Record<string, unknown>
    const r = receipt as Record<string, unknown>
    if (!isHex(t.from) || !isHex(t.input) || !isQuantity(t.blockNumber)) {
      throw new IoError(this.transport.issue("invalid-response", endpoint, "eth_getTransactionByHash", ctx))
    }
    return {
      hash,
      from: getAddress(t.from as Hex),
      to: isHex(t.to) ? getAddress(t.to as Hex) : null,
      input: t.input as Hex,
      blockNumber: hexToBigInt(t.blockNumber),
      status: r.status === "0x1",
    }
  }

  // A receipt is not state either: when every other RPC fails or has none, the cross-check's copy serves.
  async receiptLogs(hash: Hex): Promise<RawLog[]> {
    const attempt = await settle(
      this.failover(this.independent(), {}, (endpoint, role) => this.readReceipt(endpoint, hash, role)),
    )
    if (attempt.ok) return attempt.value.value
    if (!this.cross) throw new IoError(attempt.issue)
    const theirs = await settle(this.readReceipt(this.cross, hash, "cross-check"))
    if (!theirs.ok) throw new IoError(attempt.issue)
    this.onIssue({ ...attempt.issue, recovered: true })
    return theirs.value
  }

  // The receipt from the cross-check RPC, an operator other than the one that served the logs; from the primary only
  // when the run has no cross-check. Used to confirm the events that clear a finding.
  async confirmingReceiptLogs(hash: Hex): Promise<{ logs: RawLog[]; by: EndpointRole }> {
    if (!this.cross) return { logs: await this.receiptLogs(hash), by: "primary" }
    return { logs: await this.readReceipt(this.cross, hash, "cross-check"), by: "cross-check" }
  }

  private async readReceipt(endpoint: Endpoint, hash: Hex, role: EndpointRole): Promise<RawLog[]> {
    this.used.add(endpoint)
    const ctx: CallContext = { role, operation: `read the events of transaction ${short(hash)}` }
    const receipt = await this.transport.rpc(endpoint, "eth_getTransactionReceipt", [hash], ctx)
    if (receipt === null)
      throw new IoError(this.transport.issue("not-found", endpoint, "eth_getTransactionReceipt", ctx))
    const logs = (receipt as { logs?: unknown }).logs
    if (!Array.isArray(logs)) {
      throw new IoError(this.transport.issue("invalid-response", endpoint, "eth_getTransactionReceipt", ctx))
    }
    return logs.map(toRawLog)
  }

  async callTrace(hash: Hex): Promise<CallFrame> {
    const read = await this.failover(this.independent(), { capability: "callTrace" }, async (endpoint, role) => {
      const ctx: CallContext = { role, operation: `trace the calls of transaction ${short(hash)}` }
      const frame = await this.transport.rpc(endpoint, "debug_traceTransaction", [hash, { tracer: "callTracer" }], ctx)
      return toCallFrame(frame)
    })
    return read.value
  }

  async storageDiff(hash: Hex): Promise<StorageDiff> {
    const read = await this.failover(this.independent(), { capability: "prestateTrace" }, async (endpoint, role) => {
      const ctx: CallContext = { role, operation: `trace the storage writes of transaction ${short(hash)}` }
      const result = await this.transport.rpc(
        endpoint,
        "debug_traceTransaction",
        [hash, { tracer: "prestateTracer", tracerConfig: { diffMode: true } }],
        ctx,
      )
      return toStorageDiff(result)
    })
    return read.value
  }

  async storageRange(address: Address): Promise<{ values: ReadonlyMap<Hex, bigint>; complete: boolean }> {
    const anchor = this.requireAnchor()
    const read = await this.failover(this.independent(), { capability: "storageRange" }, async (endpoint, role) => {
      // The state after block N is the state before the first transaction of block N + 1.
      const next = await this.header(endpoint, anchor.number + 1n, role)
      const ctx: CallContext = { role, operation: `list the storage of ${short(address)}` }
      const values = new Map<Hex, bigint>()
      let start: Hex = `0x${"0".repeat(64)}`
      let complete = true
      for (let page = 0; page < STORAGE_RANGE_PAGES; page++) {
        const result = (await this.transport.rpc(
          endpoint,
          "debug_storageRangeAt",
          [next.hash, 0, address, start, STORAGE_RANGE_PAGE],
          ctx,
        )) as { storage?: Record<string, { key: Hex | null; value: Hex }>; nextKey?: Hex | null } | null
        if (!result || typeof result.storage !== "object") {
          throw new IoError(this.transport.issue("invalid-response", endpoint, "debug_storageRangeAt", ctx))
        }
        for (const entry of Object.values(result.storage)) {
          // Without preimages the node knows only hashed keys, which cannot be proven.
          if (!entry.key) complete = false
          else if (hexToBigInt(entry.value) !== 0n) values.set(storageKey(entry.key), hexToBigInt(entry.value))
        }
        if (!result.nextKey) return { values, complete }
        start = result.nextKey
      }
      return { values, complete: false }
    })
    return read.value
  }

  // ---------------------------------------------------------------------------------------------------------------
  // Reads for the event source and the creation finder (src/data/logs.ts, src/data/creation.ts)

  // The largest eth_getLogs range an endpoint serves, trying 10,000, 1,000 and 100 blocks ending at the anchor on the
  // primary first, then on the other endpoints outside the cross-check's operator; 0 when none serves logs. The first
  // endpoint that answers is where history chunks start.
  async logsRange(address: Address): Promise<number> {
    const anchor = this.requireAnchor()
    let first: ReportIssue | null = null
    for (const endpoint of this.independent()) {
      const cached = this.caps.get(this.chain.chainId, endpoint.url).logs
      if (cached.status === "yes") {
        this.logsEndpoint = endpoint
        return cached.value.maxRange
      }
      if (cached.status === "no") continue
      this.used.add(endpoint)
      let last: ReportIssue | null = null
      for (const range of LOG_RANGES) {
        const from = anchor.number >= BigInt(range) ? anchor.number - BigInt(range) + 1n : 0n
        const ctx: CallContext = {
          role: endpoint === this.primary ? "primary" : "fallback",
          operation: `read ${range} blocks of events`,
          vars: { range: BigInt(range), block: from },
        }
        const read = await settle(
          this.transport.rpc(
            endpoint,
            "eth_getLogs",
            [{ address, fromBlock: numberToHex(from), toBlock: numberToHex(anchor.number) }],
            ctx,
          ),
        )
        if (read.ok) {
          this.caps.set(this.chain.chainId, endpoint.url, "logs", { status: "yes", value: { maxRange: range } })
          this.logsEndpoint = endpoint
          if (first) this.onIssue({ ...first, recovered: true })
          return range
        }
        last = read.issue
        if (!["range-too-large", "server-error", "timeout", "invalid-response", "unknown"].includes(read.issue.kind)) {
          break
        }
      }
      if (last) {
        this.caps.fail(this.chain.chainId, endpoint.url, "logs", last)
        first ??= last
      }
    }
    if (first) this.onIssue(first)
    return 0
  }

  // The host history chunks start on.
  logsHost(): string {
    return (this.logsEndpoint ?? this.primary ?? this.pool[0].endpoint).host
  }

  // eth_getLogs for one chunk, with failover; topics filter topic0 only. A null address reads every contract.
  async logsChunk(
    address: Address | null,
    fromBlock: bigint,
    toBlock: bigint,
    topic0?: readonly Hex[],
  ): Promise<RawLog[]> {
    const filter = {
      ...(address ? { address } : {}),
      fromBlock: numberToHex(fromBlock),
      toBlock: numberToHex(toBlock),
      ...(topic0?.length ? { topics: [[...topic0]] } : {}),
    }
    // Every log-capable endpoint outside the cross-check's operator, the one logsRange() found first. A range one
    // endpoint refuses may suit another; when all refuse it, "range too large" is what the caller hears, so it splits.
    const preferred = this.logsEndpoint
    const capable = this.independent().filter((e) => this.caps.get(this.chain.chainId, e.url).logs.status !== "no")
    const endpoints = preferred ? [preferred, ...capable.filter((e) => e !== preferred)] : capable
    const options: FailoverOptions = {
      alsoMoveOn: ["range-too-large"],
      prefer: (issue) => issue.kind === "range-too-large",
    }
    const read = await this.failover(
      endpoints.length ? endpoints : this.independent(),
      options,
      async (endpoint, role) => {
        const ctx: CallContext = {
          role,
          operation: `read events from block ${fromBlock} to ${toBlock}`,
          vars: { range: toBlock - fromBlock + 1n, block: fromBlock },
        }
        const logs = await this.transport.rpc(endpoint, "eth_getLogs", [filter], ctx)
        if (!Array.isArray(logs)) {
          throw new IoError(this.transport.issue("invalid-response", endpoint, "eth_getLogs", ctx))
        }
        return logs.map(toRawLog)
      },
    )
    return read.value
  }

  // Whether `address` has code at `block`; needs archive state for old blocks.
  async hasCodeAt(address: Address, block: bigint): Promise<boolean> {
    const read = await this.failover(this.independent(), {}, async (endpoint, role) => {
      const ctx: CallContext = {
        role,
        operation: `read the code of ${short(address)} at block ${block}`,
        vars: { block },
      }
      return (await this.codeWord(endpoint, address, numberToHex(block), ctx)) !== "0x"
    })
    return read.value
  }

  // "changed" when any endpoint returns another hash; "unchanged" when at least one returns the same; throws the
  // primary's failure when neither answers.
  async recheckAnchor(anchor: Anchor): Promise<"unchanged" | "changed"> {
    const primary = this.primary
    if (!primary) throw new Error("anchor() must run first")
    const reads = await Promise.all([
      settle(this.header(primary, anchor.number, "primary")),
      this.cross ? settle(this.header(this.cross, anchor.number, "cross-check")) : null,
    ])
    const answered = reads.filter((r): r is { ok: true; value: Header } => r?.ok === true)
    const failed = reads.filter((r): r is { ok: false; issue: ReportIssue } => r?.ok === false)
    if (answered.length === 0) this.throwFirst(failed.map((f) => f.issue))
    for (const f of failed) this.onIssue(f.issue)
    return answered.some((r) => r.value.hash !== anchor.hash) ? "changed" : "unchanged"
  }

  // ---------------------------------------------------------------------------------------------------------------
  // Plumbing

  // The primary, then every endpoint whose operator is not the cross-check's: failover never lets the cross-check's
  // operator answer for the primary.
  private independent(): Endpoint[] {
    const primary = this.primary as Endpoint
    const crossOperator = this.cross?.operator
    return [primary, ...this.pool.map((e) => e.endpoint).filter((e) => e !== primary && e.operator !== crossOperator)]
  }

  // Runs `read` on each endpoint in turn while the failure is about that endpoint (docs/ARCHITECTURE.md section
  // 6.8). Failures before a success are reported as recovered; when all fail, the first failure is thrown and the
  // others are reported.
  private async failover<T>(
    endpoints: readonly Endpoint[],
    options: FailoverOptions,
    read: (endpoint: Endpoint, role: EndpointRole) => Promise<T>,
  ): Promise<{ value: T; endpoint: Endpoint }> {
    const { capability, anyKind = false, alsoMoveOn = [], prefer } = options
    const failures: ReportIssue[] = []
    for (const [index, endpoint] of endpoints.entries()) {
      const role: EndpointRole = index === 0 ? "primary" : "fallback"
      this.used.add(endpoint)
      const result = await settle(read(endpoint, role))
      if (result.ok) {
        if (capability === "proofs") {
          const current = this.caps.get(this.chain.chainId, endpoint.url).proofs
          if (current.status !== "yes") {
            this.caps.set(this.chain.chainId, endpoint.url, "proofs", { status: "yes", value: "recent" })
          }
        } else if (capability) {
          this.caps.set(this.chain.chainId, endpoint.url, capability, { status: "yes", value: true })
        }
        this.report(failures, true)
        return { value: result.value, endpoint }
      }
      if (capability) this.caps.fail(this.chain.chainId, endpoint.url, capability, result.issue)
      failures.push(result.issue)
      const moveOn = anyKind
        ? result.issue.kind !== "cancelled"
        : ENDPOINT_KINDS.has(result.issue.kind) || alsoMoveOn.includes(result.issue.kind)
      if (!moveOn || this.transport.aborted) break
    }
    this.throwFirst(failures, prefer)
  }

  private async checkChain(endpoint: Endpoint, role: EndpointRole): Promise<void> {
    this.used.add(endpoint)
    const result = await probeChainId(this.transport, endpoint, this.chain.chainId, this.caps, {
      role: role === "cross-check" ? "cross-check" : "primary",
    })
    if (!result.ok) {
      throw new IoError(
        this.transport.issue("wrong-chain", endpoint, "eth_chainId", {
          role,
          operation: "check which chain it serves",
          vars: { expectedChainId: this.chain.chainId, actualChainId: result.actual },
        }),
      )
    }
  }

  private async blockNumber(endpoint: Endpoint, role: EndpointRole): Promise<bigint> {
    const ctx: CallContext = { role, operation: "read the newest block number" }
    const result = await this.transport.rpc(endpoint, "eth_blockNumber", [], ctx)
    if (!isQuantity(result)) {
      throw new IoError(this.transport.issue("invalid-response", endpoint, "eth_blockNumber", ctx, String(result)))
    }
    return hexToBigInt(result)
  }

  private async header(endpoint: Endpoint, number: bigint, role: EndpointRole): Promise<Header> {
    const ctx: CallContext = { role, operation: `read the header of block ${number}`, vars: { block: number } }
    const block = await this.transport.rpc(endpoint, "eth_getBlockByNumber", [numberToHex(number), false], ctx)
    if (block === null) {
      throw new IoError(this.transport.issue("block-unavailable", endpoint, "eth_getBlockByNumber", ctx))
    }
    const b = block as Record<string, unknown>
    if (!isWord(b.hash) || !isWord(b.stateRoot) || !isQuantity(b.number) || !isQuantity(b.timestamp)) {
      throw new IoError(
        this.transport.issue(
          "invalid-response",
          endpoint,
          "eth_getBlockByNumber",
          ctx,
          "the header lacks hash or stateRoot",
        ),
      )
    }
    if (hexToBigInt(b.number) !== number) {
      throw new IoError(
        this.transport.issue(
          "invalid-response",
          endpoint,
          "eth_getBlockByNumber",
          ctx,
          `asked for ${number}, got ${b.number}`,
        ),
      )
    }
    return {
      number,
      hash: b.hash.toLowerCase() as Hex,
      stateRoot: b.stateRoot.toLowerCase() as Hex,
      timestamp: hexToBigInt(b.timestamp),
    }
  }

  private async codeWord(endpoint: Endpoint, address: Address, block: Hex, ctx: CallContext): Promise<Hex> {
    const code = await this.transport.rpc(endpoint, "eth_getCode", [address, block], ctx)
    if (typeof code !== "string" || !isHex(code)) {
      throw new IoError(this.transport.issue("invalid-response", endpoint, "eth_getCode", ctx, String(code)))
    }
    return code as Hex
  }

  private async storageWords(
    endpoint: Endpoint,
    address: Address,
    keys: readonly Hex[],
    block: Hex,
    ctx: CallContext,
  ): Promise<Map<Hex, bigint>> {
    const values = await Promise.all(
      keys.map(async (key) => {
        const value = await this.transport.rpc(endpoint, "eth_getStorageAt", [address, key, block], ctx)
        if (!isQuantity(value)) {
          throw new IoError(this.transport.issue("invalid-response", endpoint, "eth_getStorageAt", ctx, String(value)))
        }
        return [key, hexToBigInt(value)] as const
      }),
    )
    return new Map(values)
  }
}

type CrossValues = {
  // match: the cross-check proved the read; not-served or not-run: it could not.
  status: Comparison
  // The cross-check's proven storage root (null: no account); undefined when it served no proof; "invalid" for a
  // proof that failed to verify.
  root: Hex | null | "invalid" | undefined
  values: ReadonlyMap<Hex, bigint> | null
  // The cross-check's verified proof, when it served one.
  proven: Proven | null
}

function toRawLog(log: unknown): RawLog {
  const l = log as Record<string, unknown>
  return {
    address: getAddress(l.address as Hex),
    topics: (l.topics as Hex[]).map((t) => t.toLowerCase() as Hex),
    data: l.data as Hex,
    blockNumber: hexToBigInt(l.blockNumber as Hex),
    transactionHash: (l.transactionHash as Hex).toLowerCase() as Hex,
    logIndex: Number(hexToBigInt(l.logIndex as Hex)),
  }
}

export function toCallFrame(frame: unknown): CallFrame {
  const f = frame as Record<string, unknown>
  return {
    type: String(f.type ?? "CALL"),
    from: getAddress(f.from as Hex),
    to: getAddress((f.to as Hex | undefined) ?? "0x0000000000000000000000000000000000000000"),
    input: (f.input as Hex | undefined) ?? "0x",
    value: isQuantity(f.value) ? hexToBigInt(f.value) : 0n,
    calls: Array.isArray(f.calls) ? f.calls.map(toCallFrame) : [],
  }
}

export function toStorageDiff(result: unknown): StorageDiff {
  const r = result as { pre?: Record<string, { storage?: Record<string, Hex> }>; post?: typeof r.pre }
  const diff: StorageDiff = {}
  const add = (side: "pre" | "post", accounts: typeof r.pre) => {
    for (const [address, account] of Object.entries(accounts ?? {})) {
      const key = getAddress(address)
      diff[key] ??= { pre: {}, post: {} }
      for (const [slot, value] of Object.entries(account.storage ?? {})) {
        diff[key][side][storageKey(slot as Hex)] = pad(value, { size: 32 }).toLowerCase() as Hex
      }
    }
  }
  add("pre", r.pre)
  add("post", r.post)
  return diff
}
