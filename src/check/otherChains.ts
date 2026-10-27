import { type Address, isAddressEqual } from "viem"
import { finding } from "@/core/findings"
import type { Registry } from "@/core/registry"
import type { CrossChainSection, Report } from "@/core/report"
import { decideVerdict, summaryCards } from "@/core/verdict"
import { getChain } from "@/data/chains"
import { detectChains as realDetectChains } from "@/data/detect"
import { ioErrorOf } from "@/data/errors"
import { openSession as realOpenSession } from "@/data/session"
import type { DetectOptions, DetectResult, OpenSession, Settings } from "@/data/types"
import { defaultRegistry } from "@/check/start"
import { IssueLog, issueLine, RunState } from "@/check/state"
import { safeOneLevel } from "@/check/steps/accounts"

export type OtherChainsEnv = {
  openSession: OpenSession
  registry: () => Promise<Registry>
  detectChains: (address: Address, options: DetectOptions) => Promise<DetectResult[]>
  now?: () => Date
}

type Row = CrossChainSection["chains"][number]

// Rows with code first, then the ones that could not be read, then the empty ones.
const STATUS_ORDER: Record<Row["status"], number> = { safe: 0, contract: 1, error: 2, empty: 3 }

const sameOwners = (a: readonly Address[], b: readonly Address[]) =>
  a.length === b.length && a.every((owner) => b.some((other) => isAddressEqual(owner, other)))

// On demand: asks every chain with a default RPC whether the address has code, and for each chain where
// it is a Safe reads its owners and threshold at that chain's latest block and compares them with this report.
export async function checkOtherChainsWith(
  env: OtherChainsEnv,
  report: Report,
  settings: Settings,
  signal?: AbortSignal,
): Promise<Report> {
  const safe = report.request.address
  const here = report.owners.state === "complete" || report.owners.state === "partial" ? report.owners.data : null
  const detected = (await env.detectChains(safe, { scope: "all", signal })).filter(
    (result) => result.chainId !== report.request.chainId,
  )
  const registry = await env.registry()
  const gaps: string[] = []

  const rows = await Promise.all(
    detected.map(async (result): Promise<Row> => {
      const row: Row = {
        chainId: result.chainId,
        name: getChain(result.chainId)?.name ?? `Chain ${result.chainId}`,
        status: result.status,
        ownersMatch: null,
        thresholdMatch: null,
        note: result.issue === null ? null : issueLine(result.issue),
      }
      if (result.status === "error") gaps.push(`${row.name} could not be asked.`)
      if (result.status !== "safe") return row

      const unread = (note: string) => {
        gaps.push(`The owners on ${row.name} could not be read.`)
        return { ...row, note }
      }
      const session = await env.openSession(result.chainId, settings, { signal })
      if (!session.ok) return unread(session.message)
      const run = new RunState({ address: safe, chainId: result.chainId, block: null }, session.deps, () => {}, {
        registry,
        issues: new IssueLog(),
        now: env.now ?? (() => new Date()),
      })
      try {
        run.anchor = await session.deps.reader.anchor({ block: null })
        const other = await safeOneLevel(run, safe)
        if (other === null) return { ...row, note: "Runs a Safe version this check does not read." }
        if (other.threshold === "0") return { ...row, note: "A Safe that is not set up yet." }
        return {
          ...row,
          // An owner list that could not be read comes back empty; a set-up Safe always has an owner.
          ownersMatch:
            here === null || other.owners.length === 0
              ? null
              : sameOwners(
                  here.owners.map((o) => o.address),
                  other.owners,
                ),
          thresholdMatch: here === null ? null : here.threshold === other.threshold,
          note: `Version ${other.version}, ${other.owners.length} owners, threshold ${other.threshold}.`,
        }
      } catch (error) {
        const io = ioErrorOf(error)
        if (io === null) throw error
        return unread(issueLine(io.issue))
      }
    }),
  )
  // Stopped: the half-read rows are not shown.
  if (signal?.aborted) return report
  rows.sort((a, b) => STATUS_ORDER[a.status] - STATUS_ORDER[b.status])

  const withCode = rows.filter((row) => row.status === "safe" || row.status === "contract")
  const differ = rows.filter((row) => row.ownersMatch === false || row.thresholdMatch === false)
  const findings = report.findings.filter((f) => f.code !== "same-address-other-chains")
  if (withCode.length > 0) {
    findings.push(
      finding("same-address-other-chains", "crossChain", {
        technical: `Code at ${safe} on ${withCode.map((row) => `${row.name} (${row.chainId})`).join(", ")}.${differ.length > 0 ? ` Other owners or threshold on ${differ.map((row) => row.name).join(", ")}.` : ""}`,
      }),
    )
  }
  const draft: Report = {
    ...report,
    findings,
    crossChain:
      gaps.length > 0
        ? { state: "partial", data: { chains: rows }, gaps }
        : { state: "complete", data: { chains: rows } },
  }
  return { ...draft, verdict: decideVerdict(draft), cards: summaryCards(draft) }
}

// Default wiring: the real session, detection and registry.
export function checkOtherChains(report: Report, settings: Settings, signal?: AbortSignal): Promise<Report> {
  return checkOtherChainsWith(
    { openSession: realOpenSession, registry: defaultRegistry, detectChains: realDetectChains },
    report,
    settings,
    signal,
  )
}
