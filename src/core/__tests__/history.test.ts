import { type Address, encodeAbiParameters, type Hex, pad, toHex } from "viem"
import { describe, expect, it } from "vitest"
import { EVENT_TOPICS, SENTINEL } from "@/core/constants"
import {
  announced,
  approveHashEvents,
  checkHistory,
  decodeHistory,
  executedHashes,
  type HistoryInput,
  replayConfig,
  signMsgEvents,
} from "@/core/history"
import type { ConfigState, HandlerSlot, ServiceRef } from "@/core/report"
import type { RawLog } from "@/data/types"

const SAFE: Address = "0xAd219b3c26fe42BF5FC66F67490745a4fa5dff59"
const OWNER_A: Address = "0x000000000000000000000000000000000000000A"
const OWNER_B: Address = "0x000000000000000000000000000000000000000b"
const MODULE: Address = "0x4210382652A5e3C9aF7e1D3c88085818A465449b"
const HANDLER: Address = "0xfd0732Dc9E303f09fCEf3a7388Ad10A83459Ec99"
const GUARD: Address = "0xeF27fcd3965a866b22Fb2d7C689De9AB7e611f1F"
const RPC: ServiceRef = { service: "rpc", host: "eth.drpc.org" }

let block = 0n
function log(topics: Hex[], data: Hex = "0x"): RawLog {
  block += 1n
  return {
    address: SAFE,
    topics,
    data,
    blockNumber: block,
    transactionHash: pad(toHex(block), { size: 32 }),
    logIndex: 0,
  }
}
// 1.3.0 puts the address in data; 1.4.1 and 1.5.0 index it.
const v130 = (name: keyof typeof EVENT_TOPICS, address: Address): RawLog =>
  log([EVENT_TOPICS[name]], pad(address, { size: 32 }))
const v141 = (name: keyof typeof EVENT_TOPICS, address: Address): RawLog =>
  log([EVENT_TOPICS[name], pad(address, { size: 32 })])
const threshold = (n: bigint): RawLog => log([EVENT_TOPICS.ChangedThreshold], pad(toHex(n), { size: 32 }))

function safeSetup(owners: Address[], thresholdValue: bigint, handler: Address): RawLog {
  const data = encodeAbiParameters(
    [{ type: "address[]" }, { type: "uint256" }, { type: "address" }, { type: "address" }],
    [owners, thresholdValue, "0x0000000000000000000000000000000000000000", handler],
  )
  return log([EVENT_TOPICS.SafeSetup, pad(SAFE, { size: 32 })], data)
}

function state(overrides: Partial<ConfigState> = {}): ConfigState {
  return {
    singleton: null,
    owners: [OWNER_A],
    threshold: "1",
    modules: [],
    guard: null,
    moduleGuard: null,
    fallbackHandler: HANDLER,
    ...overrides,
  }
}

function input(logs: RawLog[], overrides: Partial<HistoryInput> = {}): HistoryInput {
  return {
    source: RPC,
    fromBlock: 1n,
    toBlock: 100n,
    coverage: "node-full",
    logs,
    confirmed: () => true,
    current: state(),
    createdBeforeSetup: false,
    creationSingleton: null,
    ...overrides,
  }
}

describe("decodeHistory", () => {
  it("decodes the address from both event shapes", () => {
    const decoded = decodeHistory([v130("AddedOwner", OWNER_A), v141("EnabledModule", MODULE)])

    expect(decoded.map(({ event }) => [event.name, event.args.address])).toEqual([
      ["AddedOwner", OWNER_A],
      ["EnabledModule", MODULE],
    ])
  })

  it("orders events by block then log index and drops unknown topics", () => {
    const a = { ...v141("AddedOwner", OWNER_A), blockNumber: 5n, logIndex: 2 }
    const b = { ...v141("AddedOwner", OWNER_B), blockNumber: 5n, logIndex: 1 }
    const junk = log(["0x1234567890123456789012345678901234567890123456789012345678901234"])

    expect(decodeHistory([a, b, junk]).map(({ event }) => event.args.address)).toEqual([OWNER_B, OWNER_A])
  })
})

describe("replayConfig", () => {
  it("rebuilds owners, modules, threshold and handler, mixing both shapes (an upgraded Safe)", () => {
    const { state: rebuilt, ownersKnown } = replayConfig(
      decodeHistory([
        safeSetup([OWNER_A], 1n, HANDLER),
        v130("AddedOwner", OWNER_B),
        threshold(2n),
        v141("EnabledModule", MODULE),
        v141("ChangedGuard", GUARD),
      ]),
    )

    expect(ownersKnown).toBe(true)
    expect(rebuilt).toEqual({
      singleton: null,
      owners: [OWNER_A, OWNER_B],
      threshold: "2",
      modules: [MODULE],
      guard: GUARD,
      moduleGuard: null,
      fallbackHandler: HANDLER,
    })
  })

  it("ignores unconfirmed events", () => {
    const logs = [safeSetup([OWNER_A], 1n, HANDLER), v141("EnabledModule", MODULE)]
    const decoded = decodeHistory(logs, (l) => l.topics[0] !== EVENT_TOPICS.EnabledModule)

    expect(replayConfig(decoded).state.modules).toEqual([])
  })

  it("does not know the owners without a SafeSetup", () => {
    expect(replayConfig(decodeHistory([v141("EnabledModule", MODULE)])).ownersKnown).toBe(false)
  })
})

