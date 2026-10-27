import { buildRegistry, type Registry } from "@/core/registry"
import type { CheckEvent, CheckRequest, Report, Verdict } from "@/core/report"
import { reviewedContracts } from "@/data/reviewed"
import { openSession } from "@/data/session"
import type { KnownContractsFile, OpenSession, ReviewedContract, Settings } from "@/data/types"
import { runCheck } from "@/check/run"
import { IssueLog } from "@/check/state"

export type StartEnv = {
  openSession: OpenSession
  // The registry index, built once per page session.
  registry: () => Promise<Registry>
  now?: () => Date
  // Injected in tests; the CLI uses Node's global fetch.
  fetch?: typeof fetch
}

// Builds the registry index on first use and keeps it.
export function registryLoader(
  load: () => Promise<{ known: Pick<KnownContractsFile, "contracts">; reviewed: readonly ReviewedContract[] }>,
): () => Promise<Registry> {
  let registry: Promise<Registry> | null = null
  return () => {
    registry ??= load().then(({ known, reviewed }) => buildRegistry(known, reviewed))
    return registry
  }
}

// Opens the session for the chain, then runs the check. Returns null when the run stopped; a `stopped` event says why.
export async function startWith(
  env: StartEnv,
  request: CheckRequest,
  settings: Settings,
  emit: (event: CheckEvent) => void,
  signal?: AbortSignal,
): Promise<Report | null> {
  const issues = new IssueLog()
  const session = await env.openSession(request.chainId, settings, {
    signal,
    onIssue: (issue) => issues.add(issue),
    fetch: env.fetch,
  })
  if (signal?.aborted) {
    emit({ type: "stopped", reason: "cancelled", message: "The check was cancelled.", issues: [...issues.all] })
    return null
  }
  if (!session.ok) {
    for (const issue of session.issues) issues.add(issue)
    emit({ type: "stopped", reason: session.reason, message: session.message, issues: [...issues.all] })
    return null
  }
  return runCheck(request, session.deps, emit, { registry: await env.registry(), issues, now: env.now })
}

// The generated registry and the reviewed list, loaded on the first check (a lazy chunk in the web app).
export const defaultRegistry = registryLoader(async () => {
  // Only signed-off entries of the reviewed list count.
  const [known, reviewed] = await Promise.all([import("@/data/generated/known-contracts.json"), reviewedContracts()])
  return { known: known.default as unknown as KnownContractsFile, reviewed }
})

// The UI's entry point: opens the session for the request's chain, then runs the check. The CLI calls startWith.
export function startCheck(
  request: CheckRequest,
  settings: Settings,
  emit: (event: CheckEvent) => void,
  signal?: AbortSignal,
): Promise<Report | null> {
  return startWith({ openSession, registry: defaultRegistry }, request, settings, emit, signal)
}

// The CLI's exit code. 0 only for a green verdict with no Critical or High finding, so a script that trusts 0 never
// passes a Safe with an EOA module.
export function exitCode(verdict: Verdict): number {
  if (verdict.kind === "unverified") return 2
  if (verdict.kind === "unexplained" || verdict.counts.critical > 0 || verdict.counts.high > 0) return 1
  return 0
}
