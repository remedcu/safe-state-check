import { SLOTS } from "@/core/constants"
import { SEVERITIES, severityRank, sortFindings, UNVERIFIED_REASONS } from "@/core/findings"
import { SEVERITY_LABEL } from "@/core/markdown"
import { SIGNATURE_CAVEAT } from "@/core/pending"
import { historyReadRange, type ReadRange, readRangeText } from "@/core/history"
import { displayName, SUPPORTED_VERSIONS } from "@/core/registry"
import { slotKey } from "@/core/slots"
import type {
  AccountKind,
  Finding,
  HandlerSlot,
  Report,
  RootMatch,
  SectionId,
  Severity,
  SummaryCard,
  Tone,
  UnverifiedReason,
  Verdict,
  VerificationSection,
} from "@/core/report"

// Everything the verdict and the cards read. Both are functions of these report fields only.
export type VerdictInput = Pick<
  Report,
  | "chain"
  | "findings"
  | "identity"
  | "owners"
  | "modules"
  | "handlers"
  | "storage"
  | "verification"
  | "steps"
  | "issues"
  | "history"
  | "creation"
>

export type UnverifiedItem = { reason: UnverifiedReason; detail: string }

// "The check supports 1.3.0, 1.4.1 and 1.5.0."
export const SUPPORTED_TEXT = `The check supports ${SUPPORTED_VERSIONS.slice(0, -1).join(", ")} and ${SUPPORTED_VERSIONS.at(-1)}.`

// Steps whose failure leaves the verdict without a basis.
const NEEDED_STEPS = ["anchor", "identity", "config", "storage"] as const
// Steps that decide whether a pass-1 mismatch is explained (the event slots, then diagnosis).
const MISMATCH_STEPS = ["storage-events", "diagnosis"] as const
// Steps whose failure leaves accounts uninspected, so a Critical finding may be missing from the counts.
const INSPECTION_STEPS = ["owners", "modules", "handlers"] as const

