import { type Address, isAddressEqual } from "viem"
import { finding } from "@/core/findings"
import { displayName, entriesOf, hasFlag, knownAs, named, type Registry } from "@/core/registry"
import type {
  AccountKind,
  Comparison,
  Finding,
  FindingCode,
  HandlerSlot,
  HandlersSection,
  Identification,
  ModuleRow,
  ModulesSection,
  ZodiacDetails,
} from "@/core/report"

export type ModuleFacts = {
  address: Address
  kind: AccountKind
  delegate: Address | null
  identification: Identification | null
  zodiac: ZodiacDetails | null
}

function codeEvidence(address: Address, identification: Identification | null) {
  return identification === null ? [] : [{ kind: "code" as const, address, codeHash: identification.codeHash }]
}

// Known contracts that forward a plain CALL to any target the caller chooses, with no delegatecall guard, so anyone
// can act through them when they are a module. MultiSend (not "CallOnly") reverts unless delegatecalled, so it cannot
// forward as a module.
const PUBLIC_FORWARDERS = ["MultiSendCallOnly"]

function isPublicForwarder(registry: Registry, identification: Identification | null): boolean {
  return PUBLIC_FORWARDERS.some((name) => named(registry, identification, name))
}

function mismatchFinding(section: "modules" | "handlers", address: Address, identification: Identification | null) {
  if (identification?.address !== "listed-code-differs") return null
  return finding("codehash-mismatch", section, {
    subject: address,
    technical: `${address} is listed in the known deployments, but its code hash ${identification.codeHash} is not the listed one`,
    evidence: codeEvidence(address, identification),
  })
}

// A module needs code made to be a module: a known contract of another kind can be a module only by mistake, and
// some (MultiSendCallOnly, for example) let anyone act through it. A Safe used as a module is a normal pattern; its
// own owners decide, as for an owner Safe. A module that could not be read gets no finding here: the verdict says the
// inspection is incomplete.
export function checkModules(
  registry: Registry,
  safe: Address,
  modules: readonly ModuleFacts[],
): { section: ModulesSection; findings: Finding[] } {
  const findings: Finding[] = []
  const rows = modules.map((module): ModuleRow => {
    const flags: FindingCode[] = []
    const add = (item: Finding | null) => {
      if (item === null) return
      flags.push(item.code)
      findings.push(item)
    }
    if (module.kind === "unknown" || module.kind === "safe" || module.kind === "precompile") {
      // Not read, a Safe (its owners decide), or a precompile (it cannot make calls, so it cannot act as a module).
    } else if (module.kind === "eoa" || module.kind === "delegated-eoa") {
      add(
        finding("eoa-module", "modules", {
          subject: module.address,
          technical:
            module.kind === "delegated-eoa"
              ? `${module.address} is an EIP-7702 delegated account (delegate ${module.delegate})`
              : `${module.address} has no contract code`,
        }),
      )
    } else if (isPublicForwarder(registry, module.identification)) {
      add(
        finding("module-public-forwarder", "modules", {
          subject: module.address,
          technical: `${module.address} is ${displayName(module.identification)}, a public call forwarder enabled as a module`,
          evidence: codeEvidence(module.address, module.identification),
        }),
      )
    } else if (!knownAs(registry, module.identification, ["module", "modifier"])) {
      const known = displayName(module.identification)
      add(
        finding("unknown-module", "modules", {
          subject: module.address,
          technical:
            known === null
              ? `Code hash ${module.identification?.codeHash ?? "unknown"} matches no known module`
              : `${module.address} is ${known}, which is not a module`,
          evidence: codeEvidence(module.address, module.identification),
        }),
      )
    }
    add(mismatchFinding("modules", module.address, module.identification))
    if (hasFlag(registry, module.identification, "faulty")) {
      add(
        finding("faulty-version", "modules", {
          subject: module.address,
          technical: `${displayName(module.identification)} is marked faulty by Zodiac`,
        }),
      )
    }
    const owner = module.zodiac?.owner ?? null
    if (owner !== null && !isAddressEqual(owner, safe)) {
      add(
        finding("module-owner-not-safe", "modules", {
          subject: module.address,
          technical: `owner() of ${module.address} returned ${owner}, not the Safe ${safe}`,
          evidence: [{ kind: "call", to: module.address, fn: "owner()", result: owner }],
        }),
      )
    }
    return { ...module, flags }
  })
  return { section: { modules: rows }, findings }
}

// Which Zodiac getters a mastercopy has. Delay 1.1.x and Roles 2.x dropped getGuard; modifiers keep a module list.
export type ZodiacPlan = { guard: boolean; reality: boolean; modules: boolean }

