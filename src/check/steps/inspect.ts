import type { Address } from "viem"
import { checkHandlers, checkModules, type HandlerFacts, zodiacDetails, zodiacPlan } from "@/core/modules"
import { checkOwners } from "@/core/owners"
import { ioErrorOf } from "@/data/errors"
import { issueLine, type RunState } from "@/check/state"
import { type Inspected, inspectAccount, zodiacReads } from "@/check/steps/accounts"
import type { ConfigOutcome, IdentityOutcome } from "@/check/steps/safe"

// The gap for an account whose read failed: the role, the address and the failed call.
export function uninspectedGap(role: string, address: Address, error: unknown): string {
  const io = ioErrorOf(error)
  return `${role} ${address} could not be inspected. ${io === null ? "" : issueLine(io.issue)}`.trim()
}

// Inspects each address on its own. One that cannot be read keeps its row with kind "unknown", so the counts stay
// right, and adds a gap that names the account and the failed call; the verdict then says it could not verify.
async function inspectAll(
  run: RunState,
  role: string,
  addresses: readonly Address[],
  options: Parameters<typeof inspectAccount>[2],
): Promise<{ inspected: Inspected[]; gaps: string[] }> {
  const gaps: string[] = []
  const inspected = await Promise.all(
    addresses.map(async (address): Promise<Inspected> => {
      try {
        return await inspectAccount(run, address, options)
      } catch (error) {
        run.failed(error)
        gaps.push(uninspectedGap(role, address, error))
        return { address, kind: "unknown", delegate: null, identification: null, safe: null }
      }
    }),
  )
  return { inspected, gaps }
}

function finishWith<T>(
  run: RunState,
  key: "owners" | "modules" | "handlers",
  data: T,
  gaps: string[],
  finish: (status: "degraded", note: string) => void,
) {
  if (gaps.length > 0) {
    run.setSection(key, { state: "partial", data, gaps } as never)
    finish("degraded", gaps.join(" "))
  } else {
    run.setSection(key, { state: "complete", data } as never)
  }
}

export async function ownersStep(run: RunState, { config }: ConfigOutcome): Promise<Inspected[] | null> {
  return run.step("owners", async (finish) => {
    const { inspected, gaps } = await inspectAll(run, "Owner", config.owners, { oneLevel: true, sourcify: true })
    const { section, findings } = checkOwners(inspected, {
      threshold: config.threshold.toString(),
      ownerCount: config.ownerCount.toString(),
    })
    run.addFindings(findings)
    finishWith(run, "owners", section, gaps, finish)
    return inspected
  })
}

export async function modulesStep(run: RunState, { config }: ConfigOutcome): Promise<void> {
  await run.step("modules", async (finish) => {
    // A Safe used as a module is shown one level deep, like an owner Safe.
    const { inspected, gaps } = await inspectAll(run, "Module", config.modules, { oneLevel: true, sourcify: true })
    const facts = await Promise.all(
      inspected.map(async (module) => {
        const plan = zodiacPlan(run.registry, module.identification)
        const zodiac =
          plan === null ? null : zodiacDetails(plan, await zodiacReads(run, module.address, plan), run.safe)
        return { ...module, zodiac }
      }),
    )
    const { section, findings } = checkModules(run.registry, run.safe, facts)
    run.addFindings(findings)
    finishWith(run, "modules", section, gaps, finish)
  })
}

export async function handlersStep(run: RunState, identity: IdentityOutcome, outcome: ConfigOutcome): Promise<void> {
  await run.step("handlers", async (finish) => {
    const gaps: string[] = []
    const facts = async (role: string, address: Address | null): Promise<HandlerFacts> => {
      if (address === null) return { address: null, kind: null, identification: null }
      const { inspected, gaps: failed } = await inspectAll(run, role, [address], { sourcify: true })
      gaps.push(...failed)
      return { address, kind: inspected[0].kind, identification: inspected[0].identification }
    }
    const [guard, moduleGuard, fallbackHandler] = await Promise.all([
      facts("Guard", outcome.guard),
      facts("Module guard", outcome.moduleGuard),
      facts("Fallback handler", outcome.fallbackHandler),
    ])
    const { section, findings, notChecked } = checkHandlers(run.registry, {
      version: identity.result.section.version,
      guard,
      moduleGuard,
      fallbackHandler,
    })
    run.addFindings(findings)
    run.notChecked.push(...notChecked)
    finishWith(run, "handlers", section, gaps, finish)
  })
}