export function unverifiedReasons(input: VerdictInput): UnverifiedItem[] {
  const items: UnverifiedItem[] = []
  const add = (reason: UnverifiedReason, detail?: string | null) => {
    if (!items.some((item) => item.reason === reason)) {
      items.push({ reason, detail: detail || UNVERIFIED_REASONS[reason] })
    }
  }
  const step = (id: string) => input.steps.find((record) => record.id === id)

  const storage = input.storage
  if (storage.state === "complete" || storage.state === "partial") {
    if (storage.data.support === "unsupported") add("root-check-unsupported", storage.data.supportReason)
    if (storage.data.support === "no-proof-rpc") {
      add("no-proof-rpc", storage.data.supportReason)
      // The chain's proofs work, but no RPC proved this block: every account was read on one RPC's word.
      if (input.chain.rootCheck === "supported") add("unproven-read")
    }
    if (storage.state === "partial") add("read-failed", storage.gaps.join(" "))
    // An approval or signed message whose event lies in the unread part of the history: benign only if that event
    // exists, which nothing read shows.
    const notRead = storage.data.slots.filter((row) => row.eventNotRead).length
    const range = notRead > 0 ? readRange(input) : null
    if (notRead > 0) {
      add(
        "history-incomplete",
        range === null
          ? null
          : `${notRead === 1 ? "One slot looks" : `${notRead} slots look`} like an approval or signed message whose event was not found ${readRangeText(range)}. An RPC that serves the full history settles it.`,
      )
    }
  } else if (input.chain.rootCheck === "unsupported") {
    add("root-check-unsupported", storage.reason)
  } else if (input.chain.rootCheck === "no-proof-rpc") {
    add("no-proof-rpc", storage.reason)
  }

  const verification = input.verification
  if (verification.agreement === "single-operator") add("single-operator", verification.crossCheckMissing)
  const coverage = Object.values(verification.coverage)
  // Any disagreement the reader saw (headers, proofs, code hashes, values, calls, transactions) counts.
  const disagreement = input.issues.find((issue) => issue.kind === "disagreement")
  if (verification.agreement === "disagreed" || coverage.includes("mismatch") || disagreement !== undefined) {
    add("rpc-disagreement", disagreement === undefined ? null : `${disagreement.title}: ${disagreement.explanation}`)
  }
  // On a chain whose proofs are known not to be standard, a proof that does not verify is the chain's format, not an
  // RPC at fault; root-check-unsupported already says so.
  const proofFailed = !verification.proofs.allVerified || input.issues.some((issue) => issue.kind === "proof-invalid")
  if (proofFailed && input.chain.rootCheck !== "unsupported") {
    const host = input.issues.find((issue) => issue.kind === "proof-invalid")?.host
    add("proof-invalid", host === undefined ? null : `${host} sent a proof that did not match the block's state root.`)
  }

  if (input.identity.state === "complete") {
    const { version, supported } = input.identity.data
    if (input.findings.some((f) => f.code === "proxy-not-canonical" || f.code === "singleton-not-canonical")) {
      add("code-not-canonical")
    } else if (!supported && version !== null) {
      add("version-unsupported", `This Safe runs version ${version}. ${SUPPORTED_TEXT}`)
    }
  }

  const reorg = step("reorg")
  if (reorg?.status === "failed") {
    if (verification.reorg === "restarted") add("reorg", reorg.note)
    else add("read-failed", reorg.note ?? "The block hash could not be read again at the end of the check.")
  }
  for (const id of NEEDED_STEPS) {
    const record = step(id)
    if (record?.status === "failed") add("read-failed", record.note)
  }
  // When no pass matched and one of these failed, a red would rest on a read that failed: an RPC that refuses the
  // event slots must not turn a benign Safe red.
  const unmatched =
    storage.state === "complete" && storage.data.support === "supported" && storage.data.matchedBy === null
  for (const id of unmatched ? MISMATCH_STEPS : []) {
    const record = step(id)
    if (record?.status === "failed") add("read-failed", record.note)
  }
  // An owner, module, guard or fallback handler that could not be inspected may hide a Critical finding.
  const uninspected = [input.owners, input.modules, input.handlers].flatMap((part) =>
    part.state === "partial" ? part.gaps : [],
  )
  for (const id of INSPECTION_STEPS) {
    const record = step(id)
    if (record?.status === "failed" && record.note !== null) uninspected.push(record.note)
  }
  if (uninspected.length > 0) add("inspection-incomplete", uninspected.join(" "))
  if (storage.state === "unavailable" || storage.state === "skipped") {
    if (!items.some((item) => item.reason === "root-check-unsupported" || item.reason === "no-proof-rpc")) {
      add("read-failed", storage.reason)
    }
  }
  return items
}

const MATCH_TEXT: Record<RootMatch, string> = {
  config: "the owners, modules and settings",
  events: "the settings plus the approved hashes and signed messages from the event history",
  enumeration: "a list of every slot the RPC enumerated",
  traces: "the slots the Safe's transactions wrote",
  candidates: "the settings plus the candidates you entered",
}

function findingReasons(findings: readonly Finding[], minimum: Severity): string[] {
  return sortFindings(findings)
    .filter((f) => severityRank(f.severity) <= severityRank(minimum))
    .map((f) => `${SEVERITY_LABEL[f.severity]}: ${f.title}.`)
    .filter((reason, index, all) => all.indexOf(reason) === index)
}

// The user trusted their own RPC alone, with no independent cross-check. Said in the verdict reasons and in "what this
// does not check", so it never reads as two-operator verification.
export function selfTrustLine(verification: VerificationSection): string | null {
  if (verification.agreement !== "self-trusted") return null
  return `Checked against your own RPC ${verification.primary.host} only. No independent operator cross-checked the block.`
}

