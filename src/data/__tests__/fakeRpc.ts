// A fake network for the data layer tests: one handler per host, answering JSON-RPC calls from recorded mainnet data
// (the B1 Safe at block 26176126, recorded from eth.drpc.org).
import { type Hex, hexToBigInt, numberToHex } from "viem"
import recorded from "@/core/__tests__/fixtures/proof-reward-distribution-26176126.json"
import type { ChainInfo, DefaultRpc, ProviderPolicy } from "@/data/types"

export const SAFE = "0xAd219b3c26fe42BF5FC66F67490745a4fa5dff59"
export const BLOCK = hexToBigInt(recorded.block.number as Hex)
export const STATE_ROOT = recorded.block.stateRoot as Hex
export const BLOCK_HASH = recorded.block.hash as Hex
export const STORAGE_HASH = recorded.proof.storageHash as Hex
export const CODE_HASH = recorded.proof.codeHash as Hex
export const SLOTS = recorded.proof.storageProof.map((p) => p.key as Hex)
export const VALUES = new Map(recorded.proof.storageProof.map((p) => [p.key as Hex, hexToBigInt(p.value as Hex)]))

export const PROVIDERS: ProviderPolicy[] = [
  { id: "publicnode", name: "PublicNode (Allnodes)", hostSuffixes: ["publicnode.com"], aggregator: false },
  { id: "drpc", name: "dRPC", hostSuffixes: ["drpc.org"], aggregator: true },
  { id: "1rpc", name: "1RPC (Automata)", hostSuffixes: ["1rpc.io"], aggregator: true },
  { id: "blast", name: "Blast API", hostSuffixes: ["blastapi.io"], aggregator: false },
]

export const DRPC: DefaultRpc = rpc("https://eth.drpc.org", "drpc", true)
export const BLAST: DefaultRpc = rpc("https://eth-mainnet.public.blastapi.io", "blast", false)
export const PUBLICNODE: DefaultRpc = {
  ...rpc("https://ethereum-rpc.publicnode.com", "publicnode", false),
  proofs: false,
}
export const ONERPC: DefaultRpc = rpc("https://public.1rpc.io/eth", "1rpc", true)
export const TEAM: DefaultRpc = {
  ...rpc("https://rpc.chain.example", "team:chain.example", false),
  operatorKind: "team",
}

function rpc(url: string, operator: string, aggregator: boolean): DefaultRpc {
  return { url, operator, operatorKind: "provider", aggregator, proofs: true, probedAt: "2026-10-12T00:00:00.000Z" }
}

export function testChain(rpcs: DefaultRpc[], chainId = 1): ChainInfo {
  return {
    chainId,
    name: "Ethereum Mainnet",
    shortName: "eth",
    shortNameAliases: [],
    isTestnet: false,
    nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
    explorer: null,
    blockscoutApi: null,
    safeTxServiceApi: null,
    safeWallet: true,
    detectRank: 0,
    rootCheck: { status: "supported", reason: "test" },
    rpcs,
  }
}

export class RpcError {
  readonly code: number
  readonly message: string
  constructor(code: number, message: string) {
    this.code = code
    this.message = message
  }
}

export class HttpAnswer {
  readonly status: number
  readonly body: string
  readonly headers: Record<string, string>
  constructor(status: number, body: string, headers: Record<string, string> = {}) {
    this.status = status
    this.body = body
    this.headers = headers
  }
}

export type Handler = (method: string, params: unknown[]) => unknown

export type Call = { host: string; url: string; method: string; params: unknown[]; init: RequestInit }

// Answers per host; an unknown host fails like an unreachable server. Every body must be one JSON object.
export function fakeNetwork(handlers: Record<string, Handler>) {
  const calls: Call[] = []
  const fetch = async (input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> => {
    const url = String(input)
    const host = new URL(url).host
    const body: unknown = init.body ? JSON.parse(String(init.body)) : null
    if (init.method === "POST" && (typeof body !== "object" || body === null || Array.isArray(body))) {
      throw new Error(`batch or empty body sent to ${host}`)
    }
    const { method, params, id } = (body ?? { method: "GET", params: [], id: 0 }) as {
      method: string
      params: unknown[]
      id: number
    }
    calls.push({ host, url, method, params, init })
    const handler = handlers[host]
    if (!handler) throw new TypeError("fetch failed")
    // Like a real fetch, an aborted signal rejects the request even when the server never answers.
    const aborted = new Promise<never>((_, reject) => {
      const fail = () => reject(new DOMException("The operation was aborted.", "AbortError"))
      if (init.signal?.aborted) fail()
      init.signal?.addEventListener("abort", fail, { once: true })
    })
    const answer = await Promise.race([Promise.resolve(handler(method, params)), aborted])
    if (answer instanceof HttpAnswer) {
      return new Response(answer.body, { status: answer.status, headers: answer.headers })
    }
    if (answer instanceof RpcError) {
      return Response.json({ jsonrpc: "2.0", id, error: { code: answer.code, message: answer.message } })
    }
    return Response.json({ jsonrpc: "2.0", id, result: answer === undefined ? null : answer })
  }
  return { fetch: fetch as typeof globalThis.fetch, calls }
}

export type Header = { number: bigint; hash: Hex; stateRoot: Hex }

export const RECORDED_HEADER: Header = { number: BLOCK, hash: BLOCK_HASH, stateRoot: STATE_ROOT }

export function blockJson(header: Header) {
  return {
    number: numberToHex(header.number),
    hash: header.hash,
    stateRoot: header.stateRoot,
    timestamp: "0x68ebf6a3",
    parentHash: `0x${"11".repeat(32)}`,
  }
}

export function recordedProof(): typeof recorded.proof {
  return structuredClone(recorded.proof)
}

// An honest archive node at the recorded state: head is BLOCK + 3 unless given.
export function archiveNode(options: { head?: bigint; chainId?: number; headers?: Header[] } = {}): Handler {
  const head = options.head ?? BLOCK + 3n
  const headers = options.headers ?? [RECORDED_HEADER]
  return (method, params) => {
    switch (method) {
      case "eth_chainId":
        return numberToHex(options.chainId ?? 1)
      case "web3_clientVersion":
        return "test/1.0"
      case "eth_blockNumber":
        return numberToHex(head)
      case "eth_getBlockByNumber": {
        const number = hexToBigInt(params[0] as Hex)
        const header = headers.find((h) => h.number === number)
        return header ? blockJson(header) : null
      }
      case "eth_getProof":
        return recordedProof()
      case "eth_getCode":
        return "0x6001"
      case "eth_getStorageAt":
        return numberToHex(VALUES.get(params[1] as Hex) ?? 0n, { size: 32 })
      default:
        return new RpcError(-32601, `the method ${method} does not exist/is not available`)
    }
  }
}

// Wraps a handler so chosen methods answer differently.
export function override(base: Handler, methods: Record<string, Handler>): Handler {
  return (method, params) => (methods[method] ? methods[method](method, params) : base(method, params))
}
