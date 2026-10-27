// The history source, chosen by cost (docs/ARCHITECTURE.md section 6.10): RPC eth_getLogs when it needs at most 50
// chunks of the probed range, else Blockscout, else Etherscan with the user's key, else RPC anyway up to 1,000 chunks.
// One read has a wall-clock budget (90 s unless the caller raises it): public L2 RPCs with small log ranges otherwise
// take many minutes for an old Safe. A chunk that fails on one endpoint moves to the next log-capable one, and a chunk
// too large for every endpoint is split. Every source is filtered to the Safe's own address, and an event clears a
// finding only after the cross-check RPC's receipt confirms it.
import type { Hex } from "viem"
import type { ReportIssue, ServiceRef } from "@/core/report"
import type { Blockscout } from "@/data/blockscout"
import { issueOf } from "@/data/errors"
import type { Etherscan } from "@/data/etherscan"
import type { Reader } from "@/data/reader"
import type { EventSource, LogsQuery, LogsRead, RawLog } from "@/data/types"

export const CHEAP_CHUNKS = 50n
export const MAX_CHUNKS = 1_000n
export const HISTORY_BUDGET_MS = 90_000
// Ranges shrink by 10x on "range too large" down to this many blocks.
const MIN_RANGE = 10n

export type EventSourceOptions = {
  reader: Reader
  blockscout: Blockscout | null
  etherscan: Etherscan | null
  onIssue?: (issue: ReportIssue) => void
  budgetMs?: number
  now?: () => number
}

const sameLog = (a: RawLog, b: RawLog) =>
  a.logIndex === b.logIndex &&
  a.address.toLowerCase() === b.address.toLowerCase() &&
  a.data.toLowerCase() === b.data.toLowerCase() &&
  a.topics.length === b.topics.length &&
  a.topics.every((t, i) => t.toLowerCase() === b.topics[i].toLowerCase())

export class Events implements EventSource {
  private readonly reader: Reader
  private readonly blockscout: Blockscout | null
  private readonly etherscan: Etherscan | null
  private readonly onIssue: (issue: ReportIssue) => void
  private readonly budgetMs: number
  private readonly now: () => number

  constructor(options: EventSourceOptions) {
    this.reader = options.reader
    this.blockscout = options.blockscout
    this.etherscan = options.etherscan
    this.onIssue = options.onIssue ?? (() => undefined)
    this.budgetMs = options.budgetMs ?? HISTORY_BUDGET_MS
    this.now = options.now ?? Date.now
  }

  async logs(query: LogsQuery, onProgress?: (doneBlocks: bigint, totalBlocks: bigint) => void): Promise<LogsRead> {
    const deadline = this.now() + this.budgetMs
    const outOfTime = () => this.now() > deadline
    const total = query.toBlock - query.fromBlock + 1n
    const issues: ReportIssue[] = []
    // A source can return other contracts' logs (an indexer bug, or a hostile RPC); only the Safe's own count.
    const matches = (log: RawLog) =>
      log.address.toLowerCase() === query.address.toLowerCase() &&
      (!query.topic0?.length || query.topic0.some((t) => t.toLowerCase() === log.topics[0]?.toLowerCase()))
    const maxRange = BigInt(await this.reader.logsRange(query.address))
    const chunks = maxRange > 0n ? (total + maxRange - 1n) / maxRange : null
    const rpc: ServiceRef = { service: "rpc", host: this.reader.logsHost() }
    const rpcLogs = (cap: bigint) => this.rpcLogs(query, maxRange, cap, rpc, issues, matches, outOfTime, onProgress)

    if (chunks !== null && chunks <= CHEAP_CHUNKS) return rpcLogs(CHEAP_CHUNKS)
    if (this.blockscout) {
      try {
        const read = await this.blockscout.logs(
          query.address,
          query.fromBlock,
          query.toBlock,
          (oldest) => onProgress?.(query.toBlock - oldest + 1n, total),
          outOfTime,
        )
        // Items the indexer sent without a transaction hash are read again from an RPC, one call per block; with too
        // many such blocks the indexer is no use for this Safe and the other sources take over.
        if (read.unusableBlocks.length <= CHEAP_CHUNKS) {
          const recovered = await this.fromRpcBlocks(query.address, read.unusableBlocks, matches, issues)
          const complete = read.complete && recovered.complete
          const kept = read.logs.filter((l) => !recovered.blocks.has(l.blockNumber))
          return {
            logs: [...kept.filter(matches), ...recovered.logs].sort(byPosition),
            source: { service: "blockscout", host: this.blockscout.host },
            fromBlock: read.complete ? query.fromBlock : read.oldest,
            toBlock: query.toBlock,
            complete,
            issues,
            ...(complete
              ? {}
              : {
                  stoppedBy: read.timedOut
                    ? ("time" as const)
                    : read.complete
                      ? ("failure" as const)
                      : ("cap" as const),
                }),
          }
        }
      } catch (error) {
        issues.push({ ...issueOf(error), recovered: true })
      }
    }
    if (this.etherscan && !outOfTime()) {
      try {
        const read = await this.etherscan.logs(
          query.address,
          query.fromBlock,
          query.toBlock,
          (newest) => onProgress?.(newest - query.fromBlock + 1n, total),
          outOfTime,
        )
        return {
          logs: read.logs.filter(matches).sort(byPosition),
          source: { service: "etherscan", host: this.etherscan.host },
          fromBlock: query.fromBlock,
          toBlock: read.complete ? query.toBlock : read.newest,
          complete: read.complete,
          issues,
          ...(read.complete ? {} : { stoppedBy: read.timedOut ? ("time" as const) : ("cap" as const) }),
        }
      } catch (error) {
        issues.push({ ...issueOf(error), recovered: true })
      }
    }
    if (chunks === null) {
      return {
        logs: [],
        source: rpc,
        fromBlock: query.fromBlock,
        toBlock: query.fromBlock - 1n,
        complete: false,
        issues,
        stoppedBy: "failure",
      }
    }
    return rpcLogs(MAX_CHUNKS)
  }