// Run-specific lines of "what this does not check" that come from the verification section.
export function verificationNotChecked(verification: VerificationSection): string[] {
  if (verification.agreement !== "self-trusted") return []
  return [
    `An independent cross-check. The block and every proof were checked against your own RPC ${verification.primary.host} only, which you marked as trusted.`,
  ]
}

const HISTORY_CAVEAT = "The event history is incomplete, so a setting changed without its event cannot be ruled out."

// A red with part of the event history unread, and no hidden owner or module entry among the slots: the extra slots
// are proven to exist, so the red stands, but an approval or signed message whose event was not read may explain
// them. Says how far the history got and what settles it; null when the whole range was read.
function historyHint(input: VerdictInput): string | null {
  if (input.findings.some((f) => f.code === "shadow-owner" || f.code === "shadow-module")) return null
  const range = readRange(input)
  if (range === null) return null
  const settle =
    'Paste its hash or the owner\'s address into "Test candidates", or use an RPC that serves the full history.'
  return range === "none"
    ? `The event history could not be read, so an approval or signed message may explain these slots. ${settle}`
    : `The event history could be read only for blocks ${range.from} to ${range.to}, so an approval or signed message from outside that range may explain these slots. ${settle}`
}

// The part of the history that was read when not all of it (see historyReadRange).
function readRange(input: VerdictInput): ReadRange {
  const creation = input.creation
  const createdAt = creation.state === "complete" || creation.state === "partial" ? BigInt(creation.data.block) : null
  return historyReadRange(input.history, createdAt, BigInt(input.verification.anchor.number))
}

// Precedence: unverified, then unexplained, then explained. A red verdict rests on verified state only, so an RPC that
// lies cannot turn the banner red; a mismatch seen without verification shows as amber with the mismatch as a reason.
export function decideVerdict(input: VerdictInput): Verdict {
  const counts = Object.fromEntries(SEVERITIES.map((s) => [s, 0])) as Record<Severity, number>
  for (const f of input.findings) counts[f.severity]++

  const storage = input.storage.state === "complete" ? input.storage.data : null
  const matchedBy = storage?.matchedBy ?? null
  const unverified = unverifiedReasons(input)

  if (unverified.length > 0) {
    const reasons = unverified.map((item) => item.detail)
    if (storage !== null && storage.passes.length > 0 && matchedBy === null) {
      reasons.push("The rebuilt storage root did not match, but the data behind it is not verified.")
    }
    return {
      kind: "unverified",
      headline: "Something this result rests on could not be read, proven or confirmed; the reasons say what.",
      reasons: reasons.slice(0, 3),
      unverified,
      matchedBy,
      counts,
    }
  }

  // Self-trust and an incomplete history are said in the reasons, whatever the colour: both weaken a green banner.
  const caveats = [
    selfTrustLine(input.verification),
    input.findings.some((f) => f.code === "history-incomplete") ? HISTORY_CAVEAT : null,
  ].filter((line) => line !== null)
  const withTrust = (first: string, rest: string[]) => [first, ...caveats, ...rest].slice(0, 3)

  const odd = storage?.slots.filter((row) => row.status === "suspicious" || row.status === "unexplained") ?? []
  if (storage === null || matchedBy === null || odd.length > 0) {
    const first =
      matchedBy === null
        ? "The storage root does not match any root rebuilt from the configuration, the event history or the slots diagnosis found."
        : `${odd.length === 1 ? "One slot holds" : `${odd.length} slots hold`} data the configuration does not explain.`
    // The history hint replaces the general history caveat, right after the first reason.
    const hint = historyHint(input)
    const rest = findingReasons(input.findings, "high")
    return {
      kind: "unexplained",
      headline: "The Safe holds storage its visible configuration does not account for.",
      reasons:
        hint === null
          ? withTrust(first, rest)
          : [first, hint, ...caveats.filter((line) => line !== HISTORY_CAVEAT), ...rest].slice(0, 3),
      unverified,
      matchedBy,
      counts,
    }
  }

  return {
    kind: "explained",
    headline: "Every storage slot is accounted for by the Safe's visible configuration.",
    reasons: withTrust(
      `The storage root matches the root rebuilt from ${MATCH_TEXT[matchedBy]}.`,
      findingReasons(input.findings, "medium"),
    ),
    unverified,
    matchedBy,
    counts,
  }
}

