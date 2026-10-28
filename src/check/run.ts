import { sortFindings } from "@/core/findings"
import {
  type CheckEvent,
  type CheckRequest,
  type EndpointRef,
  type Part,
  REPORT_SCHEMA,
  type Report,
  type StorageSection,
  type VerificationSection,
} from "@/core/report"
import { NOT_CHECKED } from "@/core/scope"
import { decideVerdict, summaryCards, verificationNotChecked } from "@/core/verdict"
import { canPair } from "@/data/endpoints"
import { cleanUntrusted } from "@/core/text"
import type { CapabilityReport, CheckDeps, Endpoint } from "@/data/types"
import { chainRef, IssueLog, type RunEnv, RunState, StopRun, worst } from "@/check/state"
import { creationStep } from "@/check/steps/creation"
import { handlersStep, modulesStep, ownersStep } from "@/check/steps/inspect"
import { diagnosisStep, rootMismatchFinding, storageEventsStep } from "@/check/steps/diagnosis"
import { type ConfigNow, historyStep, pendingStep } from "@/check/steps/history"
import { configStep, identityStep, storageStep } from "@/check/steps/safe"

// Kept equal to package.json's version by a unit test.
export const TOOL: Report["tool"] = { name: "safe-state-check", version: "0.0.0", commit: null }

// The node's web3_clientVersion is the RPC's own text: kept short and free of control characters.
function endpointRef(endpoint: Endpoint, capabilities: readonly CapabilityReport[]): EndpointRef {
  const clientVersion = capabilities.find((report) => report.host === endpoint.host)?.clientVersion ?? null
  return {
    host: endpoint.host,
    operator: endpoint.operator,
    operatorName: endpoint.operatorName,
    origin: endpoint.origin,
    aggregator: endpoint.aggregator,
    clientVersion: clientVersion === null ? null : cleanUntrusted(clientVersion),
  }
}

const PIN_NOTES = {
  offset: "Three blocks below the newest block the primary RPC reported.",
  user: "The block you asked for.",
  tip: "The newest block: the RPCs prove only their latest state.",
} as const

// "agreed": two endpoints of different operators, not both aggregators, returned the same header for every block
// read. "self-trusted": no other operator confirmed it, and the user marked their own primary RPC as trusted alone;
// the reader sets the flag, and it never counts for a default RPC.
function agreementOf(run: RunState): VerificationSection["agreement"] {
  const anchors = [run.anchor!, ...run.reads.anchors.values()]
  const pair = run.deps.reader.pair()
  if (anchors.some((anchor) => anchor.header === "mismatch")) return "disagreed"
  const independent = pair.crossCheck !== null && canPair(pair.primary, pair.crossCheck)
  if (independent && anchors.every((anchor) => anchor.header === "match")) return "agreed"
  if (pair.primary.origin === "user" && anchors.every((anchor) => anchor.selfTrusted === true)) return "self-trusted"
  return "single-operator"
}

function verification(run: RunState, reorg: VerificationSection["reorg"]): VerificationSection {
  const runAnchor = run.anchor!
  const anchor = run.safeAnchor ?? runAnchor
  const pair = run.deps.reader.pair()
  const capabilities = run.deps.reader.capabilities()
  const header = worst([runAnchor, ...run.reads.anchors.values()].map((read) => read.header))
  const agreement = agreementOf(run)
  const blocks = [...new Set([anchor.number, ...[...run.reads.anchors.values()].map((read) => read.number)])]
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
    .map((number) => number.toString())
  return {
    anchor: {
      number: anchor.number.toString(),
      hash: anchor.hash,
      stateRoot: anchor.stateRoot,
      timestamp: new Date(Number(anchor.timestamp) * 1000).toISOString(),
      pinnedBy: anchor.pinnedBy,
      note: anchor.note ?? PIN_NOTES[anchor.pinnedBy],
    },
    primary: endpointRef(pair.primary, capabilities),
    crossCheck: pair.crossCheck === null ? null : endpointRef(pair.crossCheck, capabilities),
    crossCheckMissing:
      agreement === "single-operator" && pair.crossCheckMissing === null && pair.crossCheck !== null
        ? `The cross-check RPC ${pair.crossCheck.host} did not confirm every block read.`
        : pair.crossCheckMissing,
    agreement,
    coverage: {
      header,
      storageRoot: worst(run.reads.storageRoot),
      slotValues: worst(run.reads.slotValues),
      calls: worst(run.reads.calls),
    },
    proofs: {
      accounts: run.reads.accounts.size,
      slots: run.reads.slots.size,
      allVerified: !run.env.issues.all.some((issue) => issue.kind === "proof-invalid"),
      servedBy: [...run.reads.servedBy].sort(),
      blocks,
    },
    reorg,
    // The client version goes into the endpoint refs, cleaned; never raw into the report.
    capabilities: capabilities.map(({ host, available, missing }) => ({ host, available, missing })),
  }
}

function skipped<T>(reason: string): Part<T> {
  return { state: "skipped", reason }
}

type Attempt = { kind: "report"; report: Report } | { kind: "reorg" }

