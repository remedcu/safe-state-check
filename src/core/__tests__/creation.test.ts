import {
  type Address,
  encodeAbiParameters,
  encodeFunctionData,
  encodePacked,
  type Hex,
  size,
  toEventSelector,
  zeroAddress,
} from "viem"
import { describe, expect, it } from "vitest"
import { ADDRESS, HASH, REGISTRY } from "@/core/__tests__/fixtures/registry"
import { FACTORY_ABI, MULTISEND_ABI, SAFE_ABI, SETUP_HELPER_ABI } from "@/core/abis"
import { EVENT_TOPICS } from "@/core/constants"
import {
  checkCreation,
  type CreationCheckInput,
  creationFromLogs,
  decodeFactoryCall,
  decodeMultiSend,
  decodeSetup,
  describeCall,
  findFactoryFrame,
} from "@/core/creation"
import { identify } from "@/core/registry"
import type { BatchCall } from "@/core/report"
import type { CallFrame, RawLog } from "@/data/types"

const SAFE = "0xAd219b3c26fe42BF5FC66F67490745a4fa5dff59"
const OWNER = "0x802cbafa6133c493A7c67f685f97AdA5918d1dF9"
const OTHER = "0x00000000000000000000000000000000000fa11B"
const SAFE_WALLET_RECEIVER = "0x5afe7A11E7000000000000000000000000000000"
const UNKNOWN_HASH = "0x1111111111111111111111111111111111111111111111111111111111111111"

function setupData(overrides: { to?: Address; data?: Hex; payment?: bigint } = {}): Hex {
  return encodeFunctionData({
    abi: SAFE_ABI,
    functionName: "setup",
    args: [
      [OWNER],
      1n,
      overrides.to ?? zeroAddress,
      overrides.data ?? "0x",
      ADDRESS.compat141,
      zeroAddress,
      overrides.payment ?? 0n,
      SAFE_WALLET_RECEIVER,
    ],
  })
}

function multiSend(calls: { operation: 0 | 1; to: Address; data: Hex }[]): Hex {
  const packed = calls.map(({ operation, to, data }) =>
    encodePacked(["uint8", "address", "uint256", "uint256", "bytes"], [operation, to, 0n, BigInt(size(data)), data]),
  )
  return encodeFunctionData({
    abi: MULTISEND_ABI,
    functionName: "multiSend",
    args: [`0x${packed.map((part) => part.slice(2)).join("")}`],
  })
}

describe("decodeFactoryCall", () => {
  it("decodes every factory entry point", () => {
    const initializer = setupData()
    const withNonce = [
      "createProxyWithNonce",
      "createProxyWithNonceL2",
      "createChainSpecificProxyWithNonce",
      "createChainSpecificProxyWithNonceL2",
    ] as const
    for (const functionName of withNonce) {
      const input = encodeFunctionData({ abi: FACTORY_ABI, functionName, args: [ADDRESS.safe141, initializer, 7n] })

      expect(decodeFactoryCall(input)).toEqual({
        method: functionName,
        singleton: ADDRESS.safe141,
        initializer,
        saltNonce: 7n,
        callback: null,
      })
    }
    const legacy = encodeFunctionData({
      abi: FACTORY_ABI,
      functionName: "createProxy",
      args: [ADDRESS.safe130, initializer],
    })
    expect(decodeFactoryCall(legacy)).toMatchObject({ method: "createProxy", saltNonce: null, callback: null })
    const callback = encodeFunctionData({
      abi: FACTORY_ABI,
      functionName: "createProxyWithCallback",
      args: [ADDRESS.safe141, initializer, 1n, OTHER],
    })
    expect(decodeFactoryCall(callback)).toMatchObject({ method: "createProxyWithCallback", callback: OTHER })
  })

  it("returns null for anything else", () => {
    expect(decodeFactoryCall("0x")).toBeNull()
    expect(decodeFactoryCall(setupData())).toBeNull()
  })
})

