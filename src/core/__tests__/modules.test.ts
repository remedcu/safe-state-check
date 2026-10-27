import type { Address, Hex } from "viem"
import { describe, expect, it } from "vitest"
import { ADDRESS, HASH, REGISTRY } from "@/core/__tests__/fixtures/registry"
import {
  checkHandlers,
  checkModules,
  EXTENSIBLE_HANDLER_NOTE,
  type HandlerFacts,
  type HandlersInput,
  type ModuleFacts,
  zodiacDetails,
  zodiacPlan,
  type ZodiacReads,
} from "@/core/modules"
import { identify } from "@/core/registry"

const SAFE = "0xAd219b3c26fe42BF5FC66F67490745a4fa5dff59"
const OTHER = "0x00000000000000000000000000000000000fa11B"
const UNKNOWN_HASH = "0x1111111111111111111111111111111111111111111111111111111111111111"

function known(address: Address, codeHash: Hex, chainId = 1) {
  return identify(REGISTRY, chainId, { address, codeHash })
}

function module(overrides: Partial<ModuleFacts>): ModuleFacts {
  return {
    address: OTHER,
    kind: "contract",
    delegate: null,
    identification: known(ADDRESS.safe4337030, HASH.safe4337030),
    zodiac: null,
    ...overrides,
  }
}

const READS: ZodiacReads = {
  owner: SAFE,
  avatar: SAFE,
  target: SAFE,
  guard: null,
  reality: null,
  modules: null,
  cross: "match",
}

const codes = (modules: ModuleFacts[]) => checkModules(REGISTRY, SAFE, modules).findings.map((f) => f.code)

describe("checkModules", () => {
  it("accepts known and reviewed modules", () => {
    expect(codes([module({}), module({ identification: known(ADDRESS.vetoModule, HASH.vetoModule) })])).toEqual([])
  })

  it("flags a module that is a plain or delegated account", () => {
    const eoa = module({ kind: "eoa", identification: null })
    const delegated = module({ kind: "delegated-eoa", delegate: OTHER, identification: null })

    expect(codes([eoa, delegated])).toEqual(["eoa-module", "eoa-module"])
    expect(checkModules(REGISTRY, SAFE, [delegated]).findings[0].technical).toContain("EIP-7702")
  })

  it("flags MultiSendCallOnly enabled as a module (anyone can act through it)", () => {
    const forwarder = module({ identification: known(ADDRESS.multiSendCallOnly141, HASH.multiSendCallOnly141) })
    const result = checkModules(REGISTRY, SAFE, [forwarder])

    expect(result.findings.map((f) => f.code)).toEqual(["module-public-forwarder"])
    expect(result.section.modules[0].flags).toEqual(["module-public-forwarder"])
    // Plain MultiSend reverts unless delegatecalled, so it is only "not a module", not a forwarder.
    expect(codes([module({ identification: known(ADDRESS.multiSend141, HASH.multiSend141) })])).toEqual([
      "unknown-module",
    ])
  })

  it("rates a Safe used as a module like an owner Safe, and gives a precompile or an unread module no finding", () => {
    const safe = module({ kind: "safe", identification: known(OTHER, HASH.proxy141) })
    const precompile = module({
      address: "0x0000000000000000000000000000000000000001",
      kind: "precompile",
      identification: null,
    })
    const unread = module({ kind: "unknown", identification: null })

    expect(codes([safe])).toEqual([])
    expect(codes([precompile])).toEqual([])
    expect(codes([unread])).toEqual([])
  })

  it("flags unknown code, and known code that is not a module", () => {
    const unknown = module({ identification: known(OTHER, UNKNOWN_HASH) })
    // A library (SignMessageLib) is known, but it is not a module and is not a public forwarder.
    const notModule = module({ identification: known(ADDRESS.signMessageLib141, HASH.signMessageLib141) })

    expect(codes([unknown, notModule])).toEqual(["unknown-module", "unknown-module"])
    expect(checkModules(REGISTRY, SAFE, [notModule]).findings[0].technical).toContain("which is not a module")
  })

  it("flags a listed address whose code differs", () => {
    const result = checkModules(REGISTRY, SAFE, [
      module({ address: ADDRESS.safe4337030, identification: known(ADDRESS.safe4337030, UNKNOWN_HASH) }),
    ])

    expect(result.findings.map((f) => f.code)).toEqual(["unknown-module", "codehash-mismatch"])
    expect(result.section.modules[0].flags).toEqual(["unknown-module", "codehash-mismatch"])
  })

  it("flags a faulty Zodiac version", () => {
    expect(codes([module({ identification: known(ADDRESS.delay110, HASH.delay110) })])).toEqual(["faulty-version"])
  })

  it("flags a Zodiac module owned by someone other than the Safe", () => {
    const identification = known(ADDRESS.realityETH, HASH.realityETH)
    const plan = zodiacPlan(REGISTRY, identification)!
    const owned = module({ identification, zodiac: zodiacDetails(plan, { ...READS, owner: OTHER }, SAFE) })
    const ours = module({ identification, zodiac: zodiacDetails(plan, READS, SAFE) })

    expect(codes([owned])).toEqual(["module-owner-not-safe"])
    expect(codes([ours])).toEqual([])
    expect(ours.zodiac).toMatchObject({ ownerIsSafe: true, avatarIsSafe: true, targetIsSafe: true, reality: null })
  })
})

