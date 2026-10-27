import { type Address, getAddress, type Hex, isAddressEqual, pad, toHex } from "viem"
import { eventSlots, formula, rootPass, storageRows } from "@/core/accounting"
import { type DiagnosisContext, diagnose, type UnknownSlot } from "@/core/diagnosis"
import { finding } from "@/core/findings"
import { approveHashEvents, eventAddresses, executedHashes, historyReadRange, signMsgEvents } from "@/core/history"
import type { DiagnosisSection, StorageSection, StorageSlotRow } from "@/core/report"
import { approvedHashSlot, signedMessageSlot } from "@/core/slots"
import type { RunState } from "@/check/state"
import type { ConfigNow, HistoryRead } from "@/check/steps/history"

// Every 32-byte word of `data` whose top 12 bytes are zero and the rest is not: a possible address argument. Used only
// as a preimage candidate, so a word that is not an address costs nothing (it matches no slot).
export function calldataAddresses(data: Hex): Address[] {
  const found: Address[] = []
  const body = data.length > 10 ? data.slice(10) : ""
  for (let offset = 0; offset + 64 <= body.length; offset += 64) {
    const word = body.slice(offset, offset + 64)
    if (/^0{24}/.test(word) && !/^0{64}$/.test(word)) found.push(getAddress(`0x${word.slice(24)}`))
  }
  return found
}

function unconfirmedGap(row: StorageSlotRow): string {
  return `The event behind ${row.technical} was not confirmed by a second RPC, so this slot is not verified.`
}

// Pass 2: every pass-1 slot plus the approvedHashes and signedMessages slots the events name, all in one proven read
// (in tip mode the Safe may have moved since pass 1, so nothing is reused), then the rebuilt root.
export async function storageEventsStep(
  run: RunState,
  storage: StorageSection | null,
  history: HistoryRead,
): Promise<StorageSection | null> {
  if (storage === null || storage.matchedBy !== null || storage.support !== "supported") {
    run.skip(
      "storage-events",
      storage?.matchedBy != null
        ? "Not needed: the storage root matched with the configuration slots."
        : "Not run: the storage root check did not run.",
    )
    return storage
  }
  const result = await run.step("storage-events", async (finish) => {
    const approvals = approveHashEvents(history.logs, history.confirmed)
    const messages = signMsgEvents(history.logs, history.confirmed)
    const extra = eventSlots({
      approvedHashes: approvals,
      signedMessages: [...new Set(messages.map((message) => message.hash))],
    })
    if (extra.length === 0) {
      finish("skipped", "No ApproveHash or SignMsg events, so pass 2 adds nothing.")
      return storage
    }
    const slots = [...run.pass1Slots, ...extra]
    const read = await run.prove(
      run.safe,
      slots.map((slot) => slot.key),
    )
    if (read.account === null) throw new Error("The Safe's account disappeared between two reads")
    const rows = storageRows(slots, {
      values: read.values,
      cross: read.cross.values,
      mismatched: read.cross.mismatched,
    })
    const pass = await rootPass("events", rows, read.account.storageHash)

    // An event slot is benign only when its event is confirmed by a second RPC; otherwise the result is not verified.
    const unconfirmedKeys = new Set<string>([
      ...approvals.filter((a) => !a.confirmed).map((a) => approvedHashSlot(a.owner, a.hash).toLowerCase()),
      ...messages.filter((m) => !m.confirmed).map((m) => signedMessageSlot(m.hash).toLowerCase()),
    ])
    const gaps = rows.filter((row) => unconfirmedKeys.has(row.key.toLowerCase())).map(unconfirmedGap)

    const section: StorageSection = {
      ...storage,
      actualRoot: read.account.storageHash,
      formula: formula(slots, rows),
      passes: [...storage.passes, pass],
      matchedBy: pass.match ? "events" : null,
      slots: rows,
    }
    run.safeAnchor = read.anchor
    run.setStorage(section, gaps)
    if (!pass.match) finish("done", "The event slots did not explain the extra storage either.")
    return section
  })
  return result ?? storage
}