  // Chunks from the oldest block up, until the range is covered, the chunk cap or the time budget is reached, or a
  // chunk fails on every log-capable endpoint. "Range too large" shrinks the range and repeats the chunk.
  private async rpcLogs(
    query: LogsQuery,
    startRange: bigint,
    maxChunks: bigint,
    source: ServiceRef,
    issues: ReportIssue[],
    matches: (log: RawLog) => boolean,
    outOfTime: () => boolean,
    onProgress?: (doneBlocks: bigint, totalBlocks: bigint) => void,
  ): Promise<LogsRead> {
    const total = query.toBlock - query.fromBlock + 1n
    const logs: RawLog[] = []
    let from = query.fromBlock
    let range = startRange
    let chunks = 0n
    let stoppedBy: LogsRead["stoppedBy"]
    while (from <= query.toBlock) {
      if (chunks >= maxChunks) {
        stoppedBy = "cap"
        break
      }
      if (chunks > 0n && outOfTime()) {
        stoppedBy = "time"
        break
      }
      chunks++
      const to = from + range - 1n < query.toBlock ? from + range - 1n : query.toBlock
      try {
        logs.push(...(await this.reader.logsChunk(query.address, from, to, query.topic0)).filter(matches))
      } catch (error) {
        const issue = issueOf(error)
        if (issue.kind === "range-too-large" && range > MIN_RANGE) {
          range = range / 10n > MIN_RANGE ? range / 10n : MIN_RANGE
          continue
        }
        issues.push(issue)
        stoppedBy = "failure"
        break
      }
      onProgress?.(to - query.fromBlock + 1n, total)
      from = to + 1n
    }
    const complete = from > query.toBlock
    return {
      logs: logs.sort(byPosition),
      source,
      fromBlock: query.fromBlock,
      toBlock: from - 1n,
      complete,
      issues,
      ...(complete ? {} : { stoppedBy }),
    }
  }

  // The Safe's logs of each block from the RPC; `complete` is false when a block could not be read.
  private async fromRpcBlocks(
    address: LogsQuery["address"],
    blocks: readonly bigint[],
    matches: (log: RawLog) => boolean,
    issues: ReportIssue[],
  ): Promise<{ logs: RawLog[]; blocks: Set<bigint>; complete: boolean }> {
    const logs: RawLog[] = []
    const read = new Set<bigint>()
    for (const block of blocks) {
      try {
        logs.push(...(await this.reader.logsChunk(address, block, block)).filter(matches))
        read.add(block)
      } catch (error) {
        issues.push(issueOf(error))
        return { logs, blocks: read, complete: false }
      }
    }
    return { logs, blocks: read, complete: true }
  }

  async confirm(logs: readonly RawLog[]): Promise<{ confirmed: RawLog[]; unconfirmed: RawLog[] }> {
    const hashes = [...new Set(logs.map((l) => l.transactionHash.toLowerCase() as Hex))]
    const receipts = new Map<Hex, RawLog[] | null>()
    await Promise.all(
      hashes.map(async (hash) => {
        try {
          receipts.set(hash, (await this.reader.confirmingReceiptLogs(hash)).logs)
        } catch (error) {
          this.onIssue(issueOf(error))
          receipts.set(hash, null)
        }
      }),
    )
    const confirmed: RawLog[] = []
    const unconfirmed: RawLog[] = []
    for (const log of logs) {
      const receipt = receipts.get(log.transactionHash.toLowerCase() as Hex)
      ;(receipt?.some((r) => sameLog(r, log)) ? confirmed : unconfirmed).push(log)
    }
    return { confirmed, unconfirmed }
  }
}

function byPosition(a: RawLog, b: RawLog): number {
  return a.blockNumber === b.blockNumber ? a.logIndex - b.logIndex : a.blockNumber < b.blockNumber ? -1 : 1
}