describe("decodeSetup", () => {
  it("decodes the setup call, selector 0xb63e800d in 1.3.0 to 1.5.0", () => {
    const data = setupData({ payment: 5n })

    expect(data.slice(0, 10)).toBe("0xb63e800d")
    expect(decodeSetup(data)).toEqual({
      owners: [OWNER],
      threshold: 1n,
      to: zeroAddress,
      data: "0x",
      fallbackHandler: ADDRESS.compat141,
      paymentToken: zeroAddress,
      payment: 5n,
      paymentReceiver: SAFE_WALLET_RECEIVER,
    })
    expect(decodeSetup("0x1234")).toBeNull()
  })
})

describe("decodeMultiSend", () => {
  it("splits the packed transactions", () => {
    const enable = encodeFunctionData({
      abi: SETUP_HELPER_ABI,
      functionName: "enableModules",
      args: [[ADDRESS.safe4337030]],
    })
    const data = multiSend([
      { operation: 1, to: ADDRESS.moduleSetup030, data: enable },
      { operation: 0, to: OTHER, data: "0x" },
    ])

    expect(decodeMultiSend(data)).toEqual([
      { operation: "delegatecall", to: ADDRESS.moduleSetup030, value: 0n, data: enable },
      { operation: "call", to: OTHER, value: 0n, data: "0x" },
    ])
    expect(describeCall(enable)).toBe("enableModules")
    expect(describeCall("0xdeadbeef00")).toBe("0xdeadbeef")
  })

  it("rejects a truncated or malformed batch", () => {
    const good = multiSend([{ operation: 0, to: OTHER, data: "0x1234" }])
    const truncated = encodeFunctionData({
      abi: MULTISEND_ABI,
      functionName: "multiSend",
      args: [`0x00${"11".repeat(40)}`],
    })
    const badOperation = encodeFunctionData({
      abi: MULTISEND_ABI,
      functionName: "multiSend",
      args: [encodePacked(["uint8", "address", "uint256", "uint256"], [2, OTHER, 0n, 0n])],
    })

    expect(decodeMultiSend(good)).toHaveLength(1)
    expect(decodeMultiSend(truncated)).toBeNull()
    expect(decodeMultiSend(badOperation)).toBeNull()
    expect(decodeMultiSend("0x")).toBeNull()
  })
})

describe("findFactoryFrame", () => {
  const create: CallFrame = { type: "CREATE2", from: ADDRESS.factory141, to: SAFE, input: "0x", value: 0n, calls: [] }
  const factoryCall: CallFrame = {
    type: "CALL",
    from: OTHER,
    to: ADDRESS.factory141,
    input: "0x1234",
    value: 0n,
    calls: [create],
  }

  it("finds the call whose child created the Safe, at any depth", () => {
    const root: CallFrame = { type: "CALL", from: OWNER, to: OTHER, input: "0x", value: 0n, calls: [factoryCall] }

    expect(findFactoryFrame(root, SAFE)).toBe(factoryCall)
    expect(findFactoryFrame(factoryCall, SAFE)).toBe(factoryCall)
    expect(findFactoryFrame(root, OTHER)).toBeNull()
  })
})

function log(address: Address, topics: Hex[], data: Hex): RawLog {
  return { address, topics, data, blockNumber: 1n, transactionHash: "0x01", logIndex: 0 }
}

const pad = (address: Address) => encodeAbiParameters([{ type: "address" }], [address])

