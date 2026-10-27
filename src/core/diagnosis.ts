import { type Address, type Hex, isAddressEqual, toHex } from "viem"
import { SENTINEL } from "@/core/constants"
import { finding } from "@/core/findings"
import { type EventApproval, type EventMessage, type ReadRange, readRangeText } from "@/core/history"
import type { Finding, SlotSource, StorageSlotRow } from "@/core/report"
import { approvedHashSlot, moduleSlot, ownerSlot, signedMessageSlot } from "@/core/slots"

export type SlotClass =
  | { kind: "owner"; address: Address }
  | { kind: "module"; address: Address }
  | { kind: "approved-hash"; owner: Address; hash: Hex }
  | { kind: "signed-message"; hash: Hex }

// Every slot key the config, events and traces can explain, from the addresses and hashes seen in them. A key found
// here but outside the owner or module list is a shadow entry; a key not found here is unexplained.
export function slotIndex(addresses: readonly Address[], hashes: readonly Hex[]): Map<Hex, SlotClass> {
  const index = new Map<Hex, SlotClass>()
  const all = [SENTINEL, ...addresses]
  for (const address of all) {
    index.set(ownerSlot(address).toLowerCase() as Hex, { kind: "owner", address })
    index.set(moduleSlot(address).toLowerCase() as Hex, { kind: "module", address })
  }
  for (const hash of hashes) {
    index.set(signedMessageSlot(hash).toLowerCase() as Hex, { kind: "signed-message", hash })
    for (const owner of all) {
      index.set(approvedHashSlot(owner, hash).toLowerCase() as Hex, { kind: "approved-hash", owner, hash })
    }
  }
  return index
}

export type UnknownSlot = { key: Hex; value: bigint }

export type DiagnosisContext = {
  owners: readonly Address[]
  modules: readonly Address[]
  addresses: readonly Address[]
  hashes: readonly Hex[]
  source: SlotSource
  // The ApproveHash and SignMsg events of the history, which alone make such a slot benign.
  approvals: readonly EventApproval[]
  messages: readonly EventMessage[]
  // The part of the history that was read, when not all of it: a missing event is then not proven missing. Null when
  // the whole range was read.
  historyRange: ReadRange
  // safeTxHashes an ExecutionSuccess in the history that was read has run.
  executed: ReadonlySet<string>
}

function row(
  key: Hex,
  value: bigint,
  meaning: string,
  technical: string,
  source: SlotSource,
  status: StorageSlotRow["status"],
): StorageSlotRow {
  return { key, value: toHex(value, { size: 32 }), meaning, technical, source, status, proven: true, cross: "not-run" }
}

export type Diagnosed = {
  rows: StorageSlotRow[]
  findings: Finding[]
  // Keys made benign by an event that no second RPC confirmed: the result is then not verified.
  unconfirmed: Hex[]
}