function toneOf(findings: readonly Finding[], sections: readonly SectionId[], subject?: string | null): Tone {
  const relevant = findings.filter(
    (f) =>
      sections.includes(f.section) && (subject === undefined || f.subject?.toLowerCase() === subject?.toLowerCase()),
  )
  if (relevant.some((f) => f.severity === "critical" || f.severity === "high")) return "bad"
  if (relevant.some((f) => f.severity === "medium")) return "warn"
  return "ok"
}

function plural(count: number, word: string): string {
  return `${count} ${word}${count === 1 ? "" : "s"}`
}

function handlerCard(id: SummaryCard["id"], label: string, slot: HandlerSlot | null, findings: readonly Finding[]) {
  if (slot === null) return { id, label, value: "Not checked", detail: null, tone: "unknown" as const }
  if (!slot.applicable && slot.address === null) {
    return {
      id,
      label,
      value: "Not in this version",
      detail: "Module guards exist from Safe 1.5.0 on.",
      tone: "neutral" as const,
    }
  }
  if (slot.address === null) return { id, label, value: "None", detail: null, tone: "ok" as const }
  if (slot.kind === "unknown")
    return { id, label, value: "Not inspected", detail: slot.address, tone: "unknown" as const }
  const name = displayName(slot.identification)
  const value =
    name ??
    (slot.kind === "eoa" ? "Plain account" : slot.kind === "delegated-eoa" ? "Delegated account" : "Unknown contract")
  return { id, label, value, detail: slot.address, tone: toneOf(findings, ["handlers", "storage"], slot.address) }
}

