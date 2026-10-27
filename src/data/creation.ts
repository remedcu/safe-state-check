// Finds the transaction that created a Safe (docs/ARCHITECTURE.md section 6.9): the Transaction Service when it is on,
// then Blockscout, then the RPC itself (binary search for the first block with code, then the factory event there).
import { type Address, type Hex, pad } from "viem"
import { EVENT_TOPICS } from "@/core/constants"
import type { ReportIssue, ServiceRef } from "@/core/report"
import type { Blockscout } from "@/data/blockscout"
import { issueOf } from "@/data/errors"
import type { Reader } from "@/data/reader"
import type { CreationFinder, CreationLookup, SafeTxService } from "@/data/types"

// Every Safe factory from 1.3.0 on emits ProxyCreation with the proxy first: indexed from 1.4.1, in data in 1.3.0.
const FACTORY_TOPICS: Hex[] = [EVENT_TOPICS.ProxyCreation, EVENT_TOPICS.ProxyCreationL2]

export type CreationOptions = {
  reader: Reader
  safeTxService: SafeTxService | null
  blockscout: Blockscout | null
}

export class Creation implements CreationFinder {
  private readonly reader: Reader
  private readonly sts: SafeTxService | null
  private readonly blockscout: Blockscout | null

  constructor(options: CreationOptions) {
    this.reader = options.reader
    this.sts = options.safeTxService
    this.blockscout = options.blockscout
  }

  async find(safe: Address, anchorBlock: bigint): Promise<CreationLookup> {
    const tried: ServiceRef[] = []
    const issues: ReportIssue[] = []
    // An indexer's hash counts only once the RPC returns that transaction (it also gives the block).
    const confirm = async (txHash: Hex, source: ServiceRef): Promise<CreationLookup | null> => {
      try {
        const tx = await this.reader.transaction(txHash)
        return tx.blockNumber <= anchorBlock ? { found: true, txHash, blockNumber: tx.blockNumber, source } : null
      } catch (error) {
        issues.push(issueOf(error))
        return null
      }
    }

    if (this.sts) {
      const source: ServiceRef = { service: "safe-tx-service", host: this.sts.host }
      tried.push(source)
      const result = await this.sts.creation(safe)
      if (result.ok) {
        const found = await confirm(result.data.transactionHash, source)
        if (found) return found
      } else {
        issues.push(result.issue)
      }
    }
    if (this.blockscout) {
      const source: ServiceRef = { service: "blockscout", host: this.blockscout.host }
      tried.push(source)
      try {
        const hash = await this.blockscout.creationTx(safe)
        const found = hash ? await confirm(hash, source) : null
        if (found) return found
      } catch (error) {
        issues.push(issueOf(error))
      }
    }

    const source: ServiceRef = { service: "rpc", host: this.reader.pair().primary.host }
    tried.push(source)
    try {
      const block = await this.firstBlockWithCode(safe, anchorBlock)
      const txHash = block === null ? null : await this.factoryTx(safe, block)
      if (block !== null && txHash) return { found: true, txHash, blockNumber: block, source }
    } catch (error) {
      issues.push(issueOf(error))
    }
    return { found: false, tried, issues }
  }

  // About 25 eth_getCode calls on Ethereum; needs archive state.
  private async firstBlockWithCode(safe: Address, anchorBlock: bigint): Promise<bigint | null> {
    if (!(await this.reader.hasCodeAt(safe, anchorBlock))) return null
    let low = 0n
    let high = anchorBlock
    while (low < high) {
      const mid = (low + high) / 2n
      if (await this.reader.hasCodeAt(safe, mid)) high = mid
      else low = mid + 1n
    }
    return low
  }

  // The factory event in the creation block that names this Safe as the proxy.
  private async factoryTx(safe: Address, block: bigint): Promise<Hex | null> {
    const word = pad(safe.toLowerCase() as Hex, { size: 32 })
    const logs = await this.reader.logsChunk(null, block, block, FACTORY_TOPICS)
    const log = logs.find((l) => l.topics[1]?.toLowerCase() === word || l.data.slice(0, 66).toLowerCase() === word)
    return log?.transactionHash ?? null
  }
}
