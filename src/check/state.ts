import type { Address, Hex } from "viem"
import { issueHeadline } from "@/core/markdown"
import type { ExpectedSlot } from "@/core/accounting"
import type { Registry } from "@/core/registry"
import { chainRef, STEP_LABELS, STEP_ORDER } from "@/core/steps"
import type {
  ChainRef,
  CheckEvent,
  CheckRequest,
  Comparison,
  Finding,
  Report,
  ReportIssue,
  SectionKey,
  StepId,
  StepRecord,
  StepStatus,
  StopReason,
  StorageSection,
} from "@/core/report"
import { ioErrorOf } from "@/data/errors"
import type { Anchor, CallRead, CheckDeps, ProvenAccountRead } from "@/data/types"

// A storage hash that is never compared: the fallback account read has no proven root, so no pass rebuilds against it.
export const UNPROVEN_STORAGE_HASH: Hex = "0x0000000000000000000000000000000000000000000000000000000000000000"

// Kept here as well, for the importers of this module; the UI takes them from @/core/steps.
export { chainRef, STEP_LABELS, STEP_ORDER } from "@/core/steps"

// Every issue of a run, once. The session reports issues as they happen (recovered ones too) and a failed read throws
// the same issue again, sometimes as a second object with the same words, so the words decide what is new.
const issueKey = (issue: ReportIssue) =>
  [
    issue.kind,
    issue.service,
    issue.host,
    issue.role,
    issue.operation,
    issue.title,
    issue.explanation,
    issue.recovered,
  ].join("|")

export class IssueLog {
  private readonly seen = new Set<string>()
  readonly all: ReportIssue[] = []
  private listener: ((issue: ReportIssue) => void) | null = null

  add(issue: ReportIssue) {
    const key = issueKey(issue)
    if (this.seen.has(key)) return
    this.seen.add(key)
    this.all.push(issue)
    this.listener?.(issue)
  }

  // Replays what was logged so far, then forwards new issues.
  listen(listener: (issue: ReportIssue) => void) {
    this.listener = listener
    for (const issue of this.all) listener(issue)
  }
}

// Ends the run without a report (nothing to check, or cancelled).
export class StopRun extends Error {
  override name = "StopRun"
  readonly reason: StopReason

  constructor(reason: StopReason, message: string) {
    super(message)
    this.reason = reason
  }
}

// One line for a step note, in the words the UI and the Markdown summary use.
export function issueLine(issue: ReportIssue): string {
  return `${issueHeadline(issue)}.`
}

type Sections = Pick<Report, Exclude<SectionKey, "verification">>

// Worst first: one mismatch outweighs any number of matches.
const COMPARISON_RANK: Record<Comparison, number> = { mismatch: 0, match: 1, "not-served": 2, "not-run": 3 }

export function worst(values: readonly Comparison[]): Comparison {
  return values.reduce<Comparison>(
    (acc, value) => (COMPARISON_RANK[value] < COMPARISON_RANK[acc] ? value : acc),
    "not-run",
  )
}

export type RunEnv = {
  registry: Registry
  // Shared with the session's `onIssue`; a fresh log is made when absent.
  issues?: IssueLog
  now?: () => Date
}

// Mutable state of one attempt: step records, findings, sections and read bookkeeping. A reorg restart starts a new one.
export class RunState {
  readonly safe: Address
  readonly chainId: number
  readonly chain: ChainRef
  readonly registry: Registry
  readonly steps: Map<StepId, StepRecord>
  readonly findings: Finding[] = []
  readonly notChecked: string[] = []
  readonly sections: Partial<Sections> = {}
  anchor: Anchor | null = null
  // The slots of storage pass 1, so pass 2 can re-read them with the event slots in one read.
  pass1Slots: ExpectedSlot[] = []
  // What keeps the storage result from being verified (a list that changed, an event no second RPC confirmed).
  storageGaps: string[] = []

  readonly reads = {
    accounts: new Set<string>(),
    slots: new Set<string>(),
    servedBy: new Set<string>(),
    anchors: new Map<string, Anchor>(),
    storageRoot: [] as Comparison[],
    slotValues: [] as Comparison[],
    calls: [] as Comparison[],
  }
  // The read whose storageHash the storage section compares with; in tip mode it defines the anchor.
  safeAnchor: Anchor | null = null

  readonly request: CheckRequest
  readonly deps: CheckDeps
  readonly emit: (event: CheckEvent) => void
  readonly env: { registry: Registry; issues: IssueLog; now: () => Date }

  constructor(
    request: CheckRequest,
    deps: CheckDeps,
    emit: (event: CheckEvent) => void,
    env: { registry: Registry; issues: IssueLog; now: () => Date },
  ) {
    this.request = request
    this.deps = deps
    this.emit = emit
    this.env = env
    this.safe = request.address
    this.chainId = request.chainId
    this.chain = chainRef(deps.reader.chain)
    this.registry = env.registry
    this.steps = new Map(STEP_ORDER.map((id) => [id, this.record(id, "pending", null)]))
  }

  private record(id: StepId, status: StepStatus, note: string | null): StepRecord {
    // Called from the constructor too, before `steps` exists.
    const previous = this.steps === undefined ? undefined : this.steps.get(id)
    const now = this.env.now().toISOString()
    return {
      id,
      label: STEP_LABELS[id],
      status,
      note,
      startedAt: status === "pending" ? null : (previous?.startedAt ?? now),
      finishedAt: status === "pending" || status === "running" ? null : now,
    }
  }

