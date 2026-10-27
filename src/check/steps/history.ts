import { type Address, type Hex, isAddressEqual } from "viem"
import { EVENT_TOPICS } from "@/core/constants"
import { finding } from "@/core/findings"
import {
  announced,
  approveHashEvents,
  CLEARING_EVENTS,
  checkHistory,
  decodeSafeLog,
  executedHashes,
  type HistoryCoverage,
  signMsgEvents,
} from "@/core/history"
import { checkPending, type QueuedTx } from "@/core/pending"
import { displayName } from "@/core/registry"
import type { ConfigState, PendingSection, ServiceRef } from "@/core/report"
import { approvedHashSlot, signedMessageSlot } from "@/core/slots"
import { cleanUntrusted } from "@/core/text"
import type { LogsRead, RawLog, StsMultisigTx } from "@/data/types"
import { issueLine, type RunState } from "@/check/state"
import type { ConfigOutcome, IdentityOutcome } from "@/check/steps/safe"

// What the config and handler steps found, as the current proven state the history compares with.
export type ConfigNow = {
  config: ConfigOutcome
  handlers: { guard: Address | null; moduleGuard: Address | null; fallbackHandler: Address | null }
}

function currentState(identity: IdentityOutcome, now: ConfigNow): ConfigState {
  return {
    singleton: identity.result.section.singleton.address,
    owners: [...now.config.config.owners],
    threshold: now.config.config.threshold.toString(),
    modules: [...now.config.config.modules],
    guard: now.handlers.guard,
    moduleGuard: now.handlers.moduleGuard,
    fallbackHandler: now.handlers.fallbackHandler,
  }
}

const ALL_TOPICS = Object.values(EVENT_TOPICS)

// A Safe created before 1.3.0 keeps a 1.0.0 to 1.2.0 proxy and emits no SafeSetup.
function createdBeforeSetup(identity: IdentityOutcome): boolean {
  const name = displayName(identity.result.section.proxy.identification)
  return name !== null && /^SafeProxy 1\.(0\.0|1\.1|2\.0)$/.test(name)
}

// Why the history read ended before the anchor, and how far it got.
function stoppedText(read: LogsRead, fromBlock: bigint, toBlock: bigint): string {
  if (read.toBlock < fromBlock) {
    const host = read.source.host
    switch (read.stoppedBy) {
      case "time":
        return `The history read reached its time limit before ${host} returned any block range, so no event was read.`
      case "cap":
        return `The history read reached its request limit before ${host} returned any block range, so no event was read.`
      default:
        return `No block range of the event history could be read from ${host}, so no event was read. The issues list says why.`
    }
  }
  // An RPC reads forward from creation, an indexer back from the anchor: the covered range says both.
  const covers = `it covers blocks ${read.fromBlock} to ${read.toBlock}, not ${fromBlock} to ${toBlock}`
  switch (read.stoppedBy) {
    case "time":
      return `The history read stopped at its time limit: ${covers}.`
    case "cap":
      return `The history read stopped at its request limit: ${covers}.`
    case "failure":
      return `The history read failed partway: ${covers}.`
    default:
      return "Not every block since creation could be read."
  }
}

// The Safe's own logs, and whether an independent RPC confirmed each one that clears a finding.
export type HistoryRead = { logs: RawLog[]; confirmed: (log: RawLog) => boolean }

const NO_HISTORY: HistoryRead = { logs: [], confirmed: () => false }

export type CreationFacts = { block: bigint | null; singleton: Address | null }

// Reads the event history, replays it and names settings set without an event. A history that cannot be read is
// an incomplete history: the finding says so and the verdict reasons repeat it.
export async function historyStep(
  run: RunState,
  identity: IdentityOutcome,
  now: ConfigNow,
  creation: CreationFacts,
): Promise<HistoryRead> {
  const result = await run.step("history", async (finish) => {
    const fromBlock = creation.block ?? 0n
    const toBlock = (run.safeAnchor ?? run.anchor!).number
    const read = await run.deps.events.logs({ address: run.safe, fromBlock, toBlock, topic0: ALL_TOPICS })
    for (const issue of read.issues) run.issue(issue)
    // Only the Safe's own logs count.
    const logs = read.logs.filter((log) => isAddressEqual(log.address, run.safe))

    // An independent RPC confirms every event that clears a finding, and every execution that spends an approval;
    // the other executions only feed counts and are not fetched again.
    const approvalHashes = new Set(approveHashEvents(logs).map((approval) => approval.hash))
    const toConfirm = logs.filter((log) => {
      const decoded = decodeSafeLog(log)
      if (decoded === null) return false
      if (CLEARING_EVENTS.has(decoded.name)) return true
      return (
        decoded.name === "ExecutionSuccess" && approvalHashes.has((decoded.args.txHash as Hex).toLowerCase() as Hex)
      )
    })
    const needed = new Set(toConfirm)
    const confirmed = new Set(toConfirm.length === 0 ? [] : (await run.deps.events.confirm(toConfirm)).confirmed)
    const isConfirmed = (log: RawLog) => !needed.has(log) || confirmed.has(log)

    const coverage: HistoryCoverage = !read.complete
      ? "partial"
      : read.source.service === "rpc"
        ? "node-full"
        : "indexer"
    // The range actually read: an indexer walks back from the anchor, the RPC forward from creation.
    const { section, findings, skipped } = checkHistory({
      source: read.source,
      fromBlock: read.fromBlock,
      toBlock: read.toBlock,
      coverage,
      logs,
      confirmed: isConfirmed,
      current: currentState(identity, now),
      createdBeforeSetup: createdBeforeSetup(identity),
      creationSingleton: creation.singleton,
    })
    run.addFindings(findings)
    // Nothing read: there is no block range to show, only the reason.
    if (read.toBlock < fromBlock) {
      const reason = stoppedText(read, fromBlock, toBlock)
      run.setSection("history", { state: "unavailable", reason })
      finish("degraded", reason)
      return { logs, confirmed: isConfirmed }
    }
    const gaps = [
      ...(!read.complete
        ? [stoppedText(read, fromBlock, toBlock)]
        : section.complete
          ? []
          : ["The history is incomplete."]),
      ...(skipped > 0
        ? [`${skipped} log(s) from the Safe's address are not well-formed Safe events and were skipped.`]
        : []),
    ]
    run.setSection(
      "history",
      gaps.length > 0 ? { state: "partial", data: section, gaps } : { state: "complete", data: section },
    )

    // The handlers learn whether a confirmed event set each value.
    const handlers = run.sections.handlers
    if (handlers?.state === "complete" || handlers?.state === "partial") {
      const data = handlers.data
      run.setSection("handlers", {
        ...handlers,
        data: {
          guard: { ...data.guard, announced: announced(section, data.guard) },
          moduleGuard: { ...data.moduleGuard, announced: announced(section, data.moduleGuard) },
          fallbackHandler: { ...data.fallbackHandler, announced: announced(section, data.fallbackHandler) },
        },
      })
    }
    if (!read.complete) finish("degraded", stoppedText(read, fromBlock, toBlock))
    return { logs, confirmed: isConfirmed }
  })
  if (result !== null) return result
  const note = run.steps.get("history")?.note ?? "the event source failed"
  run.addFindings([
    finding("history-incomplete", "history", { technical: `The event history could not be read. ${note}` }),
  ])
  return NO_HISTORY
}