// The summary cards, pre-rendered so the UI, the Markdown summary and the CLI show the same words.
export function summaryCards(input: VerdictInput): SummaryCard[] {
  const { findings } = input
  const cards: SummaryCard[] = []

  if (input.identity.state === "complete") {
    const identity = input.identity.data
    const canonical = !findings.some((f) => f.code === "proxy-not-canonical" || f.code === "singleton-not-canonical")
    cards.push({
      id: "version",
      label: "Safe version",
      value: identity.version === null ? "Unknown" : `${identity.version}${identity.l2 ? " L2" : ""}`,
      detail: canonical
        ? `${displayName(identity.proxy.identification)} with the ${displayName(identity.singleton.identification)} singleton`
        : "Not a known Safe release",
      tone: !canonical ? "bad" : identity.supported ? "ok" : "warn",
    })
  } else {
    cards.push({ id: "version", label: "Safe version", value: "Not checked", detail: null, tone: "unknown" })
  }

  if (input.owners.state === "complete" || input.owners.state === "partial") {
    const owners = input.owners.data
    const kinds = owners.owners.map((row) => row.kind)
    const words: [AccountKind, string][] = [
      ["eoa", "plain account"],
      ["delegated-eoa", "delegated account"],
      ["safe", "Safe"],
      ["contract", "contract"],
      ["unknown", "not inspected"],
    ]
    const detail = owners.inertOnly
      ? "Only placeholder owners: only modules can act."
      : words
          .map(([kind, word]) => [kinds.filter((k) => k === kind).length, word] as const)
          .filter(([count]) => count > 0)
          .map(([count, word]) => (word === "not inspected" ? `${count} not inspected` : plural(count, word)))
          .join(", ")
    cards.push({
      id: "owners",
      label: "Owners",
      value: `${owners.threshold} of ${owners.ownerCount}`,
      detail: detail === "" ? null : detail,
      tone: owners.inertOnly ? "neutral" : toneOf(findings, ["owners"]),
    })
  } else {
    cards.push({ id: "owners", label: "Owners", value: "Not checked", detail: null, tone: "unknown" })
  }

  if (input.modules.state === "complete" || input.modules.state === "partial") {
    const rows = input.modules.data.modules
    const status = (s: string) => rows.filter((row) => row.identification?.status === s).length
    const plain = rows.filter((row) => row.kind === "eoa" || row.kind === "delegated-eoa").length
    const uninspected = rows.filter((row) => row.kind === "unknown").length
    const detail = [
      status("known") > 0 ? `${status("known")} known` : null,
      status("reviewed") > 0 ? `${status("reviewed")} on the reviewed list` : null,
      status("unknown") > 0 ? `${status("unknown")} unknown` : null,
      plain > 0 ? plural(plain, "plain account") : null,
      uninspected > 0 ? `${uninspected} not inspected` : null,
    ]
      .filter((part) => part !== null)
      .join(", ")
    // A module that could not be inspected may be a plain account: the card is never "ok" then.
    const tone = toneOf(findings, ["modules"])
    cards.push({
      id: "modules",
      label: "Modules",
      value: rows.length === 0 ? "None" : `${rows.length}`,
      detail: detail === "" ? null : detail,
      tone: uninspected > 0 && tone === "ok" ? "unknown" : tone,
    })
  } else {
    cards.push({ id: "modules", label: "Modules", value: "Not checked", detail: null, tone: "unknown" })
  }

  const handlers =
    input.handlers.state === "complete" || input.handlers.state === "partial" ? input.handlers.data : null
  cards.push(handlerCard("guard", "Guard", handlers?.guard ?? null, findings))
  cards.push(handlerCard("moduleGuard", "Module guard", handlers?.moduleGuard ?? null, findings))
  cards.push(handlerCard("fallbackHandler", "Fallback handler", handlers?.fallbackHandler ?? null, findings))

  if (input.storage.state === "complete" || input.storage.state === "partial") {
    const storage = input.storage.data
    const nonce = storage.slots.find((row) => row.key === slotKey(SLOTS.nonce))
    cards.push({
      id: "nonce",
      label: "Nonce",
      value: nonce === undefined ? "0" : BigInt(nonce.value).toString(),
      detail: "Transactions executed with owner signatures",
      tone: "neutral",
    })
    const last = storage.passes.at(-1)
    cards.push({
      id: "storage",
      label: "Storage",
      value: storage.matchedBy !== null ? "Root matches" : last === undefined ? "Not checked" : "Root does not match",
      detail:
        last === undefined
          ? storage.supportReason
          : `${storage.formula.text} Rebuilt root ${last.expectedRoot}, actual root ${storage.actualRoot}.`,
      tone:
        storage.matchedBy !== null
          ? toneOf(findings, ["storage"]) === "bad"
            ? "bad"
            : "ok"
          : last === undefined
            ? "unknown"
            : "bad",
    })
  } else {
    cards.push({ id: "nonce", label: "Nonce", value: "Not checked", detail: null, tone: "unknown" })
    cards.push({ id: "storage", label: "Storage", value: "Not checked", detail: input.storage.reason, tone: "unknown" })
  }
  return cards
}

// "What this does not check", the fixed part. Steps add run-specific lines.
export const NOT_CHECKED: readonly string[] = [
  "What the code does. The Safe's logic, modules, guard and fallback handler are named by their code hash, not audited.",
  "Owner keys. How owners keep their keys, and whether one is compromised.",
  SIGNATURE_CAVEAT,
  "Storage of other contracts. A module's or guard's own settings sit in its own storage, outside this Safe's storage root.",
  "Owners of owners. An owner that is a Safe is shown one level deep; its own setup is not checked.",
  "Token balances and approvals.",
]