  setStep(id: StepId, status: StepStatus, note: string | null = null) {
    const record = this.record(id, status, note)
    this.steps.set(id, record)
    this.emit({ type: "step", step: record })
  }

  checkCancelled() {
    if (this.deps.signal.aborted) throw new StopRun("cancelled", "The check was cancelled.")
  }

  // Runs one step: `running`, then `done` (or what `fn` set with `finish`), or `failed` with the issue in plain words.
  async step<T>(id: StepId, fn: (finish: (status: StepStatus, note: string) => void) => Promise<T>): Promise<T | null> {
    this.checkCancelled()
    this.setStep(id, "running")
    let outcome: { status: StepStatus; note: string | null } = { status: "done", note: null }
    try {
      const result = await fn((status, note) => (outcome = { status, note }))
      this.setStep(id, outcome.status, outcome.note)
      return result
    } catch (error) {
      if (error instanceof StopRun) throw error
      const io = ioErrorOf(error)
      if (io?.kind === "cancelled" || this.deps.signal.aborted)
        throw new StopRun("cancelled", "The check was cancelled.")
      if (io !== null) this.issue(io.issue)
      this.setStep(id, "failed", io !== null ? issueLine(io.issue) : `Unexpected error: ${(error as Error).message}`)
      return null
    }
  }

  skip(id: StepId, reason: string) {
    this.setStep(id, "skipped", reason)
  }

  issue(issue: ReportIssue) {
    this.env.issues.add(issue)
  }

  // Logs the issue of an I/O failure and returns null; anything else is a bug and propagates.
  failed(error: unknown): null {
    const io = ioErrorOf(error)
    if (io === null || error instanceof StopRun) throw error
    if (io.kind === "cancelled") throw new StopRun("cancelled", "The check was cancelled.")
    this.issue(io.issue)
    return null
  }

  addFindings(findings: readonly Finding[]) {
    for (const finding of findings) {
      this.findings.push(finding)
      this.emit({ type: "finding", finding })
    }
  }

  setSection<K extends keyof Sections>(key: K, value: Sections[K]) {
    this.sections[key] = value
    this.emit({ type: "section", patch: { key, value } as never })
  }

  // The storage section, partial while any storage gap stands.
  setStorage(data: StorageSection, gaps: readonly string[] = []) {
    for (const gap of gaps) if (!this.storageGaps.includes(gap)) this.storageGaps.push(gap)
    this.setSection(
      "storage",
      this.storageGaps.length > 0
        ? { state: "partial", data, gaps: [...this.storageGaps] }
        : { state: "complete", data },
    )
  }

  // No endpoint proves the run's block (a chain without Merkle Patricia proofs, or no RPC serving eth_getProof): the
  // reader then serves state without proofs, and the storage root check cannot run.
  get headerOnly(): "unsupported" | "no-proof-rpc" | null {
    return this.anchor?.headerOnly ?? null
  }

  // A proven read, or with a header-only anchor an unproven one. Never a fallback per read: a proof that fails on a
  // chain whose proofs work fails the read, because an RPC could otherwise choose which accounts go unproven.
  async prove(address: Address, slots: readonly Hex[]): Promise<ProvenAccountRead> {
    const read =
      this.headerOnly === null
        ? await this.deps.reader.proveAccount(address, slots)
        : await this.unproven(address, slots)
    if (this.request.block !== null && read.anchor.number !== BigInt(this.request.block)) {
      throw new StopRun(
        "anchor-failed",
        `The RPC proved ${address} at block ${read.anchor.number}, not at the requested block ${this.request.block}.`,
      )
    }
    this.reads.accounts.add(address.toLowerCase())
    for (const slot of slots) this.reads.slots.add(`${address.toLowerCase()}:${slot.toLowerCase()}`)
    this.reads.servedBy.add(read.servedBy)
    this.reads.anchors.set(read.anchor.number.toString(), read.anchor)
    this.reads.storageRoot.push(read.cross.storageRoot)
    // An unproven read compares the code hash too, so it counts even without slots.
    if (slots.length > 0 || this.headerOnly !== null) this.reads.slotValues.push(read.cross.values)
    return read
  }

  private async unproven(address: Address, slots: readonly Hex[]): Promise<ProvenAccountRead> {
    const read = await this.deps.reader.readUnproven(address, slots)
    return {
      address: read.address,
      anchor: read.anchor,
      account:
        read.codeHash === null
          ? null
          : { nonce: 0n, balance: 0n, storageHash: UNPROVEN_STORAGE_HASH, codeHash: read.codeHash },
      values: read.values,
      servedBy: read.servedBy,
      cross: { storageRoot: "not-run", values: read.cross.values, mismatched: read.cross.mismatched },
    }
  }

  async call(to: Address, data: Hex): Promise<CallRead> {
    const read = await this.deps.reader.call(to, data)
    this.reads.calls.push(read.cross)
    return read
  }

  // eth_call that returns null on any I/O failure (logged); a revert is expected for missing getters.
  async tryCall(to: Address, data: Hex): Promise<CallRead | null> {
    try {
      return await this.call(to, data)
    } catch (error) {
      return this.failed(error)
    }
  }
}