describe("creationFromLogs", () => {
  it("reads the L2 factory event and the SafeSetup event", () => {
    const initializer = setupData()
    const l2 = log(
      ADDRESS.factory150,
      [EVENT_TOPICS.ProxyCreationL2, pad(SAFE)],
      encodeAbiParameters(
        [{ type: "address" }, { type: "bytes" }, { type: "uint256" }],
        [ADDRESS.safeL2150, initializer, 9n],
      ),
    )
    const setup = log(
      SAFE,
      [EVENT_TOPICS.SafeSetup, pad(ADDRESS.factory150)],
      encodeAbiParameters(
        [{ type: "address[]" }, { type: "uint256" }, { type: "address" }, { type: "address" }],
        [[OWNER], 1n, ADDRESS.multiSend141, ADDRESS.compat150],
      ),
    )

    expect(creationFromLogs([l2, setup], SAFE)).toEqual({
      factory: ADDRESS.factory150,
      method: "createProxyWithNonceL2",
      singleton: ADDRESS.safeL2150,
      initializer,
      saltNonce: 9n,
      setupEvent: { owners: [OWNER], threshold: 1n, to: ADDRESS.multiSend141, fallbackHandler: ADDRESS.compat150 },
    })
  })

  it("names the chain-specific L2 method from its event", () => {
    const event = log(
      ADDRESS.factory150,
      [EVENT_TOPICS.ChainSpecificProxyCreationL2, pad(SAFE)],
      encodeAbiParameters(
        [{ type: "address" }, { type: "bytes" }, { type: "uint256" }, { type: "uint256" }],
        [ADDRESS.safeL2150, setupData(), 9n, 1n],
      ),
    )

    expect(creationFromLogs([event], SAFE)).toMatchObject({
      factory: ADDRESS.factory150,
      method: "createChainSpecificProxyWithNonceL2",
    })
  })

  it("reads ProxyCreation with and without the indexed proxy (1.3.0 and 1.4.1)", () => {
    const v130 = log(ADDRESS.factory130, [EVENT_TOPICS.ProxyCreation], `${pad(SAFE)}${pad(ADDRESS.safe130).slice(2)}`)
    const v141 = log(ADDRESS.factory141, [EVENT_TOPICS.ProxyCreation, pad(SAFE)], pad(ADDRESS.safe141))

    expect(creationFromLogs([v130], SAFE)).toMatchObject({ factory: ADDRESS.factory130, singleton: ADDRESS.safe130 })
    expect(creationFromLogs([v141], SAFE)).toMatchObject({ factory: ADDRESS.factory141, singleton: ADDRESS.safe141 })
    expect(creationFromLogs([v141], OTHER)).toMatchObject({ factory: null })
  })

  it("ignores logs with a known topic but another shape", () => {
    const odd = log(OTHER, [toEventSelector("ProxyCreationL2(address,address,bytes,uint256)")], "0x")

    expect(creationFromLogs([odd], SAFE).factory).toBeNull()
  })
})

function id(address: Address, codeHash: Hex) {
  return identify(REGISTRY, 1, { address, codeHash })
}

function batchCall(operation: "call" | "delegatecall", to: Address, codeHash: Hex | null): BatchCall {
  return {
    operation,
    to,
    value: "0",
    data: "0x",
    fn: null,
    identification: codeHash === null ? null : id(to, codeHash),
  }
}

const CANONICAL: CreationCheckInput = {
  factory: { address: ADDRESS.factory141, identification: id(ADDRESS.factory141, HASH.factory141) },
  callback: null,
  setup: {
    to: zeroAddress,
    toIdentification: null,
    batch: null,
    dataKnown: true,
    payment: 0n,
    paymentToken: zeroAddress,
    paymentReceiver: SAFE_WALLET_RECEIVER,
  },
}

function withSetup(setup: Partial<NonNullable<CreationCheckInput["setup"]>>): CreationCheckInput {
  return { ...CANONICAL, setup: { ...CANONICAL.setup!, ...setup } }
}

const codes = (input: CreationCheckInput) => checkCreation(REGISTRY, input).findings.map((f) => f.code)

