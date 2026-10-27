// Etherscan API v2 event logs, only with the user's key: no request without one. Errors come as HTTP 200 with
// `status: "0"`, and "No records found" is an empty success.
import { type Address, getAddress, type Hex, hexToBigInt } from "viem"
import type { Transport } from "@/data/transport"
import { IoError, type RawLog } from "@/data/types"

export const ETHERSCAN_API = "https://api.etherscan.io/v2/api"
// The free tier returns at most 1,000 records per request (from 2026-07-01).
const OFFSET = 1_000
const MAX_REQUESTS = 50

type EtherscanLog = {
  address: string
  topics: string[]
  data: string
  blockNumber: string
  transactionHash: string
  logIndex: string
}

export class Etherscan {
  readonly host = new URL(ETHERSCAN_API).host
  private readonly chainId: number
  private readonly apiKey: string
  private readonly transport: Transport

  constructor(chainId: number, apiKey: string, transport: Transport) {
    this.chainId = chainId
    this.apiKey = apiKey
    this.transport = transport
  }

  // Walks forward from `fromBlock`; each request starts at the last block seen, so a block split across two pages is
  // read again and de-duplicated. `complete` is false when the request cap or `outOfTime` stopped it first.
  async logs(
    address: Address,
    fromBlock: bigint,
    toBlock: bigint,
    onPage?: (newestBlock: bigint) => void,
    outOfTime: () => boolean = () => false,
  ): Promise<{ logs: RawLog[]; complete: boolean; newest: bigint; timedOut: boolean }> {
    const seen = new Map<string, RawLog>()
    let from = fromBlock
    for (let request = 0; request < MAX_REQUESTS; request++) {
      if (request > 0 && outOfTime()) return { logs: [...seen.values()], complete: false, newest: from, timedOut: true }
      const params = new URLSearchParams({
        chainid: String(this.chainId),
        module: "logs",
        action: "getLogs",
        address: getAddress(address),
        fromBlock: String(from),
        toBlock: String(toBlock),
        page: "1",
        offset: String(OFFSET),
        apikey: this.apiKey,
      })
      const res = await this.transport.api(`${ETHERSCAN_API}?${params}`, {
        service: "etherscan",
        operation: "read the Safe's events",
      })
      const body = res.body as { status?: string; message?: string; result?: unknown }
      if (body.status !== "1") {
        const message = typeof body.result === "string" ? body.result : (body.message ?? "")
        if (/no records found/i.test(`${message} ${body.message ?? ""}`))
          return { logs: [...seen.values()], complete: true, newest: toBlock, timedOut: false }
        throw new IoError(
          this.transport.apiIssue(ETHERSCAN_API, "etherscan", "read the Safe's events", message, res.status),
        )
      }
      const items = (body.result as EtherscanLog[]) ?? []
      for (const item of items) {
        const log: RawLog = {
          address: getAddress(item.address),
          topics: item.topics.filter(Boolean).map((t) => t.toLowerCase() as Hex),
          data: item.data as Hex,
          blockNumber: hexToBigInt(item.blockNumber as Hex),
          transactionHash: item.transactionHash.toLowerCase() as Hex,
          logIndex: item.logIndex === "0x" ? 0 : Number(hexToBigInt(item.logIndex as Hex)),
        }
        seen.set(`${log.transactionHash} ${log.logIndex}`, log)
      }
      const newest = items.length ? hexToBigInt(items[items.length - 1].blockNumber as Hex) : toBlock
      onPage?.(newest)
      if (items.length < OFFSET) return { logs: [...seen.values()], complete: true, newest: toBlock, timedOut: false }
      if (newest === from) return { logs: [...seen.values()], complete: false, newest: from, timedOut: false }
      from = newest
    }
    return { logs: [...seen.values()], complete: false, newest: from, timedOut: false }
  }
}
