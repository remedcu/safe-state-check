// Drives one anvil: places the canonical contracts recorded from mainnet, deploys the helpers, and creates Safes
// through the canonical factory with a real `setup` call. Owners act with real ECDSA signatures.
import { readFileSync } from "node:fs"
import path from "node:path"
import {
  type Address,
  concat,
  createTestClient,
  defineChain,
  encodeFunctionData,
  getAddress,
  type Hex,
  http,
  numberToHex,
  parseAbi,
  publicActions,
  size,
  walletActions,
  zeroAddress,
} from "viem"
import { mnemonicToAccount } from "viem/accounts"
import { EVENT_TOPICS } from "@/core/constants"
import { ARTIFACTS } from "./anvil"
import canonical from "./fixtures/canonical.json" with { type: "json" }

export const VERSIONS = ["1.3.0", "1.4.1", "1.5.0"] as const
// Ethereum, and Base for SafeToL2Setup (it switches to the L2 singleton on any chain but 1).
export const CHAIN_IDS = { l1: 1, l2: 8453 } as const
export type Version = (typeof VERSIONS)[number]

// Anvil's funded default accounts.
export const account = (index: number) =>
  mnemonicToAccount("test test test test test test test test test test test junk", { addressIndex: index })
export type Account = ReturnType<typeof account>
const relayer = account(0)

export const ABI = parseAbi([
  "function setup(address[] owners, uint256 threshold, address to, bytes data, address fallbackHandler, address paymentToken, uint256 payment, address paymentReceiver)",
  "function createProxyWithNonce(address singleton, bytes initializer, uint256 saltNonce) returns (address)",
  "function execTransaction(address to, uint256 value, bytes data, uint8 operation, uint256 safeTxGas, uint256 baseGas, uint256 gasPrice, address gasToken, address refundReceiver, bytes signatures) payable returns (bool)",
  "function execTransactionFromModule(address to, uint256 value, bytes data, uint8 operation) returns (bool)",
  "function nonce() view returns (uint256)",
  "function getOwners() view returns (address[])",
  "function isOwner(address owner) view returns (bool)",
  "function getModulesPaginated(address start, uint256 pageSize) view returns (address[] array, address next)",
  "function enableModule(address module)",
  "function approveHash(bytes32 hash)",
  "function signMessage(bytes message)",
  "function setupToL2(address l2Singleton)",
  "function multiSend(bytes transactions) payable",
  "function writeOwner(address x)",
  "function writeModule(address x)",
  "function writeGuard(address guard)",
])

function code(name: string, version: string): { address: Address; code: Hex } {
  const entry = canonical.contracts.find((c) => c.name === name && c.version === version)
  if (!entry) throw new Error(`${name} ${version} is not in fixtures/canonical.json`)
  return { address: getAddress(entry.address), code: entry.code as Hex }
}

export function deployment(v: Version) {
  const [safe, safeL2, factory] =
    v === "1.3.0" ? ["GnosisSafe", "GnosisSafeL2", "GnosisSafeProxyFactory"] : ["Safe", "SafeL2", "SafeProxyFactory"]
  return {
    safe: code(safe, v).address,
    safeL2: code(safeL2, v).address,
    factory: code(factory, v).address,
    handler: code("CompatibilityFallbackHandler", v).address,
    multiSendCallOnly: code("MultiSendCallOnly", v).address,
    signMessageLib: code("SignMessageLib", v).address,
    // SafeToL2Setup ships from 1.4.1 on.
    toL2Setup: v === "1.3.0" ? null : code("SafeToL2Setup", v).address,
  }
}
export const SCOPE_GUARD = code("scopeGuard", "1.0.0").address

function artifact(name: string): Hex {
  return JSON.parse(readFileSync(path.join(ARTIFACTS, `${name}.json`), "utf8")).bytecode.object
}

// Init code that deploys `runtime` unchanged.
function deployCopy(runtime: Hex): Hex {
  return concat(["0x61", numberToHex(size(runtime), { size: 2 }), "0x80600c6000396000f3", runtime])
}

export type SafeTx = { to: Address; value?: bigint; data?: Hex; operation?: 0 | 1 }

export class Chain {
  readonly url: string
  readonly chainId: number
  readonly client
  helpers: Record<"ShadowWriter" | "AnyHandler" | "Delegate", Address> | null = null
  private salt = 0n

  constructor(url: string, chainId: number) {
    this.url = url
    this.chainId = chainId
    const chain = defineChain({
      id: chainId,
      name: "anvil",
      nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
      rpcUrls: { default: { http: [url] } },
    })
    this.client = createTestClient({ chain, mode: "anvil", transport: http(url) })
      .extend(publicActions)
      .extend(walletActions)
  }