function toQueued(tx: StsMultisigTx): QueuedTx {
  return {
    safeTxHash: tx.safeTxHash,
    nonce: tx.nonce,
    to: tx.to,
    value: tx.value,
    operation: tx.operation === 1 ? "delegatecall" : "call",
    confirmations: tx.confirmations.length,
    required: tx.confirmationsRequired,
  }
}

// Proves the approvedHashes and signedMessages slots the events name and lists the ones still non-zero, plus the
// Transaction Service queue, messages and delegates when the service is on.
export async function pendingStep(run: RunState, now: ConfigNow, history: HistoryRead): Promise<void> {
  await run.step("pending", async (finish) => {
    const approvals = approveHashEvents(history.logs, history.confirmed)
    const messages = [...new Set(signMsgEvents(history.logs, history.confirmed).map((message) => message.hash))]
    const keys = [
      ...approvals.map((approval) => approvedHashSlot(approval.owner, approval.hash)),
      ...messages.map((hash) => signedMessageSlot(hash)),
    ]
    const values = keys.length === 0 ? new Map<Hex, bigint>() : (await run.prove(run.safe, keys)).values
    const slotValue = (key: Hex) => values.get(key.toLowerCase() as Hex) ?? 0n

    const currentNonce = now.config.config.nonce
    const gaps: string[] = []
    const sources: ServiceRef[] = [{ service: "rpc", host: run.deps.reader.pair().primary.host }]
    let queued: QueuedTx[] = []
    let stsMessages: PendingSection["messages"] = []
    let delegates: PendingSection["delegates"] = []
    const service = run.deps.safeTxService
    if (service === null) {
      gaps.push("The Safe Transaction Service is off, so queued transactions, messages and delegates are not listed.")
    } else {
      const [queue, messageList, delegateList] = await Promise.all([
        service.queued(run.safe, currentNonce),
        service.messages(run.safe),
        service.delegates(run.safe),
      ])
      for (const [result, what] of [
        [queue, "queued transactions"],
        [messageList, "messages"],
        [delegateList, "delegates"],
      ] as const) {
        if (result.ok) {
          if (!sources.some((source) => source.host === result.source.host)) sources.push(result.source)
        } else {
          run.issue(result.issue)
          gaps.push(`The Safe Transaction Service ${what} could not be read. ${issueLine(result.issue)}`)
        }
      }
      if (queue.ok) queued = queue.data.map(toQueued)
      if (messageList.ok) {
        stsMessages = messageList.data.map((message) => ({
          hash: message.messageHash,
          confirmations: message.confirmations.length,
          created: cleanUntrusted(message.created, 40),
        }))
      }
      if (delegateList.ok) {
        delegates = delegateList.data.map((delegate) => ({
          delegate: delegate.delegate,
          delegator: delegate.delegator,
          label: cleanUntrusted(delegate.label),
        }))
      }
    }

    const { section, findings } = checkPending({
      currentNonce,
      approvedHashes: approvals.map((approval) => ({
        owner: approval.owner,
        hash: approval.hash,
        slotValue: slotValue(approvedHashSlot(approval.owner, approval.hash)),
        nonce: null,
      })),
      signedMessages: messages.map((hash) => ({ hash, slotValue: slotValue(signedMessageSlot(hash)) })),
      // Only a confirmed execution spends an approval.
      executed: executedHashes(history.logs.filter(history.confirmed)),
      queued,
      messages: stsMessages,
      delegates,
      sources,
    })
    run.addFindings(findings)
    run.setSection(
      "pending",
      gaps.length > 0 ? { state: "partial", data: section, gaps } : { state: "complete", data: section },
    )
    if (gaps.length > 0) finish("degraded", gaps.join(" "))
  })
}