describe("zodiacPlan", () => {
  it("knows which getters each mastercopy has", () => {
    expect(zodiacPlan(REGISTRY, known(ADDRESS.realityERC20, HASH.realityERC20))).toEqual({
      guard: true,
      reality: true,
      modules: false,
    })
    expect(zodiacPlan(REGISTRY, known(ADDRESS.delay111, HASH.delay111))).toEqual({
      guard: false,
      reality: false,
      modules: true,
    })
    expect(zodiacPlan(REGISTRY, known(ADDRESS.safe4337030, HASH.safe4337030))).toBeNull()
    expect(zodiacPlan(REGISTRY, known(ADDRESS.scopeGuard, HASH.scopeGuard))).toBeNull()
  })

  it("shows a guard the mastercopy cannot have as absent", () => {
    const plan = zodiacPlan(REGISTRY, known(ADDRESS.delay111, HASH.delay111))!

    expect(zodiacDetails(plan, { ...READS, modules: [OTHER] }, SAFE)).toMatchObject({
      guard: "absent",
      modules: [OTHER],
    })
  })
})

const NONE: HandlerFacts = { address: null, kind: null, identification: null }

function handlers(overrides: Partial<HandlersInput>): HandlersInput {
  return { version: "1.5.0", guard: NONE, moduleGuard: NONE, fallbackHandler: NONE, ...overrides }
}

function contract(address: Address, codeHash: Hex): HandlerFacts {
  return { address, kind: "contract", identification: known(address, codeHash) }
}

describe("checkHandlers", () => {
  const codesOf = (input: HandlersInput) => checkHandlers(REGISTRY, input).findings.map((f) => f.code)

  it("accepts no handlers and known ones", () => {
    expect(codesOf(handlers({}))).toEqual([])
    expect(codesOf(handlers({ fallbackHandler: contract(ADDRESS.compat150, HASH.compat150) }))).toEqual([])
    // Safe4337Module is both a module and a fallback handler.
    expect(codesOf(handlers({ fallbackHandler: contract(ADDRESS.safe4337030, HASH.safe4337030) }))).toEqual([])
    expect(codesOf(handlers({ guard: contract(ADDRESS.scopeGuard, HASH.scopeGuard) }))).toEqual([])
  })

  it("flags unknown handlers, guards and module guards", () => {
    const unknown = contract(OTHER, UNKNOWN_HASH)

    expect(codesOf(handlers({ fallbackHandler: unknown }))).toEqual(["unknown-fallback-handler"])
    expect(codesOf(handlers({ guard: unknown }))).toEqual(["unknown-guard"])
    expect(codesOf(handlers({ moduleGuard: unknown }))).toEqual(["unknown-module-guard"])
    // Known code in the wrong role.
    expect(codesOf(handlers({ guard: contract(ADDRESS.compat150, HASH.compat150) }))).toEqual(["unknown-guard"])
    expect(codesOf(handlers({ fallbackHandler: { address: OTHER, kind: "eoa", identification: null } }))).toEqual([
      "unknown-fallback-handler",
    ])
  })

  it("leaves a module guard below 1.5.0 to the storage section", () => {
    const result = checkHandlers(REGISTRY, handlers({ version: "1.4.1", moduleGuard: contract(OTHER, UNKNOWN_HASH) }))

    expect(result.findings).toEqual([])
    expect(result.section.moduleGuard).toMatchObject({ applicable: false, address: OTHER })
  })

  it("does not judge an account it could not read", () => {
    expect(codesOf(handlers({ fallbackHandler: { address: OTHER, kind: null, identification: null } }))).toEqual([])
  })

  it("names the ExtensibleFallbackHandler's own state", () => {
    const result = checkHandlers(
      REGISTRY,
      handlers({ fallbackHandler: contract(ADDRESS.extensible150, HASH.extensible150) }),
    )

    expect(result.findings.map((f) => f.code)).toEqual(["handler-keeps-own-state"])
    expect(result.notChecked).toEqual([EXTENSIBLE_HANDLER_NOTE])
  })

  it("flags a listed address whose code differs", () => {
    expect(codesOf(handlers({ fallbackHandler: contract(ADDRESS.compat150, UNKNOWN_HASH) }))).toEqual([
      "unknown-fallback-handler",
      "codehash-mismatch",
    ])
  })
})