  async receipt(hash: Hex) {
    const receipt = await this.client.waitForTransactionReceipt({ hash })
    if (receipt.status !== "success") throw new Error(`transaction ${hash} reverted`)
    return receipt
  }

  async deploy(data: Hex): Promise<Address> {
    const hash = await this.client.sendTransaction({ account: relayer, data, to: null })
    return (await this.receipt(hash)).contractAddress!
  }

  async init(): Promise<void> {
    for (const c of canonical.contracts)
      await this.client.setCode({ address: getAddress(c.address), bytecode: c.code as Hex })
    this.helpers = {
      ShadowWriter: await this.deploy(artifact("ShadowWriter")),
      AnyHandler: await this.deploy(artifact("AnyHandler")),
      Delegate: await this.deploy(artifact("Delegate")),
    }
  }

  // A copy of the version's singleton with one byte of its metadata hash changed: same behaviour, other code hash.
  async singletonCopy(v: Version): Promise<Address> {
    const runtime = code(v === "1.3.0" ? "GnosisSafe" : "Safe", v).code
    const at = runtime.lastIndexOf("a264697066735822") + 20
    if (at < 20) throw new Error(`no metadata hash in the ${v} singleton`)
    const flipped = (runtime.slice(0, at) +
      (runtime.slice(at, at + 2) === "00" ? "01" : "00") +
      runtime.slice(at + 2)) as Hex
    return this.deploy(deployCopy(flipped))
  }

  async createSafe(
    v: Version,
    setup: { owners: Address[]; to?: Address; data?: Hex; fallbackHandler?: Address; singleton?: Address },
  ): Promise<Address> {
    const d = deployment(v)
    const initializer = encodeFunctionData({
      abi: ABI,
      functionName: "setup",
      args: [
        setup.owners,
        1n,
        setup.to ?? zeroAddress,
        setup.data ?? "0x",
        setup.fallbackHandler ?? d.handler,
        zeroAddress,
        0n,
        zeroAddress,
      ],
    })
    const call = {
      account: relayer,
      address: d.factory,
      abi: ABI,
      functionName: "createProxyWithNonce",
      args: [setup.singleton ?? d.safe, initializer, ++this.salt],
    } as const
    const { result } = await this.client.simulateContract(call)
    await this.receipt(await this.client.writeContract(call))
    // Funds for the transactions that prove what a shadow entry can do.
    await this.receipt(await this.client.sendTransaction({ account: relayer, to: result, value: 10n ** 18n }))
    return result
  }

  // execTransaction signed by `signer` (threshold 1). Returns the topic0 list of the Safe's logs.
  async exec(safe: Address, signer: Account, tx: SafeTx): Promise<Hex[]> {
    const nonce = await this.client.readContract({ address: safe, abi: ABI, functionName: "nonce" })
    const message = {
      to: tx.to,
      value: tx.value ?? 0n,
      data: tx.data ?? "0x",
      operation: tx.operation ?? 0,
      safeTxGas: 0n,
      baseGas: 0n,
      gasPrice: 0n,
      gasToken: zeroAddress,
      refundReceiver: zeroAddress,
      nonce,
    } as const
    const signature = await signer.signTypedData({
      domain: { chainId: this.chainId, verifyingContract: safe },
      types: {
        SafeTx: [
          { name: "to", type: "address" },
          { name: "value", type: "uint256" },
          { name: "data", type: "bytes" },
          { name: "operation", type: "uint8" },
          { name: "safeTxGas", type: "uint256" },
          { name: "baseGas", type: "uint256" },
          { name: "gasPrice", type: "uint256" },
          { name: "gasToken", type: "address" },
          { name: "refundReceiver", type: "address" },
          { name: "nonce", type: "uint256" },
        ],
      },
      primaryType: "SafeTx",
      message,
    })
    const hash = await this.client.writeContract({
      account: relayer,
      address: safe,
      abi: ABI,
      functionName: "execTransaction",
      args: [
        message.to,
        message.value,
        message.data,
        message.operation,
        0n,
        0n,
        0n,
        zeroAddress,
        zeroAddress,
        signature,
      ],
      gas: 1_000_000n,
    })
    return this.topics(safe, hash)
  }

  async topics(safe: Address, hash: Hex): Promise<Hex[]> {
    const receipt = await this.receipt(hash)
    return receipt.logs.filter((log) => getAddress(log.address) === safe).map((log) => log.topics[0]!)
  }

  async mine(blocks: number): Promise<void> {
    await this.client.mine({ blocks })
  }
}

export const SUCCESS = EVENT_TOPICS.ExecutionSuccess
export const MODULE_SUCCESS = EVENT_TOPICS.ExecutionFromModuleSuccess