describe("checkCreation", () => {
  it("accepts a canonical factory, no setup delegatecall and a Safe{Wallet} receiver without payment", () => {
    expect(checkCreation(REGISTRY, CANONICAL)).toEqual({ findings: [], gaps: [] })
  })

  it("accepts known setup helpers", () => {
    expect(
      codes(withSetup({ to: ADDRESS.toL2Setup141, toIdentification: id(ADDRESS.toL2Setup141, HASH.toL2Setup141) })),
    ).toEqual([])
    expect(
      codes(
        withSetup({ to: ADDRESS.moduleSetup030, toIdentification: id(ADDRESS.moduleSetup030, HASH.moduleSetup030) }),
      ),
    ).toEqual([])
  })

  it("flags a setup delegatecall to unknown code or to an address without code", () => {
    expect(codes(withSetup({ to: OTHER, toIdentification: id(OTHER, UNKNOWN_HASH) }))).toEqual([
      "setup-delegatecall-unknown",
    ])
    expect(codes(withSetup({ to: OTHER, toIdentification: null }))).toEqual(["setup-delegatecall-unknown"])
    // Known code that is not a setup helper.
    expect(
      codes(withSetup({ to: ADDRESS.compat141, toIdentification: id(ADDRESS.compat141, HASH.compat141) })),
    ).toEqual(["setup-delegatecall-unknown"])
  })

  it("checks every delegatecall inside a setup MultiSend", () => {
    const multiSendSetup = { to: ADDRESS.multiSend141, toIdentification: id(ADDRESS.multiSend141, HASH.multiSend141) }
    const fine = withSetup({
      ...multiSendSetup,
      batch: [
        batchCall("delegatecall", ADDRESS.moduleSetup030, HASH.moduleSetup030),
        batchCall("delegatecall", ADDRESS.sharedSigner, HASH.sharedSigner),
        // A plain call cannot write the Safe's storage.
        batchCall("call", OTHER, UNKNOWN_HASH),
      ],
    })
    const bad = withSetup({ ...multiSendSetup, batch: [batchCall("delegatecall", OTHER, UNKNOWN_HASH)] })
    const nested = withSetup({
      ...multiSendSetup,
      batch: [batchCall("delegatecall", ADDRESS.multiSend141, HASH.multiSend141)],
    })

    expect(codes(fine)).toEqual([])
    expect(codes(bad)).toEqual(["setup-delegatecall-unknown"])
    expect(codes(nested)).toEqual(["setup-delegatecall-unknown"])
    expect(checkCreation(REGISTRY, withSetup({ ...multiSendSetup, batch: null, dataKnown: false })).gaps).toEqual([
      "The setup used MultiSend, but its batch was not available to check.",
    ])
  })

  it("reports a payment at setup", () => {
    expect(codes(withSetup({ payment: 10n }))).toEqual(["setup-payment"])
  })

  it("flags an unknown factory and an unknown callback", () => {
    expect(codes({ ...CANONICAL, factory: { address: OTHER, identification: id(OTHER, UNKNOWN_HASH) } })).toEqual([
      "factory-not-canonical",
    ])
    expect(codes({ ...CANONICAL, callback: { address: OTHER, identification: id(OTHER, UNKNOWN_HASH) } })).toEqual([
      "creation-callback-unknown",
    ])
    expect(codes({ ...CANONICAL, callback: { address: OTHER, identification: null } })).toEqual([
      "creation-callback-unknown",
    ])
  })

  it("gives no finding for an account whose read failed: its code is not known", () => {
    const unread = [OTHER as Address]
    const multiSend = { to: ADDRESS.multiSend141, toIdentification: id(ADDRESS.multiSend141, HASH.multiSend141) }

    expect(codes({ ...CANONICAL, factory: { address: OTHER, identification: null }, unread })).toEqual([])
    expect(codes({ ...CANONICAL, callback: { address: OTHER, identification: null }, unread })).toEqual([])
    expect(codes({ ...withSetup({ to: OTHER, toIdentification: null }), unread })).toEqual([])
    expect(codes({ ...withSetup({ ...multiSend, batch: [batchCall("delegatecall", OTHER, null)] }), unread })).toEqual(
      [],
    )
  })
})