export function zodiacPlan(registry: Registry, identification: Identification | null): ZodiacPlan | null {
  const entry = entriesOf(registry, identification).find((match) => match.ref.origin === "zodiac")
  if (entry === undefined || (entry.kind !== "module" && entry.kind !== "modifier")) return null
  const { name, version } = entry.ref
  const noGuard = (name === "delay" && version.startsWith("1.1.")) || (name === "roles" && version.startsWith("2."))
  return { guard: !noGuard, reality: name.startsWith("reality"), modules: entry.kind === "modifier" }
}

export type ZodiacReads = {
  owner: Address | null
  avatar: Address | null
  target: Address | null
  guard: Address | null
  reality: ZodiacDetails["reality"]
  modules: Address[] | null
  cross: Comparison
}

export function zodiacDetails(plan: ZodiacPlan, reads: ZodiacReads, safe: Address): ZodiacDetails {
  const isSafe = (address: Address | null) => address !== null && isAddressEqual(address, safe)
  return {
    owner: reads.owner,
    avatar: reads.avatar,
    target: reads.target,
    guard: plan.guard ? reads.guard : "absent",
    ownerIsSafe: isSafe(reads.owner),
    avatarIsSafe: isSafe(reads.avatar),
    targetIsSafe: isSafe(reads.target),
    reality: plan.reality ? reads.reality : null,
    modules: plan.modules ? reads.modules : null,
    cross: reads.cross,
  }
}

export type HandlerFacts = {
  address: Address | null
  kind: AccountKind | null
  identification: Identification | null
}

export type HandlersInput = {
  version: string | null
  guard: HandlerFacts
  moduleGuard: HandlerFacts
  fallbackHandler: HandlerFacts
}

const ROLE_TEXT: Record<HandlerSlot["role"], string> = {
  guard: "guard",
  moduleGuard: "module guard",
  fallbackHandler: "fallback handler",
}

// Line for "what this does not check" when the handler keeps per-Safe state in its own storage.
export const EXTENSIBLE_HANDLER_NOTE =
  "The ExtensibleFallbackHandler keeps this Safe's custom methods and signature verifiers in its own storage. The storage root check does not cover them."

export function checkHandlers(
  registry: Registry,
  input: HandlersInput,
): { section: HandlersSection; findings: Finding[]; notChecked: string[] } {
  const findings: Finding[] = []
  const notChecked: string[] = []

  const slot = (role: HandlerSlot["role"], facts: HandlerFacts, applicable: boolean): HandlerSlot => {
    const flags: FindingCode[] = []
    const add = (item: Finding | null) => {
      if (item === null) return
      flags.push(item.code)
      findings.push(item)
    }
    const row: HandlerSlot = {
      role,
      applicable,
      address: facts.address,
      kind: facts.kind,
      identification: facts.identification,
      announced: "unknown",
      flags,
    }
    // A module guard slot below 1.5.0 is storage the Safe never reads; the storage section reports it. Kind "unknown":
    // the account could not be read, and the verdict says the inspection is incomplete.
    if (facts.address === null || !applicable || facts.kind === null || facts.kind === "unknown") return row

    const unknownCode = {
      guard: "unknown-guard",
      moduleGuard: "unknown-module-guard",
      fallbackHandler: "unknown-fallback-handler",
    } as const satisfies Record<HandlerSlot["role"], FindingCode>
    const kinds = role === "fallbackHandler" ? (["fallback-handler"] as const) : (["guard"] as const)
    if (!knownAs(registry, facts.identification, kinds)) {
      const known = displayName(facts.identification)
      add(
        finding(unknownCode[role], "handlers", {
          subject: facts.address,
          technical:
            facts.identification === null
              ? `The ${ROLE_TEXT[role]} ${facts.address} ${facts.kind === "delegated-eoa" ? "is an EIP-7702 delegated account" : "has no contract code"}`
              : known === null
                ? `Code hash ${facts.identification.codeHash} matches no known ${ROLE_TEXT[role]}`
                : `${facts.address} is ${known}, which is not a ${ROLE_TEXT[role]}`,
          evidence: codeEvidence(facts.address, facts.identification),
        }),
      )
    }
    add(mismatchFinding("handlers", facts.address, facts.identification))
    if (
      role === "fallbackHandler" &&
      (hasFlag(registry, facts.identification, "keeps-safe-state") ||
        named(registry, facts.identification, "ExtensibleFallbackHandler"))
    ) {
      add(
        finding("handler-keeps-own-state", "handlers", {
          subject: facts.address,
          technical: `${displayName(facts.identification)} stores per-Safe settings in its own storage`,
        }),
      )
      notChecked.push(EXTENSIBLE_HANDLER_NOTE)
    }
    return row
  }

  return {
    section: {
      guard: slot("guard", input.guard, true),
      moduleGuard: slot("moduleGuard", input.moduleGuard, input.version === "1.5.0"),
      fallbackHandler: slot("fallbackHandler", input.fallbackHandler, true),
    },
    findings,
    notChecked,
  }
}