describe("checkHistory", () => {
  it("clears a Safe whose every setting has an event", () => {
    const { findings, section } = checkHistory(
      input([safeSetup([OWNER_A], 1n, HANDLER)], { current: state({ fallbackHandler: HANDLER }) }),
    )

    expect(findings).toEqual([])
    expect(section).toMatchObject({ complete: true, rebuilt: { owners: [OWNER_A], fallbackHandler: HANDLER } })
  })

  it("flags a module set with no event as config-without-event on full node history (High)", () => {
    const { findings } = checkHistory(
      input([safeSetup([OWNER_A], 1n, HANDLER)], { current: state({ modules: [MODULE] }) }),
    )

    expect(findings.map((f) => [f.code, f.severity])).toEqual([["config-without-event", "high"]])
    expect(findings[0].subject).toBe(MODULE)
  })

  it("softens the same finding to config-without-event-unconfirmed on indexer history (Medium)", () => {
    const { findings } = checkHistory(
      input([safeSetup([OWNER_A], 1n, HANDLER)], {
        current: state({ modules: [MODULE] }),
        coverage: "indexer",
        source: { service: "blockscout", host: "eth.blockscout.com" },
      }),
    )

    expect(findings.map((f) => [f.code, f.severity])).toEqual([["config-without-event-unconfirmed", "medium"]])
  })

  it("flags a guard, module guard and handler set with no event", () => {
    const { findings } = checkHistory(
      input([safeSetup([OWNER_A], 1n, "0x0000000000000000000000000000000000000000")], {
        current: state({ guard: GUARD, moduleGuard: GUARD, fallbackHandler: HANDLER }),
      }),
    )

    expect(findings.map((f) => f.subject)).toEqual([GUARD, GUARD, HANDLER])
    expect(findings.every((f) => f.code === "config-without-event")).toBe(true)
  })

  it("raises no config finding when the history is partial, only history-incomplete", () => {
    const { findings } = checkHistory(
      input([safeSetup([OWNER_A], 1n, HANDLER)], { current: state({ modules: [MODULE] }), coverage: "partial" }),
    )

    expect(findings.map((f) => f.code)).toEqual(["history-incomplete"])
  })

  it("skips a malformed Safe log and still judges the rest", () => {
    // A delegatecall can emit a ChangedThreshold topic with no data from the Safe's address.
    const malformed = log([EVENT_TOPICS.ChangedThreshold], "0x")
    const { findings, skipped } = checkHistory(
      input([safeSetup([OWNER_A], 1n, HANDLER), malformed], { current: state({ guard: GUARD }) }),
    )

    expect(skipped).toBe(1)
    expect(findings.map((f) => [f.code, f.subject])).toEqual([["config-without-event", GUARD]])
  })

  it("rates a setting explained only by an event no second RPC confirmed as unconfirmed (Medium)", () => {
    const logs = [safeSetup([OWNER_A], 1n, HANDLER), v141("EnabledModule", MODULE)]
    const { findings } = checkHistory(
      input(logs, {
        current: state({ modules: [MODULE] }),
        confirmed: (l) => l.topics[0] !== EVENT_TOPICS.EnabledModule,
      }),
    )

    expect(findings.map((f) => [f.code, f.severity])).toEqual([["config-without-event-unconfirmed", "medium"]])
    expect(findings[0].technical).toContain("not confirmed by a second RPC")
  })

  it("does not call a history complete without SafeSetup, even when every block was read", () => {
    const { findings, section } = checkHistory(input([v141("EnabledModule", MODULE)]))

    expect(section.complete).toBe(false)
    expect(findings.map((f) => f.code)).toEqual(["history-incomplete"])
  })

  it("reports history-incomplete for a Safe created before 1.3.0 (no SafeSetup)", () => {
    const { findings, section } = checkHistory(input([v141("EnabledModule", MODULE)], { createdBeforeSetup: true }))

    expect(findings.map((f) => f.code)).toContain("history-incomplete")
    expect(section.complete).toBe(false)
  })

  it("counts executions and keeps the last 50", () => {
    const logs = [safeSetup([OWNER_A], 1n, HANDLER)]
    // 1.3.0 shape: txHash and payment in data.
    const payment = pad(toHex(0n), { size: 32 }).slice(2)
    for (let i = 0; i < 60; i++) {
      logs.push(log([EVENT_TOPICS.ExecutionSuccess], `${pad(toHex(i), { size: 32 })}${payment}`))
    }
    logs.push(log([EVENT_TOPICS.ExecutionFromModuleFailure, pad(MODULE, { size: 32 })]))
    const { section } = checkHistory(input(logs))

    expect(section.executions.success).toBe(60)
    expect(section.executions.moduleFailure).toBe(1)
    expect(section.executions.recent).toHaveLength(50)
  })

  it("treats the sentinel in the current owner list as explained", () => {
    expect(
      checkHistory(input([safeSetup([SENTINEL, OWNER_A], 1n, HANDLER)], { current: state({ owners: [OWNER_A] }) }))
        .findings,
    ).toEqual([])
  })
})

