// The Markdown summary for pasting into reviews, and the plain-language labels the UI shares with it, so both say the
// same words.
import { FINDINGS } from "@/core/findings"
import type {
  AccountKind,
  Comparison,
  FindingCode,
  HandlerSlot,
  HandlersSection,
  Identification,
  Part,
  Report,
  ReportIssue,
  RootMatch,
  ServiceKind,
  Severity,
  SlotSource,
  SlotStatus,
  VerdictKind,
  VerificationSection,
  ZodiacDetails,
} from "@/core/report"

export const VERDICT_LABEL: Record<VerdictKind, string> = {
  explained: "Storage fully explained",
  unexplained: "Unexplained storage",
  unverified: "Could not verify",
}

export const SEVERITY_LABEL: Record<Severity, string> = {
  critical: "Critical",
  high: "High",
  medium: "Medium",
  info: "Info",
}

export const ACCOUNT_KIND_LABEL: Record<AccountKind, string> = {
  eoa: "Plain account (EOA)",
  "delegated-eoa": "Plain account with EIP-7702 delegation",
  contract: "Contract",
  safe: "Safe",
  precompile: "Precompile (cannot sign)",
  none: "No account",
  unknown: "Could not be read",
}

export const SLOT_SOURCE_LABEL: Record<SlotSource, string> = {
  config: "configuration",
  derived: "derived",
  event: "event",
  trace: "trace",
  enumeration: "enumeration",
  candidate: "your candidate",
}

export const SLOT_STATUS_LABEL: Record<SlotStatus, string> = {
  expected: "expected",
  benign: "benign",
  suspicious: "suspicious",
  unexplained: "unexplained",
}

export const ROOT_MATCH_LABEL: Record<RootMatch, string> = {
  config: "configuration slots",
  events: "configuration and event slots",
  enumeration: "every slot listed by the RPC",
  traces: "slots found in transaction traces",
  candidates: "your candidates",
}

export const COMPARISON_LABEL: Record<Comparison, string> = {
  match: "match",
  mismatch: "mismatch",
  "not-served": "not served by the cross-check RPC",
  "not-run": "not compared",
}

export const AGREEMENT_LABEL: Record<VerificationSection["agreement"], string> = {
  agreed: "Two independent RPC operators returned the same block hash and state root.",
  disagreed: "The RPCs returned different data for this block.",
  "single-operator": "Only one RPC operator confirmed this block.",
  "self-trusted": "Verified against your own RPC only (no independent cross-check).",
}

export const SERVICE_LABEL: Record<ServiceKind, string> = {
  rpc: "RPC",
  blockscout: "Blockscout API",
  "safe-tx-service": "Safe Transaction Service",
  etherscan: "Etherscan API",
  sourcify: "Sourcify",
}

const ROLE_LABEL: Record<ReportIssue["role"], string> = {
  primary: "Primary",
  "cross-check": "Cross-check",
  fallback: "Fallback",
  detection: "Detection",
  api: "",
}

// "<Role> RPC <host> could not <operation>: <title>", so an RPC problem always reads as one.
export function issueHeadline(issue: ReportIssue): string {
  const title = issue.title.replace(/\.$/, "")
  const who =
    issue.service === "rpc"
      ? [ROLE_LABEL[issue.role], "RPC", issue.host].filter(Boolean).join(" ")
      : `${SERVICE_LABEL[issue.service]} ${issue.host}`
  return `${who} could not ${issue.operation}: ${title}`
}

export function handlerSlots(handlers: HandlersSection): [string, HandlerSlot][] {
  return [
    ["Guard", handlers.guard],
    ["Module guard", handlers.moduleGuard],
    ["Fallback handler", handlers.fallbackHandler],
  ]
}

// A new run supersedes a cancelled one; nobody needs to read about it.
export function visibleIssues(issues: readonly ReportIssue[]): ReportIssue[] {
  return issues.filter((issue) => issue.kind !== "cancelled")
}

export function identificationLabel(identification: Identification | null): string {
  if (!identification) return "not identified"
  if (identification.status === "unknown") return "unknown code"
  const [first] = identification.matches
  // Reviewed entries can have no version; never leave a double space.
  const name = first ? [first.name, first.version].filter(Boolean).join(" ") : "known code"
  const notes = [
    identification.status === "reviewed" ? "reviewed list" : null,
    identification.via === "eip1167" ? "minimal proxy" : null,
  ].filter((note) => note !== null)
  return notes.length > 0 ? `${name} (${notes.join(", ")})` : name
}

