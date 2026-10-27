import {
  type Address,
  decodeEventLog,
  decodeFunctionData,
  getAddress,
  type Hex,
  hexToBigInt,
  hexToNumber,
  isAddressEqual,
  size,
  slice,
  zeroAddress,
} from "viem"
import { FACTORY_ABI, MULTISEND_ABI, SAFE_ABI, SETUP_HELPER_ABI } from "@/core/abis"
import { EVENT_TOPICS } from "@/core/constants"
import { finding } from "@/core/findings"
import { displayName, knownAs, named, type Registry } from "@/core/registry"
import type { BatchCall, Finding, Identification } from "@/core/report"
import { wordAddress } from "@/core/slots"
import type { CallFrame, RawLog } from "@/data/types"

export type FactoryCall = {
  method: string
  singleton: Address
  initializer: Hex
  saltNonce: bigint | null
  callback: Address | null
}

// Decodes a call to a Safe proxy factory, or returns null when `input` is not one.
export function decodeFactoryCall(input: Hex): FactoryCall | null {
  try {
    const { functionName, args } = decodeFunctionData({ abi: FACTORY_ABI, data: input })
    if (functionName === "createProxy") {
      return { method: functionName, singleton: args[0], initializer: args[1], saltNonce: null, callback: null }
    }
    const callback = functionName === "createProxyWithCallback" ? args[3] : null
    return { method: functionName, singleton: args[0], initializer: args[1], saltNonce: args[2], callback }
  } catch {
    return null
  }
}

// The call that created `safe`: the parent of the CREATE or CREATE2 frame whose address is the Safe.
export function findFactoryFrame(root: CallFrame, safe: Address): CallFrame | null {
  for (const call of root.calls ?? []) {
    if ((call.type === "CREATE" || call.type === "CREATE2") && call.to && isAddressEqual(call.to, safe)) return root
    const found = findFactoryFrame(call, safe)
    if (found !== null) return found
  }
  return null
}

export type SetupCall = {
  owners: readonly Address[]
  threshold: bigint
  to: Address
  data: Hex
  fallbackHandler: Address
  paymentToken: Address
  payment: bigint
  paymentReceiver: Address
}

export function decodeSetup(initializer: Hex): SetupCall | null {
  try {
    const { functionName, args } = decodeFunctionData({ abi: SAFE_ABI, data: initializer })
    if (functionName !== "setup") return null
    const [owners, threshold, to, data, fallbackHandler, paymentToken, payment, paymentReceiver] = args
    return { owners, threshold, to, data, fallbackHandler, paymentToken, payment, paymentReceiver }
  } catch {
    return null
  }
}

export type InnerCall = { operation: "call" | "delegatecall"; to: Address; value: bigint; data: Hex }

// The packed transactions of `multiSend(bytes)`: operation (1 byte), to (20), value (32), data length (32), data.
export function decodeMultiSend(data: Hex): InnerCall[] | null {
  let transactions: Hex
  try {
    const decoded = decodeFunctionData({ abi: MULTISEND_ABI, data })
    transactions = decoded.args[0]
  } catch {
    return null
  }
  const calls: InnerCall[] = []
  const total = size(transactions)
  let offset = 0
  while (offset < total) {
    if (offset + 85 > total) return null
    const operation = hexToNumber(slice(transactions, offset, offset + 1))
    if (operation > 1) return null
    const to = getAddress(slice(transactions, offset + 1, offset + 21))
    const value = hexToBigInt(slice(transactions, offset + 21, offset + 53))
    const length = hexToBigInt(slice(transactions, offset + 53, offset + 85))
    if (BigInt(offset + 85) + length > BigInt(total)) return null
    const end = offset + 85 + Number(length)
    calls.push({
      operation: operation === 0 ? "call" : "delegatecall",
      to,
      value,
      data: length === 0n ? "0x" : slice(transactions, offset + 85, end),
    })
    offset = end
  }
  return calls
}

// Name of a well-known setup call, or its selector.
export function describeCall(data: Hex): string | null {
  if (size(data) < 4) return null
  try {
    return decodeFunctionData({ abi: SETUP_HELPER_ABI, data }).functionName
  } catch {
    return slice(data, 0, 4)
  }
}

export type CreationLogs = {
  factory: Address | null
  // The factory method an L2 creation event stands for.
  method: string | null
  singleton: Address | null
  initializer: Hex | null
  saltNonce: bigint | null
  // From the Safe's own SafeSetup event: owners, threshold, `to` and fallback handler, but not `data` or payment.
  setupEvent: { owners: readonly Address[]; threshold: bigint; to: Address; fallbackHandler: Address } | null
}