async function attempt(run: RunState, restarted: boolean): Promise<Attempt> {
  const anchor = await run.step("anchor", async () =>
    run.deps.reader.anchor({ block: run.request.block === null ? null : BigInt(run.request.block) }),
  )
  if (anchor === null) {
    throw new StopRun("anchor-failed", run.steps.get("anchor")?.note ?? "No block could be pinned on any RPC.")
  }
  run.anchor = anchor
  run.emit({ type: "section", patch: { key: "verification", value: verification(run, "not-run") } })

  const identity = await identityStep(run)
  const creation = identity === null ? null : creationStep(run)
  // Awaited below; this only keeps a stop elsewhere from leaving its rejection unhandled.
  creation?.catch(() => undefined)
  const config = identity === null ? null : await configStep(run)
  let storage: StorageSection | null = null
  if (identity !== null && config !== null) {
    const owners = ownersStep(run, config)
    const results = await Promise.all([
      storageStep(run, identity, config, owners),
      owners,
      modulesStep(run, config),
      handlersStep(run, identity, config),
    ])
    storage = results[0]
  } else {
    const reason =
      identity === null
        ? "Not run: the Safe's code could not be read."
        : "Not run: the owners and modules could not be read."
    for (const id of ["storage", "owners", "modules", "handlers"] as const) {
      run.skip(id, reason)
      // The identity step may already have said the chain's proofs are unsupported.
      if (run.sections[id] === undefined) run.setSection(id, { state: "skipped", reason })
    }
    if (identity === null) run.skip("creation", reason)
  }
  if (creation === null) run.setSection("creation", skipped(run.steps.get("creation")?.note ?? ""))
  else await creation

  if (identity !== null && config !== null) {
    const now: ConfigNow = {
      config,
      handlers: { guard: config.guard, moduleGuard: config.moduleGuard, fallbackHandler: config.fallbackHandler },
    }
    const created = run.sections.creation
    const hasCreation = created?.state === "complete" || created?.state === "partial"
    const creationBlock = hasCreation ? BigInt(created.data.block) : null
    const creationTxHash = hasCreation ? created.data.txHash : null
    const setup = hasCreation ? created.data.setup : null
    const creationData = setup === null ? [] : [setup.data, ...(setup.batch ?? []).map((call) => call.data)]
    const history = await historyStep(run, identity, now, {
      block: creationBlock,
      singleton: hasCreation ? created.data.singleton : null,
    })
    await pendingStep(run, now, history)
    storage = await storageEventsStep(run, storage, history)
    storage = await diagnosisStep(run, storage, now, history, { creationTxHash, creationData })
    rootMismatchFinding(run, storage)
  } else {
    const reason = "Not run: the owners and modules could not be read."
    for (const id of ["history", "pending", "storage-events", "diagnosis"] as const) run.skip(id, reason)
    run.setSection("history", { state: "skipped", reason })
    run.setSection("pending", { state: "skipped", reason })
  }

  const recheck = await run.step("reorg", async (finish) => {
    const result = await run.deps.reader.recheckAnchor(run.safeAnchor ?? anchor)
    if (result === "changed" && restarted) {
      finish("failed", `Block ${anchor.number} was replaced by the chain again during the check.`)
    }
    return result
  })
  if (recheck === "changed" && !restarted) return { kind: "reorg" }

  run.setStep("verdict", "running")
  const reorg = recheck === null ? "not-run" : restarted ? "restarted" : "unchanged"
  const sectionReason = (id: "identity" | "owners" | "modules" | "handlers" | "storage") =>
    run.steps.get(id)?.note ?? "Not run."
  const verificationSection = verification(run, reorg)
  const draft: Omit<Report, "verdict" | "cards"> = {
    schema: REPORT_SCHEMA,
    tool: TOOL,
    createdAt: run.env.now().toISOString(),
    request: run.request,
    chain: run.chain,
    findings: sortFindings(run.findings),
    identity: run.sections.identity ?? skipped(sectionReason("identity")),
    owners: run.sections.owners ?? skipped(sectionReason("owners")),
    modules: run.sections.modules ?? skipped(sectionReason("modules")),
    handlers: run.sections.handlers ?? skipped(sectionReason("handlers")),
    storage: run.sections.storage ?? skipped(sectionReason("storage")),
    creation: run.sections.creation ?? skipped(run.steps.get("creation")?.note ?? "Not run."),
    history: run.sections.history ?? skipped("Not run."),
    pending: run.sections.pending ?? skipped("Not run."),
    diagnosis: run.sections.diagnosis ?? null,
    verification: verificationSection,
    crossChain: null,
    steps: [...run.steps.values()],
    issues: [...run.env.issues.all],
    notChecked: [...NOT_CHECKED, ...verificationNotChecked(verificationSection), ...run.notChecked],
  }
  run.emit({ type: "section", patch: { key: "verification", value: draft.verification } })
  const verdict = decideVerdict(draft)
  run.setStep("verdict", "done", verdict.headline)
  return {
    kind: "report",
    report: { ...draft, verdict, cards: summaryCards(draft), steps: [...run.steps.values()] },
  }
}

// Runs every step over the data interfaces, streaming events as they happen. Returns the report, or null when the run
// stopped (nothing to check, or cancelled); a `stopped` event says why.
export async function runCheck(
  request: CheckRequest,
  deps: CheckDeps,
  emit: (event: CheckEvent) => void,
  env: RunEnv,
): Promise<Report | null> {
  const issues = env.issues ?? new IssueLog()
  const now = env.now ?? (() => new Date())
  let restarted = false
  for (;;) {
    const run = new RunState(request, deps, emit, { registry: env.registry, issues, now })
    if (!restarted) {
      emit({
        type: "started",
        at: now().toISOString(),
        request,
        chain: chainRef(deps.reader.chain),
        steps: [...run.steps.values()],
      })
      issues.listen((issue) => emit({ type: "issue", issue }))
    }
    try {
      const result = await attempt(run, restarted)
      if (result.kind === "report") {
        emit({ type: "finished", report: result.report })
        return result.report
      }
      restarted = true
      emit({
        type: "restarted",
        reason: "The chain replaced the pinned block during the check, so the check starts again.",
      })
    } catch (error) {
      if (!(error instanceof StopRun)) throw error
      emit({ type: "stopped", reason: error.reason, message: error.message, issues: [...issues.all] })
      return null
    }
  }
}