describe("announced", () => {
  const slot = (address: Address | null): HandlerSlot => ({
    role: "fallbackHandler",
    applicable: true,
    address,
    kind: null,
    identification: null,
    announced: "unknown",
    flags: [],
  })

  it("says whether a confirmed event set the handler, and unknown on an incomplete history", () => {
    const { section } = checkHistory(input([safeSetup([OWNER_A], 1n, HANDLER)]))
    const partial = checkHistory(input([safeSetup([OWNER_A], 1n, HANDLER)], { coverage: "partial" })).section

    expect(announced(section, slot(HANDLER))).toBe("yes")
    expect(announced(section, slot(GUARD))).toBe("no")
    expect(announced(partial, slot(HANDLER))).toBe("unknown")
  })
})

describe("event extractors", () => {
  const HASH: Hex = "0x9b8d6c1a8f5dfcb5d6b5c1f0a9e0c8f6f2a4d3e1b7c9a5f3e2d1c0b9a8f7e6d5"

  it("reads ApproveHash, SignMsg and ExecutionSuccess hashes", () => {
    const approve = log([EVENT_TOPICS.ApproveHash, HASH, pad(OWNER_A, { size: 32 })])
    const sign = log([EVENT_TOPICS.SignMsg, HASH])
    const exec141 = log([EVENT_TOPICS.ExecutionSuccess, HASH], pad(toHex(0n), { size: 32 }))
    const exec130 = log([EVENT_TOPICS.ExecutionSuccess], (HASH + pad(toHex(0n), { size: 32 }).slice(2)) as Hex)

    expect(approveHashEvents([approve])).toEqual([{ owner: OWNER_A, hash: HASH, confirmed: true }])
    expect(signMsgEvents([sign], () => false)).toEqual([{ hash: HASH, confirmed: false }])
    expect([...executedHashes([exec141, exec130])]).toEqual([HASH.toLowerCase()])
  })
})

describe("checkHistory singleton (slot 0)", () => {
  const CREATED: Address = "0x41675C099F32341bf84BFc5382aF534df5C7461a"
  const OTHER_SINGLETON: Address = "0x29fcB43b46531BcA003ddC8FCB67FFE91900C762"
  const setupOnly = () => [safeSetup([OWNER_A], 1n, HANDLER)]

  it("flags slot 0 changed without ChangedMasterCopy (a silent swap between canonical singletons)", () => {
    const { findings, section } = checkHistory(
      input(setupOnly(), { creationSingleton: CREATED, current: state({ singleton: OTHER_SINGLETON }) }),
    )

    expect(findings.map((f) => [f.code, f.subject])).toEqual([["config-without-event", OTHER_SINGLETON]])
    expect(section.differences).toContainEqual({ field: "singleton", current: OTHER_SINGLETON, fromEvents: CREATED })
  })

  it("accepts a singleton changed by ChangedMasterCopy (L2 setup, migration)", () => {
    const logs = [...setupOnly(), v130("ChangedMasterCopy", OTHER_SINGLETON)]
    const { findings, section } = checkHistory(
      input(logs, { creationSingleton: CREATED, current: state({ singleton: OTHER_SINGLETON }) }),
    )

    expect(findings).toEqual([])
    expect(section.rebuilt.singleton).toBe(OTHER_SINGLETON)
  })

  it("accepts the creation's singleton unchanged, and says nothing when the creation is unknown", () => {
    expect(
      checkHistory(input(setupOnly(), { creationSingleton: CREATED, current: state({ singleton: CREATED }) })).findings,
    ).toEqual([])
    expect(
      checkHistory(input(setupOnly(), { creationSingleton: null, current: state({ singleton: OTHER_SINGLETON }) }))
        .findings,
    ).toEqual([])
  })

  it("softens to unconfirmed on indexer history and stays silent on a partial one", () => {
    const changed = { creationSingleton: CREATED, current: state({ singleton: OTHER_SINGLETON }) }

    expect(checkHistory(input(setupOnly(), { ...changed, coverage: "indexer" })).findings.map((f) => f.code)).toEqual([
      "config-without-event-unconfirmed",
    ])
    expect(checkHistory(input(setupOnly(), { ...changed, coverage: "partial" })).findings.map((f) => f.code)).toEqual([
      "history-incomplete",
    ])
  })
})