// What the creation transaction's logs say about the Safe, for when there is no call trace.
export function creationFromLogs(logs: readonly RawLog[], safe: Address): CreationLogs {
  const result: CreationLogs = {
    factory: null,
    method: null,
    singleton: null,
    initializer: null,
    saltNonce: null,
    setupEvent: null,
  }
  for (const log of logs) {
    const topic = log.topics[0]
    try {
      if (topic === EVENT_TOPICS.ProxyCreationL2 || topic === EVENT_TOPICS.ChainSpecificProxyCreationL2) {
        const { args } = decodeEventLog({ abi: FACTORY_ABI, data: log.data, topics: log.topics as [Hex, ...Hex[]] })
        if (!isAddressEqual(args.proxy, safe)) continue
        Object.assign(result, {
          factory: getAddress(log.address),
          method:
            topic === EVENT_TOPICS.ProxyCreationL2 ? "createProxyWithNonceL2" : "createChainSpecificProxyWithNonceL2",
          singleton: args.singleton,
          initializer: args.initializer,
          saltNonce: args.saltNonce,
        })
      } else if (topic === EVENT_TOPICS.ProxyCreation && result.factory === null) {
        // 1.3.0 indexes nothing, 1.4.1 and 1.5.0 index the proxy: the words are proxy then singleton either way.
        const words = [...log.topics.slice(1), ...chunks(log.data)]
        if (words.length === 2 && isAddressEqual(wordAddress(hexToBigInt(words[0])), safe)) {
          result.factory = getAddress(log.address)
          result.singleton = wordAddress(hexToBigInt(words[1]))
        }
      } else if (topic === EVENT_TOPICS.SafeSetup && isAddressEqual(log.address, safe)) {
        const { args } = decodeEventLog({ abi: SAFE_ABI, data: log.data, topics: log.topics as [Hex, ...Hex[]] })
        result.setupEvent = {
          owners: args.owners,
          threshold: args.threshold,
          to: args.initializer,
          fallbackHandler: args.fallbackHandler,
        }
      }
    } catch {
      // A log with this topic but another shape is not from a Safe factory or a Safe.
    }
  }
  return result
}

function chunks(data: Hex): Hex[] {
  const words: Hex[] = []
  for (let offset = 0; offset < size(data); offset += 32) words.push(slice(data, offset, offset + 32))
  return words
}

export type CreationCheckInput = {
  factory: { address: Address; identification: Identification | null } | null
  callback: { address: Address; identification: Identification | null } | null
  setup: {
    to: Address
    toIdentification: Identification | null
    // null when the setup data could not be read (for example only the SafeSetup event was available).
    batch: BatchCall[] | null
    dataKnown: boolean
    payment: bigint | null
    paymentToken: Address | null
    paymentReceiver: Address | null
  } | null
  // Accounts whose read failed: their code is not known, so they get no finding (the step records the gap).
  unread?: readonly Address[]
}

const MULTISEND_NAMES = ["MultiSend", "MultiSendCallOnly"]

function isMultiSend(registry: Registry, identification: Identification | null): boolean {
  return MULTISEND_NAMES.some((name) => named(registry, identification, name))
}

// A known setup helper other than MultiSend (whose batch is checked call by call).
function isSetupHelper(registry: Registry, identification: Identification | null): boolean {
  return knownAs(registry, identification, ["setup-helper"]) && !isMultiSend(registry, identification)
}

export function checkCreation(registry: Registry, input: CreationCheckInput): { findings: Finding[]; gaps: string[] } {
  const findings: Finding[] = []
  const gaps: string[] = []
  const read = (address: Address) => !(input.unread ?? []).some((unread) => isAddressEqual(unread, address))

  if (
    input.factory !== null &&
    read(input.factory.address) &&
    !knownAs(registry, input.factory.identification, ["proxy-factory"])
  ) {
    findings.push(
      finding("factory-not-canonical", "creation", {
        subject: input.factory.address,
        technical: `Factory ${input.factory.address} (${displayName(input.factory.identification) ?? `code hash ${input.factory.identification?.codeHash ?? "none"}`}) is not a known Safe proxy factory`,
      }),
    )
  }
  if (input.callback !== null && read(input.callback.address) && input.callback.identification?.status !== "known") {
    findings.push(
      finding("creation-callback-unknown", "creation", {
        subject: input.callback.address,
        technical: `createProxyWithCallback called ${input.callback.address}, which is not a known deployment`,
      }),
    )
  }

  const setup = input.setup
  if (setup === null) return { findings, gaps }

  if (!isAddressEqual(setup.to, zeroAddress) && read(setup.to)) {
    const unknownTarget = (technical: string) =>
      findings.push(finding("setup-delegatecall-unknown", "creation", { subject: setup.to, technical }))
    if (setup.toIdentification === null) {
      unknownTarget(`setup delegatecalled ${setup.to}, which has no code now; what ran at setup cannot be checked`)
    } else if (isMultiSend(registry, setup.toIdentification)) {
      if (setup.batch === null) {
        gaps.push(
          setup.dataKnown
            ? "The setup MultiSend batch could not be decoded."
            : "The setup used MultiSend, but its batch was not available to check.",
        )
      } else {
        for (const call of setup.batch) {
          if (call.operation !== "delegatecall" || !read(call.to)) continue
          if (!isSetupHelper(registry, call.identification)) {
            unknownTarget(
              `The setup MultiSend delegatecalled ${call.to} (${displayName(call.identification) ?? "unknown code"}), which is not a known setup helper`,
            )
          }
        }
      }
    } else if (!isSetupHelper(registry, setup.toIdentification)) {
      unknownTarget(
        `setup delegatecalled ${setup.to} (${displayName(setup.toIdentification) ?? `code hash ${setup.toIdentification.codeHash}`}), which is not a known setup helper`,
      )
    }
  }

  if (setup.payment !== null && setup.payment > 0n) {
    findings.push(
      finding("setup-payment", "creation", {
        subject: setup.paymentReceiver,
        technical: `setup paid ${setup.payment} of ${isAddressEqual(setup.paymentToken ?? zeroAddress, zeroAddress) ? "the native token" : `token ${setup.paymentToken}`} to ${setup.paymentReceiver}`,
      }),
    )
  }
  return { findings, gaps }
}