// Classifies each still-unexplained slot:
// - an owner or module entry whose address is not in the list is a shadow entry (Critical);
// - an approved hash or signed message is benign only when an event names exactly that owner and hash (or that
//   message hash). Safe's approveHash and SignMessageLib always emit it, so with the whole history read, a slot found
//   only by trying preimages was written directly and acts as a signature nobody gave (Critical). With part of the
//   history unread, its event may lie in that part: the row is marked, the pending finding still applies, and the
//   verdict says the result is not verified;
// - anything left is unexplained storage (High).
export function diagnose(unknown: readonly UnknownSlot[], ctx: DiagnosisContext): Diagnosed {
  const index = slotIndex(ctx.addresses, ctx.hashes)
  const inList = (list: readonly Address[], address: Address) => list.some((entry) => isAddressEqual(entry, address))
  const rows: StorageSlotRow[] = []
  const findings: Finding[] = []
  const unconfirmed: Hex[] = []
  const evidence = (key: Hex, value: bigint) => [{ kind: "slot" as const, key, value: toHex(value, { size: 32 }) }]

  for (const { key, value } of unknown) {
    if (value === 0n) continue
    const found = index.get(key.toLowerCase() as Hex)
    if (found === undefined) {
      rows.push(row(key, value, "Unexplained slot", `storage slot ${key}`, ctx.source, "unexplained"))
      findings.push(
        finding("unexplained-storage", "diagnosis", {
          subject: key,
          technical: `Slot ${key} holds ${toHex(value)} and matches no owner, module, approved hash or signed message seen`,
          evidence: evidence(key, value),
        }),
      )
      continue
    }
    switch (found.kind) {
      case "owner":
      case "module": {
        const list = found.kind === "owner" ? ctx.owners : ctx.modules
        if (inList(list, found.address) || isAddressEqual(found.address, SENTINEL)) {
          // An in-list pointer that reached the unknown set: expected, not a finding.
          rows.push(row(key, value, "List pointer", `${found.kind}s[${found.address}]`, ctx.source, "expected"))
          break
        }
        const code = found.kind === "owner" ? "shadow-owner" : "shadow-module"
        rows.push(
          row(
            key,
            value,
            found.kind === "owner" ? "Hidden owner entry" : "Hidden module entry",
            `${found.kind}s[${found.address}] outside the list`,
            ctx.source,
            "suspicious",
          ),
        )
        findings.push(
          finding(code, "diagnosis", {
            subject: found.address,
            technical: `${found.kind}s[${found.address}] = ${toHex(value)} exists in storage but ${found.address} is not in the ${found.kind} list`,
            evidence: evidence(key, value),
          }),
        )
        break
      }
      case "approved-hash": {
        const event = ctx.approvals.find(
          (approval) =>
            isAddressEqual(approval.owner, found.owner) && approval.hash.toLowerCase() === found.hash.toLowerCase(),
        )
        const technical = `approvedHashes[${found.owner}][${found.hash}]`
        if (event !== undefined) {
          rows.push(row(key, value, "Pre-approved transaction", technical, ctx.source, "benign"))
          if (!event.confirmed) unconfirmed.push(key)
          break
        }
        if (ctx.historyRange !== null) {
          const where = readRangeText(ctx.historyRange)
          rows.push({
            ...row(key, value, "Approval whose event was not read", technical, ctx.source, "benign"),
            eventNotRead: true,
          })
          if (!ctx.executed.has(found.hash.toLowerCase())) {
            findings.push(
              finding("pending-approved-hash", "pending", {
                subject: found.hash,
                technical: `Owner ${found.owner} approved hash ${found.hash} (found by its slot; its ApproveHash event was not found ${where}), and no ExecutionSuccess read has run it`,
                evidence: evidence(key, value),
              }),
            )
          }
          break
        }
        rows.push(row(key, value, "Approval with no event", technical, ctx.source, "suspicious"))
        findings.push(
          finding("approval-without-event", "diagnosis", {
            subject: found.hash,
            technical: `${technical} = ${toHex(value)} but no ApproveHash event names owner ${found.owner} and that hash`,
            evidence: evidence(key, value),
          }),
        )
        break
      }
      case "signed-message": {
        const event = ctx.messages.find((message) => message.hash.toLowerCase() === found.hash.toLowerCase())
        const technical = `signedMessages[${found.hash}]`
        if (event !== undefined) {
          rows.push(row(key, value, "Signed message", technical, ctx.source, "benign"))
          if (!event.confirmed) unconfirmed.push(key)
          break
        }
        if (ctx.historyRange !== null) {
          const where = readRangeText(ctx.historyRange)
          rows.push({
            ...row(key, value, "Signed message whose event was not read", technical, ctx.source, "benign"),
            eventNotRead: true,
          })
          findings.push(
            finding("signed-message", "pending", {
              subject: found.hash,
              technical: `The Safe marked message ${found.hash} as signed (found by its slot; its SignMsg event was not found ${where})`,
              evidence: evidence(key, value),
            }),
          )
          break
        }
        rows.push(row(key, value, "Signed message with no event", technical, ctx.source, "suspicious"))
        findings.push(
          finding("signed-message-without-event", "diagnosis", {
            subject: found.hash,
            technical: `${technical} = ${toHex(value)} but no SignMsg event names that message hash`,
            evidence: evidence(key, value),
          }),
        )
        break
      }
    }
  }
  return { rows, findings, unconfirmed }
}