export function flagsLabel(flags: readonly FindingCode[]): string {
  return flags.map((flag) => FINDINGS[flag].title).join(", ")
}

export const PINNED_BY_LABEL: Record<VerificationSection["anchor"]["pinnedBy"], string> = {
  offset: "a recent block (latest minus 3)",
  user: "the block you asked for",
  tip: "the newest block (the RPC proves only the newest state)",
}

// "2026-10-12 11:34:47 UTC" from an ISO time.
export function utcTime(iso: string): string {
  return iso.replace("T", " ").replace(/\.\d+Z$|Z$/, "") + " UTC"
}

const HOUR_MS = 3_600_000

// A block the user or a link asked for, or one more than an hour older than the check, is not the Safe's state now.
export function isPastState(report: Report): boolean {
  const { anchor } = report.verification
  const age = Date.parse(report.createdAt) - Date.parse(anchor.timestamp)
  return anchor.pinnedBy === "user" || age > HOUR_MS
}

export function pastStateLine(report: Report): string {
  const { anchor } = report.verification
  return `This is the state at block ${anchor.number} (${utcTime(anchor.timestamp)}), not the current state.`
}

// The user's own RPCs never read as independent defaults: a pair the user typed in proves nothing about the defaults.
export function ownRpcLine(verification: VerificationSection): string | null {
  const own = [verification.primary, verification.crossCheck].filter((e) => e?.origin === "user").map((e) => e!.host)
  if (own.length === 0) return null
  if (own.length === 2)
    return `Both RPCs are ones you entered (${own.join(" and ")}); no default RPC confirmed this block.`
  return `${verification.primary.origin === "user" ? "The primary" : "The cross-check"} RPC is one you entered (${own[0]}).`
}

// Report strings can hold text from an RPC answer or a contract's return value (an error message, VERSION()). Printed
// raw they could add headings, links, HTML, an unclosed comment that hides the rest, or terminal escapes, so every
// report string goes through here: control characters and line breaks become spaces, Markdown and HTML are escaped.
export function inline(text: string): string {
  return text.replace(CONTROL, " ").replace(/[\\`*_[\]<>!|~#]/g, "\\$&")
}

const CONTROL = /[\p{Cc}\p{Zl}\p{Zp}]+/gu

// A code span that holds any text: the fence is longer than any backtick run inside it.
function code(text: string): string {
  const clean = text.replace(CONTROL, " ")
  const longest = Math.max(0, ...(clean.match(/`+/g) ?? []).map((run) => run.length))
  const fence = "`".repeat(longest + 1)
  const pad = clean.startsWith("`") || clean.endsWith("`") ? " " : ""
  return `${fence}${pad}${clean}${pad}${fence}`
}

const ZERO_ADDRESS = /^0x0{40}$/

// Cells arrive escaped or as code spans; a table still needs every bare pipe escaped, code spans included.
function cell(text: string): string {
  return text.replace(/(?<!\\)\|/g, "\\|")
}

function table(header: string[], rows: string[][]): string[] {
  return [
    `| ${header.join(" | ")} |`,
    `|${header.map(() => "---").join("|")}|`,
    ...rows.map((row) => `| ${row.map(cell).join(" | ")} |`),
  ]
}

// The body of a section, or the line that says why it is missing.
function part<T>(value: Part<T> | null, body: (data: T) => string[]): string[] {
  if (value === null) return []
  switch (value.state) {
    case "complete":
      return body(value.data)
    case "partial":
      return [...body(value.data), "", `Incomplete: ${value.gaps.map(inline).join("; ")}`]
    case "unavailable":
      return [`Not available: ${inline(value.reason)}`]
    case "skipped":
      return [`Skipped: ${inline(value.reason)}`]
  }
}

function section(title: string, lines: string[]): string[] {
  return lines.length === 0 ? [] : ["", `## ${title}`, "", ...lines]
}

