// Blockscout API v2, keyless (docs/ARCHITECTURE.md section 6.9). The base URL comes from chains.json, never from
// "<chain>.blockscout.com": Gnosis moved to gnosisscan.io and the old host redirects without CORS.
import { type Address, getAddress, type Hex, isHex } from "viem"
import type { Transport } from "@/data/transport"
import type { RawLog } from "@/data/types"

// 50 logs per page; this caps one history read at 20,000 logs.
const MAX_PAGES = 400

type BlockscoutLog = {
  address?: { hash?: string }
  topics?: (string | null)[]
  data?: string
  block_number?: number
  transaction_hash?: string
  index?: number
}

type LogsPage = { items?: BlockscoutLog[]; next_page_params?: Record<string, string | number> | null }

export class Blockscout {
  readonly host: string
  private readonly base: string
  private readonly transport: Transport

  constructor(base: string, transport: Transport) {
    this.base = base.replace(/\/+$/, "")
    this.host = new URL(this.base).host
    this.transport = transport
  }

  // The hash of the transaction that created `address`, or null when Blockscout does not know it.
  async creationTx(address: Address): Promise<Hex | null> {
    const res = await this.transport.api(`${this.base}/addresses/${getAddress(address)}`, {
      service: "blockscout",
      operation: "look up the creation transaction",
      accept: [404],
    })
    const hash = (res.body as { creation_transaction_hash?: unknown } | null)?.creation_transaction_hash
    return res.status === 200 && isHex(hash) && hash.length === 66 ? (hash.toLowerCase() as Hex) : null
  }

  // Logs of `address` from `fromBlock` to `toBlock`. Pages come newest first, so the read walks back until it passes
  // `fromBlock`. `complete` is false when the page cap or `outOfTime` stopped it first. Items without a transaction
  // hash or an address (gnosisscan.io sends "transaction_hash": "" for every log) are not logs the checks can use:
  // their blocks come back in `unusableBlocks` for the caller to read from an RPC.
  async logs(
    address: Address,
    fromBlock: bigint,
    toBlock: bigint,
    onPage?: (oldestBlock: bigint) => void,
    outOfTime: () => boolean = () => false,
  ): Promise<{ logs: RawLog[]; complete: boolean; oldest: bigint; timedOut: boolean; unusableBlocks: bigint[] }> {
    const logs: RawLog[] = []
    const unusable = new Set<bigint>()
    const result = (complete: boolean, oldestBlock: bigint, timedOut: boolean) => ({
      logs,
      complete,
      oldest: oldestBlock,
      timedOut,
      unusableBlocks: [...unusable].sort((a, b) => (a < b ? -1 : 1)),
    })
    let params: Record<string, string | number> | null = {}
    let oldest = toBlock
    for (let page = 0; page < MAX_PAGES && params; page++) {
      if (page > 0 && outOfTime()) return result(false, oldest, true)
      const query = new URLSearchParams(
        Object.entries(params).map(([k, v]): [string, string] => [k, String(v)]),
      ).toString()
      const res = await this.transport.api(
        `${this.base}/addresses/${getAddress(address)}/logs${query ? `?${query}` : ""}`,
        {
          service: "blockscout",
          operation: "read the Safe's events",
        },
      )
      const body = res.body as LogsPage
      for (const item of body.items ?? []) {
        const block = BigInt(item.block_number ?? 0)
        if (block < fromBlock) return result(true, fromBlock, false)
        oldest = block
        if (block > toBlock) continue
        if (!isHex(item.transaction_hash) || item.transaction_hash.length !== 66 || !item.address?.hash) {
          unusable.add(block)
          continue
        }
        logs.push({
          address: getAddress(item.address.hash),
          topics: (item.topics ?? []).filter((t): t is string => t !== null).map((t) => t.toLowerCase() as Hex),
          data: (item.data ?? "0x") as Hex,
          blockNumber: block,
          transactionHash: item.transaction_hash.toLowerCase() as Hex,
          logIndex: item.index ?? 0,
        })
      }
      onPage?.(oldest)
      params = body.next_page_params ?? null
    }
    return result(params === null, params === null ? fromBlock : oldest, false)
  }
}
