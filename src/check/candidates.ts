import { type Address, getAddress, type Hex, isAddress, isHex, size, toHex } from "viem"
import { rootPass } from "@/core/accounting"
import { type DiagnosisContext, diagnose, slotIndex, type UnknownSlot } from "@/core/diagnosis"
import { eventAddresses, historyReadRange } from "@/core/history"
import type { Registry } from "@/core/registry"
import type { CheckEvent, DiagnosisSection, Finding, Report, ReportIssue, StorageSection } from "@/core/report"
import { decideVerdict, summaryCards } from "@/core/verdict"
import { ioErrorOf } from "@/data/errors"
import { openSession as realOpenSession } from "@/data/session"
import type { OpenSession, Settings } from "@/data/types"
import { defaultRegistry } from "@/check/start"
import { IssueLog, issueLine, RunState, StopRun } from "@/check/state"

// Splits the user's text into addresses and 32-byte hashes; anything else is ignored.
export function parseCandidates(candidates: readonly string[]): { addresses: Address[]; hashes: Hex[] } {
  const addresses: Address[] = []
  const hashes: Hex[] = []
  for (const raw of candidates) {
    const text = raw.trim()
    if (isAddress(text, { strict: false })) addresses.push(getAddress(text))
    else if (isHex(text) && size(text) === 32) hashes.push(text.toLowerCase() as Hex)
  }
  return { addresses, hashes }
}

export type CandidatesEnv = { openSession: OpenSession; registry: () => Promise<Registry>; now?: () => Date }

// Rows the configuration and the events explain; the rest were found by diagnosis or by earlier candidates.
const KNOWN_SOURCES = new Set(["config", "derived", "event"])