function zodiacLine(address: string, z: ZodiacDetails): string {
  const who = (label: string, value: string | null, isSafe: boolean) =>
    `${label} ${value ? `${code(value)}${isSafe ? " (this Safe)" : " (not this Safe)"}` : "not read"}`
  const guard =
    z.guard === "absent" ? "none in this version" : z.guard && !ZERO_ADDRESS.test(z.guard) ? code(z.guard) : "none"
  const parts = [
    who("owner", z.owner, z.ownerIsSafe),
    who("avatar", z.avatar, z.avatarIsSafe),
    who("target", z.target, z.targetIsSafe),
    `guard ${guard}`,
  ]
  if (z.reality) {
    const r = z.reality
    parts.push(
      `oracle ${code(r.oracle)}, template ${inline(r.templateId)}, timeout ${inline(r.timeout)} s, cooldown ${inline(r.cooldown)} s, expiration ${inline(r.expiration)} s, minimum bond ${inline(r.minimumBond)}, arbitrator ${ZERO_ADDRESS.test(r.arbitrator) ? "none" : code(r.arbitrator)}`,
    )
  }
  if (z.modules) parts.push(`its own modules ${z.modules.length === 0 ? "none" : z.modules.map(code).join(", ")}`)
  return `- ${code(address)}: ${parts.join("; ")}; cross-check ${COMPARISON_LABEL[z.cross]}`
}

export const PARTIAL_LABEL = "Stopped: partial result"

export type MarkdownOptions = {
  // The run was stopped: the title says so instead of a verdict.
  partial?: boolean
  // Lines only the page knows, for example a user RPC that was configured but not used.
  notes?: readonly string[]
}