// The creation block when the creation section has it.
function createdAt(run: RunState): bigint | null {
  const creation = run.sections.creation
  return creation?.state === "complete" || creation?.state === "partial" ? BigInt(creation.data.block) : null
}

export type DiagnosisInput = {
  creationTxHash: Hex | null
  // The creation's setup data and inner batch data, whose arguments can name a shadow address written at setup.
  creationData: readonly Hex[]
}

// Diagnosis, after pass 2: enumerate with debug_storageRangeAt when served, else trace the creation and every
// history transaction. Every key found is proven in one read with the known rows, the root is rebuilt, and each extra
// slot is classified by trying the owner, module, approved-hash and signed-message forms for every address and hash
// seen in the config, the events, the creation calldata and the traced accounts. Returns the updated storage section.
export async function diagnosisStep(
  run: RunState,
  storage: StorageSection | null,
  now: ConfigNow,
  history: HistoryRead,
  input: DiagnosisInput,
): Promise<StorageSection | null> {
  if (storage === null || storage.matchedBy !== null || storage.support !== "supported") {
    run.skip(
      "diagnosis",
      storage?.matchedBy != null
        ? "Not needed: every slot is explained."
        : "Not run: the storage root check did not run.",
    )
    return storage
  }
  const result = await run.step("diagnosis", async (finish) => {
    const { logs } = history
    const historySection = run.sections.history
    const approvals = approveHashEvents(logs, history.confirmed)
    const messages = signMsgEvents(logs, history.confirmed)
    const addresses = new Set<Address>([
      ...now.config.config.owners,
      ...now.config.config.modules,
      ...(historySection?.state === "complete" || historySection?.state === "partial"
        ? eventAddresses(historySection.data)
        : []),
      ...approvals.map((approval) => approval.owner),
      ...input.creationData.flatMap(calldataAddresses),
    ])
    const hashes = [...new Set<Hex>([...approvals.map((a) => a.hash), ...messages.map((m) => m.hash)])]

    const expected = new Set(storage.slots.map((row) => row.key.toLowerCase()))
    const steps: DiagnosisSection["steps"] = [
      {
        id: "events",
        status: "nothing-found",
        detail: "Added the approved hashes and signed messages from the history; the root still did not match.",
        missing: [],
      },
    ]

    // (2) Enumerate every slot, when an endpoint serves debug_storageRangeAt.
    let discovered: Hex[] = []
    let by: "enumeration" | "traces" | null = null
    try {
      const range = await run.deps.reader.storageRange(run.safe)
      if (range.complete) {
        by = "enumeration"
        discovered = [...range.values.keys()].filter((key) => !expected.has(key.toLowerCase()))
      }
      steps.push({
        id: "enumeration",
        status: range.complete ? "explained" : "partial",
        detail: range.complete ? "Read every slot directly." : "The node returned a partial slot list.",
        missing: [],
      })
    } catch (error) {
      run.failed(error)
      steps.push({
        id: "enumeration",
        status: "unavailable",
        detail: "This RPC does not serve debug_storageRangeAt.",
        missing: ["storageRange"],
      })
    }

    // (3) Trace the creation and every history transaction for the slots they wrote and the accounts they touched.
    if (by === null) {
      const txHashes = [
        ...new Set<Hex>([
          ...(input.creationTxHash ? [input.creationTxHash] : []),
          ...logs.map((log) => log.transactionHash),
        ]),
      ]
      const written = new Set<Hex>()
      let traced = 0
      let traceGap = false
      for (const hash of txHashes) {
        try {
          const diff = await run.deps.reader.storageDiff(hash)
          for (const account of Object.keys(diff)) addresses.add(getAddress(account))
          const entry = Object.entries(diff).find(([address]) => isAddressEqual(address as Address, run.safe))?.[1]
          for (const key of Object.keys(entry?.post ?? {})) {
            written.add(pad(key as Hex, { size: 32 }).toLowerCase() as Hex)
          }
          traced++
        } catch (error) {
          run.failed(error)
          traceGap = true
          break
        }
      }
      if (traced > 0 && !traceGap) {
        by = "traces"
        discovered = [...written].filter((key) => !expected.has(key))
      }
      steps.push({
        id: "traces",
        status: traced === 0 || traceGap ? "unavailable" : "partial",
        detail:
          traced === 0 || traceGap
            ? "This RPC does not serve prestateTracer in diff mode for every transaction."
            : `Traced ${traced} transactions.`,
        missing: traced === 0 || traceGap ? ["prestateTrace"] : [],
      })
    }

    let section = storage
    let classifiedRows: StorageSlotRow[] = []
    if (by !== null) {
      // One proven read of every known row and every discovered key, then rebuild.
      const keys = [...new Set<Hex>([...storage.slots.map((row) => row.key), ...discovered])]
      const read = await run.prove(run.safe, keys)
      if (read.account === null) throw new Error("The Safe's account disappeared between two reads")
      const value = (key: Hex) => read.values.get(key.toLowerCase() as Hex) ?? 0n
      const known = storage.slots
        .filter((row) => value(row.key) !== 0n)
        .map((row) => ({ ...row, value: toHex(value(row.key), { size: 32 }) }))
      const unknown: UnknownSlot[] = discovered.map((key) => ({ key, value: value(key) }))
      const ctx: DiagnosisContext = {
        owners: now.config.config.owners,
        modules: now.config.config.modules,
        addresses: [...addresses],
        hashes,
        source: by === "enumeration" ? "enumeration" : "trace",
        approvals,
        messages,
        historyRange: historyReadRange(
          historySection ?? { state: "skipped", reason: "" },
          createdAt(run),
          (run.safeAnchor ?? run.anchor!).number,
        ),
        executed: executedHashes(logs.filter(history.confirmed)),
      }
      const classified = diagnose(unknown, ctx)
      classifiedRows = classified.rows
      run.addFindings(classified.findings)
      const pass = await rootPass(by, [...known, ...classified.rows], read.account.storageHash)
      section = {
        ...storage,
        passes: [...storage.passes, pass],
        matchedBy: pass.match ? by : null,
        slots: [...known, ...classified.rows],
      }
      const unconfirmed = new Set(classified.unconfirmed.map((key) => key.toLowerCase()))
      run.setStorage(
        section,
        classified.rows.filter((row) => unconfirmed.has(row.key.toLowerCase())).map(unconfirmedGap),
      )
      const last = steps[steps.length - 1]
      if (pass.match) last.status = "explained"
      last.detail = `${last.detail} ${pass.match ? "Every slot is now found and the root matches." : "The rebuilt root still does not match: some slot was not found."}`
    }

    steps.push({
      id: "candidates",
      status: "nothing-found",
      detail: "Paste addresses or hashes to test them against this Safe.",
      missing: [],
    })
    const unexplained = classifiedRows.filter((row) => row.status === "unexplained" || row.status === "suspicious")
    run.setSection("diagnosis", { steps, unexplained, candidatesTried: [] })
    if (section.matchedBy !== null) finish("done", "Every extra slot was found and classified.")
    else finish("degraded", "Some storage could not be enumerated or traced.")
    return section
  })
  return result ?? storage
}

// After pass 2 and diagnosis: a root that still does not match is one High finding. Not emitted earlier, because a
// later pass can explain the extra storage, and not when pass 2 or diagnosis failed, because the mismatch then rests
// on a read that failed (the verdict says so instead).
export function rootMismatchFinding(run: RunState, storage: StorageSection | null) {
  if (storage === null || storage.support !== "supported" || storage.matchedBy !== null) return
  if ((["storage-events", "diagnosis"] as const).some((id) => run.steps.get(id)?.status === "failed")) return
  const last = storage.passes.at(-1)
  if (last === undefined) return
  run.addFindings([
    finding("unexplained-storage", "storage", {
      technical: `Root rebuilt from ${last.slotCount} slots (${last.by} pass): ${last.expectedRoot}. Proven storage root: ${storage.actualRoot}.`,
    }),
  ])
}