const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? "" : "es"}`

function slotKeysOf(finding: Finding): string[] {
  return [
    finding.subject ?? "",
    ...finding.evidence.flatMap((evidence) => (evidence.kind === "slot" ? [evidence.key] : [])),
  ].map((key) => key.toLowerCase())
}

function isRootFinding(finding: Finding): boolean {
  return finding.code === "unexplained-storage" && finding.section === "storage" && finding.subject === null
}

// The report with only the candidates sub-step changed, for when the candidates could not be tested.
function withCandidateStep(
  report: Report,
  status: DiagnosisSection["steps"][number]["status"],
  detail: string,
  issues: readonly ReportIssue[] = [],
): Report {
  const diagnosis: DiagnosisSection = {
    steps: [
      ...(report.diagnosis?.steps.filter((step) => step.id !== "candidates") ?? []),
      { id: "candidates", status, detail, missing: [] },
    ],
    unexplained: report.diagnosis?.unexplained ?? [],
    candidatesTried: report.diagnosis?.candidatesTried ?? [],
  }
  return { ...report, diagnosis, issues: [...report.issues, ...issues] }
}

// Tests user-supplied addresses and hashes against the Safe at the report's block: proves every known row and the
// owner, module, approvedHash and signedMessage slots of the candidates in one read, rebuilds the root, classifies the
// slots diagnosis found plus the candidates' slots again, and sends an updated report. Cancelling `signal` stops the
// reads and returns the report unchanged.
export async function testCandidatesWith(
  env: CandidatesEnv,
  report: Report,
  candidates: readonly string[],
  settings: Settings,
  emit: (event: CheckEvent) => void,
  signal?: AbortSignal,
): Promise<Report> {
  const finish = (updated: Report) => {
    emit({ type: "finished", report: updated })
    return updated
  }
  if (report.storage.state !== "complete" || report.storage.data.support !== "supported") {
    return finish(withCandidateStep(report, "unavailable", "The storage root check did not run for this Safe."))
  }
  const storage = report.storage.data
  const { addresses, hashes } = parseCandidates(candidates)
  const session = await env.openSession(report.request.chainId, settings, { signal })
  if (signal?.aborted) return report
  if (!session.ok) return finish(withCandidateStep(report, "failed", session.message, session.issues))

  const issues = new IssueLog()
  const run = new RunState(report.request, session.deps, emit, {
    registry: await env.registry(),
    issues,
    now: env.now ?? (() => new Date()),
  })
  const safe = report.request.address

  try {
    // A new session must pin the report's block, and the block must still be the same one.
    const anchor = await session.deps.reader.anchor({ block: BigInt(report.verification.anchor.number) })
    if (anchor.hash.toLowerCase() !== report.verification.anchor.hash.toLowerCase()) {
      return finish(
        withCandidateStep(
          report,
          "failed",
          `Block ${report.verification.anchor.number} changed since the check ran. Run the check again, then test the candidates.`,
        ),
      )
    }
    run.anchor = anchor

    const owners =
      report.owners.state === "complete" || report.owners.state === "partial"
        ? report.owners.data.owners.map((owner) => owner.address)
        : []
    const modules =
      report.modules.state === "complete" || report.modules.state === "partial"
        ? report.modules.data.modules.map((module) => module.address)
        : []
    const eventAddressList =
      report.history.state === "complete" || report.history.state === "partial"
        ? eventAddresses(report.history.data)
        : []
    // The ApproveHash and SignMsg events of the check, as the pending section lists them. The report does not say
    // whether a second RPC confirmed them, so a slot only they explain leaves the result unverified.
    const pending =
      report.pending.state === "complete" || report.pending.state === "partial" ? report.pending.data : null
    const approvals = (pending?.approvedHashes ?? []).map(({ owner, hash }) => ({ owner, hash, confirmed: false }))
    const messages = (pending?.signedMessages ?? []).map(({ hash }) => ({ hash, confirmed: false }))
    const allAddresses = [
      ...new Set<Address>([
        ...owners,
        ...modules,
        ...eventAddressList,
        ...approvals.map((approval) => approval.owner),
        ...addresses,
      ]),
    ]
    const allHashes = [
      ...new Set<Hex>([
        ...approvals.map((approval) => approval.hash.toLowerCase() as Hex),
        ...messages.map((message) => message.hash.toLowerCase() as Hex),
        ...hashes,
      ]),
    ]

    // Only a slot nothing explained can change class; a shadow entry or an approval without its event stays as found.
    const base = storage.slots.filter((row) => KNOWN_SOURCES.has(row.source) || row.status !== "unexplained")
    const baseKeys = new Set(base.map((row) => row.key.toLowerCase()))
    const rediscovered = storage.slots.filter((row) => !baseKeys.has(row.key.toLowerCase())).map((row) => row.key)
    const candidateKeys = [...slotIndex(allAddresses, allHashes).keys()].filter((key) => !baseKeys.has(key))
    const unknownKeys = [...new Set<Hex>([...rediscovered.map((key) => key.toLowerCase() as Hex), ...candidateKeys])]

    const read = await run.prove(safe, [...base.map((row) => row.key), ...unknownKeys])
    if (read.account === null) return finish(withCandidateStep(report, "failed", "The Safe has no account now."))
    const value = (key: Hex) => read.values.get(key.toLowerCase() as Hex) ?? 0n
    const known = base
      .filter((row) => value(row.key) !== 0n)
      .map((row) => ({ ...row, value: toHex(value(row.key), { size: 32 }) }))
    const unknown: UnknownSlot[] = unknownKeys.map((key) => ({ key, value: value(key) }))

    const ctx: DiagnosisContext = {
      owners,
      modules,
      addresses: allAddresses,
      hashes: allHashes,
      source: "candidate",
      approvals,
      messages,
      historyRange: historyReadRange(
        report.history,
        report.creation.state === "complete" || report.creation.state === "partial"
          ? BigInt(report.creation.data.block)
          : null,
        BigInt(report.verification.anchor.number),
      ),
      // The report keeps only the latest executions, so an older execution may be missed: the Medium stays.
      executed: new Set(
        report.history.state === "complete" || report.history.state === "partial"
          ? report.history.data.executions.recent.flatMap((event) =>
              event.name === "ExecutionSuccess" && event.args.txHash ? [event.args.txHash.toLowerCase()] : [],
            )
          : [],
      ),
    }
    const classified = diagnose(unknown, ctx)
    const pass = await rootPass("candidates", [...known, ...classified.rows], read.account.storageHash)
    const slots = [...known, ...classified.rows]
    const unconfirmed = new Set(classified.unconfirmed.map((key) => key.toLowerCase()))
    const gaps = classified.rows
      .filter((row) => unconfirmed.has(row.key.toLowerCase()))
      .map(
        (row) => `The event behind ${row.technical} was not confirmed by a second RPC, so this slot is not verified.`,
      )

    // What diagnosis said about the slots classified again, and the root finding once the root matches, give way.
    const reclassified = new Set(unknownKeys.map((key) => key.toLowerCase()))
    const kept = report.findings.filter((finding) => {
      if (pass.match && isRootFinding(finding)) return false
      if (finding.section !== "diagnosis") return true
      return !slotKeysOf(finding).some((key) => reclassified.has(key))
    })

    const found = classified.rows.filter((row) => row.status !== "unexplained")
    const diagnosis: DiagnosisSection = {
      steps: [
        ...(report.diagnosis?.steps.filter((step) => step.id !== "candidates") ?? []),
        {
          id: "candidates",
          status: pass.match ? "explained" : found.length > 0 ? "partial" : "nothing-found",
          detail: `Tested ${plural(addresses.length, "address")} and ${plural(hashes.length, "hash")}. ${pass.match ? "The root matches with them." : "The root still does not match."}`,
          missing: [],
        },
      ],
      unexplained: slots.filter(
        (row) => !KNOWN_SOURCES.has(row.source) && (row.status === "unexplained" || row.status === "suspicious"),
      ),
      candidatesTried: [...new Set([...(report.diagnosis?.candidatesTried ?? []), ...addresses, ...hashes])],
    }
    const data: StorageSection = {
      ...storage,
      // One candidates pass: a second test replaces the first.
      passes: [...storage.passes.filter((earlier) => earlier.by !== "candidates"), pass],
      matchedBy: pass.match ? "candidates" : storage.matchedBy === "candidates" ? null : storage.matchedBy,
      slots,
    }
    const draft: Report = {
      ...report,
      findings: [...kept, ...classified.findings],
      storage: gaps.length > 0 ? { state: "partial", data, gaps } : { state: "complete", data },
      diagnosis,
      issues: [...report.issues, ...issues.all],
    }
    return finish({ ...draft, verdict: decideVerdict(draft), cards: summaryCards(draft) })
  } catch (error) {
    const io = ioErrorOf(error)
    if (signal?.aborted || io?.kind === "cancelled" || (error instanceof StopRun && error.reason === "cancelled")) {
      return report
    }
    if (io === null) throw error
    return finish(withCandidateStep(report, "failed", issueLine(io.issue), [...issues.all, io.issue]))
  }
}

// Default wiring: the real session and the generated registry.
export function testCandidates(
  report: Report,
  candidates: string[],
  settings: Settings,
  emit: (event: CheckEvent) => void,
  signal?: AbortSignal,
): Promise<Report> {
  return testCandidatesWith(
    { openSession: realOpenSession, registry: defaultRegistry },
    report,
    candidates,
    settings,
    emit,
    signal,
  )
}