export function reportToMarkdown(report: Report, { partial = false, notes = [] }: MarkdownOptions = {}): string {
  const { verdict, verification, chain } = report
  const anchor = verification.anchor
  const counts = (["critical", "high", "medium", "info"] as const).map((s) => `${verdict.counts[s]} ${s}`).join(", ")
  const own = ownRpcLine(verification)

  const lines = [
    `# Safe State Check: ${partial ? PARTIAL_LABEL : VERDICT_LABEL[verdict.kind]}`,
    "",
    inline(verdict.headline),
    "",
    `- Safe: ${code(report.request.address)} on ${inline(chain.name)} (chain ${chain.chainId})`,
    `- Block: ${anchor.number}, ${utcTime(anchor.timestamp)}, hash ${code(anchor.hash)}`,
    ...(isPastState(report) ? [`- ${pastStateLine(report)}`] : []),
    `- Findings: ${counts}`,
    ...(verification.agreement === "self-trusted" ? [`- Trust: ${AGREEMENT_LABEL["self-trusted"]}`] : []),
    ...(own ? [`- RPCs: ${inline(own)}`] : []),
    ...notes.map((note) => `- ${inline(note)}`),
    ...(verdict.matchedBy ? [`- Root matched with: ${ROOT_MATCH_LABEL[verdict.matchedBy]}`] : []),
  ]

  if (verdict.reasons.length > 0) lines.push("", "Reasons:", ...verdict.reasons.map((r) => `- ${inline(r)}`))
  if (verdict.unverified.length > 0) {
    lines.push("", "Why it could not be verified:", ...verdict.unverified.map((u) => `- ${inline(u.detail)}`))
  }

  lines.push(
    ...section(
      "Summary",
      table(
        ["Item", "Value", "Detail"],
        report.cards.map((c) => [inline(c.label), inline(c.value), inline(c.detail ?? "")]),
      ),
    ),
  )

  lines.push(
    ...section(
      "Findings",
      report.findings.map(
        (f) =>
          `- **${SEVERITY_LABEL[f.severity]}:** ${inline(f.title)}${f.subject ? ` (${code(f.subject)})` : ""}. ${inline(f.technical)}`,
      ),
    ),
  )

  lines.push(
    ...section(
      "Safe contract",
      part(report.identity, (i) => [
        `- Version ${inline(i.version ?? "unknown")}${i.l2 === null ? "" : i.l2 ? " (L2)" : " (not L2)"}${i.supported ? "" : ", not supported"}; VERSION() returns ${i.versionCall === null ? "nothing" : code(i.versionCall)}; latest supported ${inline(i.latestVersion)}`,
        `- Logic contract (singleton, slot 0): ${code(i.singleton.address)} (${inline(identificationLabel(i.singleton.identification))})`,
        `- Proxy code hash: ${code(i.proxy.codeHash)} (${inline(identificationLabel(i.proxy.identification))})`,
      ]),
    ),
  )

  lines.push(
    ...section(
      "Owners",
      part(report.owners, (o) => [
        `Threshold ${inline(o.threshold)} of ${inline(o.ownerCount)}.${o.inertOnly ? " Only placeholder owners: only modules can act." : ""}`,
        "",
        ...table(
          ["Owner", "Type", "Flags"],
          o.owners.map((row) => [
            code(row.address),
            ACCOUNT_KIND_LABEL[row.kind] + (row.delegate ? `, delegates to ${code(row.delegate)}` : ""),
            inline(flagsLabel(row.flags)),
          ]),
        ),
      ]),
    ),
  )

  lines.push(
    ...section(
      "Modules",
      part(report.modules, (m) =>
        m.modules.length === 0
          ? ["No modules."]
          : [
              ...table(
                ["Module", "Identified as", "Flags"],
                m.modules.map((row) => [
                  code(row.address),
                  row.kind === "contract" || row.kind === "safe"
                    ? inline(identificationLabel(row.identification))
                    : ACCOUNT_KIND_LABEL[row.kind],
                  inline(flagsLabel(row.flags)),
                ]),
              ),
              ...(m.modules.some((row) => row.zodiac)
                ? [
                    "",
                    "Zodiac details:",
                    ...m.modules.flatMap((row) => (row.zodiac ? [zodiacLine(row.address, row.zodiac)] : [])),
                  ]
                : []),
            ],
      ),
    ),
  )

  lines.push(
    ...section(
      "Guard and fallback handler",
      part(report.handlers, (h) =>
        table(
          ["Role", "Address", "Identified as", "Set by an event"],
          handlerSlots(h)
            .filter(([, slot]) => slot.applicable)
            .map(([label, slot]) => [
              label,
              slot.address ? code(slot.address) : "not set",
              slot.address ? inline(identificationLabel(slot.identification)) : "",
              slot.address ? slot.announced : "",
            ]),
        ),
      ),
    ),
  )

  lines.push(
    ...section(
      "Storage",
      part(report.storage, (s) => [
        inline(s.formula.text),
        "",
        ...s.passes.map(
          (p) =>
            `- Pass with ${ROOT_MATCH_LABEL[p.by]}: ${p.slotCount} slots, rebuilt root ${code(p.expectedRoot)}, ${p.match ? "match" : "mismatch"}`,
        ),
        `- Actual root: ${s.actualRoot ? code(s.actualRoot) : "not read"}`,
        ...(s.support === "supported" ? [] : [`- Root check not run: ${inline(s.supportReason)}`]),
        "",
        ...table(
          ["Key", "Meaning", "Value", "Source", "Status"],
          s.slots.map((row) => [
            code(row.key),
            `${inline(row.meaning)} (${inline(row.technical)})`,
            code(row.value),
            SLOT_SOURCE_LABEL[row.source],
            SLOT_STATUS_LABEL[row.status] + (row.proven ? "" : ", not proven"),
          ]),
        ),
      ]),
    ),
  )

  lines.push(
    ...section(
      "Creation",
      part(report.creation, (c) => [
        `- Transaction ${code(c.txHash)} in block ${inline(c.block)}, found through ${SERVICE_LABEL[c.source.service]} ${inline(c.source.host)}`,
        `- Factory ${code(c.factory.address)} (${inline(identificationLabel(c.factory.identification))}), ${code(c.factory.method)}`,
        ...(c.setup
          ? [
              `- Setup: threshold ${inline(c.setup.threshold)} of ${c.setup.owners.length}, owners ${c.setup.owners.map(code).join(", ")}`,
              ZERO_ADDRESS.test(c.setup.to)
                ? "- Setup call: none"
                : `- Setup call to ${code(c.setup.to)} (${inline(identificationLabel(c.setup.toIdentification))})`,
              `- Fallback handler at setup: ${code(c.setup.fallbackHandler)}`,
              c.setup.payment === "0"
                ? "- Payment: none"
                : `- Payment ${inline(c.setup.payment)} of ${code(c.setup.paymentToken)} to ${code(c.setup.paymentReceiver)}`,
            ]
          : ["- Setup call not decoded"]),
      ]),
    ),
  )

  lines.push(
    ...section(
      "History",
      part(report.history, (h) => [
        `- Events from ${SERVICE_LABEL[h.source.service]} ${inline(h.source.host)}, blocks ${inline(h.fromBlock)} to ${inline(h.toBlock)}${h.complete ? "" : " (incomplete)"}`,
        `- ${h.configEvents.length} configuration events; executions: ${h.executions.success} succeeded, ${h.executions.failure} failed, ${h.executions.moduleSuccess} by modules`,
        ...h.differences.map((d) => `- ${d.field}: now ${code(d.current)}, from events ${code(d.fromEvents)}`),
      ]),
    ),
  )

  lines.push(
    ...section(
      "Pending actions",
      part(report.pending, (p) => {
        const items = [
          ...p.approvedHashes.map((a) => `- Approved hash ${code(a.hash)} by ${code(a.owner)}`),
          ...p.signedMessages.map((m) => `- Signed message ${code(m.hash)}`),
          ...p.queued.map(
            (q) =>
              `- Queued transaction nonce ${inline(q.nonce)} to ${code(q.to)} (${q.operation}), ${q.confirmations} of ${q.required} signatures`,
          ),
          ...p.messages.map((m) => `- Offchain message ${code(m.hash)}, ${m.confirmations} signatures`),
          ...p.delegates.map(
            (d) => `- Delegate ${code(d.delegate)} for ${code(d.delegator)}${d.label ? ` (${inline(d.label)})` : ""}`,
          ),
        ]
        return items.length > 0 ? items : ["- None found."]
      }),
    ),
  )

  if (report.diagnosis) {
    lines.push(
      ...section("Diagnosis", [
        ...report.diagnosis.steps.map((s) => `- ${s.id}: ${s.status}. ${inline(s.detail)}`),
        ...report.diagnosis.unexplained.map((row) => `- Unexplained slot ${code(row.key)} = ${code(row.value)}`),
      ]),
    )
  }

  const cross = verification.crossCheck
  const coverage = verification.coverage
  const endpoint = (e: NonNullable<typeof cross>) =>
    `${inline(e.host)} (${inline(e.operatorName)}, ${e.origin === "user" ? "entered by you" : "default"})`
  lines.push(
    ...section("Verification", [
      `- Block ${anchor.number}, ${utcTime(anchor.timestamp)}, hash ${code(anchor.hash)}, state root ${code(anchor.stateRoot)}`,
      `- Pinned to ${PINNED_BY_LABEL[anchor.pinnedBy]}.${anchor.note ? ` ${inline(anchor.note)}` : ""}`,
      `- Primary RPC: ${endpoint(verification.primary)}`,
      cross
        ? `- Cross-check RPC: ${endpoint(cross)}`
        : `- Cross-check RPC: none. ${inline(verification.crossCheckMissing ?? "")}`.trim(),
      `- Agreement: ${AGREEMENT_LABEL[verification.agreement]}`,
      `- Cross-check: header ${COMPARISON_LABEL[coverage.header]}, storage root ${COMPARISON_LABEL[coverage.storageRoot]}, slot values ${COMPARISON_LABEL[coverage.slotValues]}, calls ${COMPARISON_LABEL[coverage.calls]}`,
      `- Proofs: ${verification.proofs.accounts} accounts and ${verification.proofs.slots} slots, ${verification.proofs.allVerified ? "all verified" : "not all verified"}${verification.proofs.blocks.length > 1 ? `, at blocks ${verification.proofs.blocks.map(inline).join(", ")}` : ""}`,
      `- Reorg check: ${verification.reorg}`,
    ]),
  )

  const issues = visibleIssues(report.issues).filter((issue) => !issue.recovered)
  lines.push(
    ...section(
      "Problems during the run",
      issues.map((issue) => `- ${inline(issueHeadline(issue))}. ${inline(issue.explanation)}`),
    ),
  )

  lines.push(
    ...section(
      "What this does not check",
      report.notChecked.map((line) => `- ${inline(line)}`),
    ),
  )

  lines.push(
    "",
    `Generated by ${inline(report.tool.name)} ${inline(report.tool.version)}${report.tool.commit ? ` (${inline(report.tool.commit)})` : ""} at ${utcTime(report.createdAt)}.`,
  )
  return lines.join("\n") + "\n"
}
