import { type Address, getAddress, type Hex, isAddressEqual, pad, zeroAddress } from "viem"
import { describeKey } from "@/core/accounting"
import {
  checkCreation,
  creationFromLogs,
  decodeFactoryCall,
  decodeMultiSend,
  decodeSetup,
  describeCall,
  type FactoryCall,
  findFactoryFrame,
} from "@/core/creation"
import { named } from "@/core/registry"
import type { BatchCall, CreationSection, Identification, ReportIssue } from "@/core/report"
import { ioErrorOf } from "@/data/errors"
import type { RawLog, TxRead } from "@/data/types"
import { issueLine, type RunState } from "@/check/state"
import { inspectAccount } from "@/check/steps/accounts"
import { uninspectedGap } from "@/check/steps/inspect"

// Finds the creation transaction, decodes the factory call and `setup` (from a call trace, a direct factory call or
// the factory's L2 event), and checks what setup delegatecalled.
export async function creationStep(run: RunState): Promise<void> {
  await run.step("creation", async (finish) => {
    const unavailable = (reason: string) => {
      run.setSection("creation", { state: "unavailable", reason })
      finish("degraded", reason)
    }
    const anchor = run.anchor!
    const lookup = await run.deps.creation.find(run.safe, anchor.number)
    if (!lookup.found) {
      for (const issue of lookup.issues) run.issue(issue)
      const tried = lookup.tried.map((source) => source.host).join(", ")
      // An RPC that failed to read the transaction an indexer named is not "not found": say which RPC and why.
      const rpcIssue = lookup.issues.find((issue) => issue.service === "rpc")
      unavailable(
        rpcIssue === undefined
          ? `The creation transaction was not found${tried === "" ? "" : ` (tried ${tried})`}.`
          : `The creation transaction could not be read. ${issueLine(rpcIssue)}${tried === "" ? "" : ` Asked: ${tried}.`}`,
      )
      return
    }

    const gaps: string[] = []
    let tx: TxRead
    try {
      tx = await run.deps.reader.transaction(lookup.txHash)
    } catch (error) {
      run.failed(error)
      unavailable(`The creation transaction could not be read. ${issueLine(ioErrorOf(error)!.issue)}`)
      return
    }
    if (tx.cross === "mismatch") {
      unavailable("The two RPCs returned different copies of the creation transaction, so it is not shown.")
      return
    }
    const pair = run.deps.reader.pair()
    const crossHost = pair.crossCheck?.host ?? "unknown"
    if (tx.singleSource) {
      gaps.push(
        `Only the cross-check RPC ${crossHost} had the creation transaction, so one RPC alone read it and nothing was compared.`,
      )
    } else if (tx.cross === "not-served") {
      gaps.push(
        `The cross-check RPC ${crossHost} did not serve the creation transaction, so the primary RPC ${pair.primary.host} alone read it.`,
      )
    }
    let factory: Address | null = null
    let call: FactoryCall | null = null

    try {
      const frame = findFactoryFrame(await run.deps.reader.callTrace(lookup.txHash), run.safe)
      if (frame !== null) {
        // A direct factory call is decoded from the transaction, whose input the cross-check compared.
        call = decodeFactoryCall(tx.to !== null && isAddressEqual(tx.to, frame.to) ? tx.input : frame.input)
        if (call !== null) factory = getAddress(frame.to)
      }
    } catch (error) {
      run.failed(error)
    }

    let logs: RawLog[] = []
    let receiptIssue: ReportIssue | null = null
    try {
      logs = await run.deps.reader.receiptLogs(lookup.txHash)
    } catch (error) {
      run.failed(error)
      receiptIssue = ioErrorOf(error)!.issue
    }
    const fromLogs = creationFromLogs(logs, run.safe)
    // Without a trace, the transaction's input is the factory call only when its receipt shows that factory creating
    // this Safe: an indexer can point at the wrong transaction.
    if (call === null && tx.to !== null && fromLogs.factory !== null && isAddressEqual(tx.to, fromLogs.factory)) {
      call = decodeFactoryCall(tx.input)
      if (call !== null) factory = tx.to
    }
    if (call === null && fromLogs.initializer !== null && fromLogs.singleton !== null) {
      call = {
        method: fromLogs.method ?? "unknown",
        singleton: fromLogs.singleton,
        initializer: fromLogs.initializer,
        saltNonce: fromLogs.saltNonce,
        callback: null,
      }
    }
    factory ??= fromLogs.factory
    if (factory === null) {
      unavailable(
        receiptIssue === null
          ? "The creation transaction was found, but neither a call trace nor its receipt shows it creating this Safe."
          : `The creation transaction was found, but its receipt could not be read, so it cannot be tied to this Safe. ${issueLine(receiptIssue)}`,
      )
      return
    }

    // A failed read is a gap, never "no code": the account gets no finding.
    const unread: Address[] = []
    const identification = async (role: string, address: Address): Promise<Identification | null> => {
      try {
        return (await inspectAccount(run, address)).identification
      } catch (error) {
        run.failed(error)
        unread.push(address)
        gaps.push(uninspectedGap(role, address, error))
        return null
      }
    }

    const setupCall = call === null ? null : decodeSetup(call.initializer)
    if (call !== null && setupCall === null && call.initializer !== "0x")
      gaps.push("The setup call could not be decoded.")
    if (call !== null && call.initializer === "0x")
      gaps.push("The Safe was set up in a later transaction, not at creation.")
    if (call === null) {
      gaps.push(
        "The factory call could not be read: the RPC has no call traces and the transaction did not call the factory directly.",
      )
    }

    const setupTo = setupCall?.to ?? fromLogs.setupEvent?.to ?? null
    const toIdentification =
      setupTo === null || isAddressEqual(setupTo, zeroAddress) ? null : await identification("Setup target", setupTo)
    const multiSend =
      named(run.registry, toIdentification, "MultiSend") || named(run.registry, toIdentification, "MultiSendCallOnly")
    let batch: BatchCall[] | null = null
    if (setupCall !== null && multiSend) {
      const inner = decodeMultiSend(setupCall.data)
      if (inner !== null) {
        batch = await Promise.all(
          inner.map(async (innerCall) => ({
            operation: innerCall.operation,
            to: innerCall.to,
            value: innerCall.value.toString(),
            data: innerCall.data,
            fn: describeCall(innerCall.data),
            identification:
              innerCall.operation === "delegatecall" ? await identification("Setup batch target", innerCall.to) : null,
          })),
        )
      }
    }

    const factoryIdentification = await identification("Factory", factory)
    const callback =
      call?.callback === null || call?.callback === undefined
        ? null
        : { address: call.callback, identification: await identification("Creation callback", call.callback) }

    const checked = checkCreation(run.registry, {
      factory: { address: factory, identification: factoryIdentification },
      callback,
      setup:
        setupTo === null
          ? null
          : {
              to: setupTo,
              toIdentification,
              batch,
              dataKnown: setupCall !== null,
              payment: setupCall?.payment ?? null,
              paymentToken: setupCall?.paymentToken ?? null,
              paymentReceiver: setupCall?.paymentReceiver ?? null,
            },
      unread,
    })
    run.addFindings(checked.findings)
    gaps.push(...checked.gaps)

    const section: CreationSection = {
      txHash: lookup.txHash,
      block: lookup.blockNumber.toString(),
      // The data layer reads no block header other than the anchor's, so the creation time is not known.
      timestamp: null,
      source: lookup.source,
      factory: { address: factory, identification: factoryIdentification, method: call?.method ?? "unknown" },
      singleton: call?.singleton ?? fromLogs.singleton,
      saltNonce: call?.saltNonce?.toString() ?? null,
      callback,
      setup:
        setupCall === null
          ? null
          : {
              owners: [...setupCall.owners],
              threshold: setupCall.threshold.toString(),
              to: setupCall.to,
              data: setupCall.data,
              toIdentification,
              batch,
              fallbackHandler: setupCall.fallbackHandler,
              paymentToken: setupCall.paymentToken,
              payment: setupCall.payment.toString(),
              paymentReceiver: setupCall.paymentReceiver,
            },
      storageDiff: await storageDiff(run, lookup.txHash, [
        ...(setupCall?.owners ?? fromLogs.setupEvent?.owners ?? []),
        ...(batch ?? []).map((inner) => inner.to),
      ]),
    }
    if (gaps.length > 0) {
      run.setSection("creation", { state: "partial", data: section, gaps })
      finish("degraded", gaps.join(" "))
    } else {
      run.setSection("creation", { state: "complete", data: section })
    }
  })
}

// The Safe's storage before and after the creation transaction, when the RPC serves prestateTracer in diff mode.
async function storageDiff(
  run: RunState,
  txHash: Hex,
  addresses: readonly Address[],
): Promise<CreationSection["storageDiff"]> {
  let diff
  try {
    diff = await run.deps.reader.storageDiff(txHash)
  } catch (error) {
    return run.failed(error)
  }
  const entry = Object.entries(diff).find(([address]) => isAddressEqual(address as Address, run.safe))?.[1]
  if (entry === undefined) return []
  const word = (value: Hex | undefined) => pad(value ?? "0x0", { size: 32 })
  const keys = [
    ...new Set([...Object.keys(entry.pre), ...Object.keys(entry.post)].map((key) => pad(key as Hex, { size: 32 }))),
  ]
  const find = (record: Record<Hex, Hex>, key: Hex) =>
    Object.entries(record).find(([k]) => pad(k as Hex, { size: 32 }) === key)?.[1] as Hex | undefined
  return keys.sort().map((key) => ({
    key,
    before: word(find(entry.pre, key)),
    after: word(find(entry.post, key)),
    meaning: describeKey(key, addresses),
  }))
}
