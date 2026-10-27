// Classification of every I/O failure into one IssueKind with plain text (docs/ARCHITECTURE.md section 7), and
// redaction of user RPC URLs and API keys. Pure: the transport and the API clients call it.
import { BaseError } from "viem"
import type { IssueKind, RawIoDetail, ReportIssue, ServiceKind } from "@/core/report"
import { IoError, type IssueContext, type RawFailure, type Settings } from "@/data/types"

// Values some texts need. `hint` is one more sentence from the rule that matched.
export type IssueVars = {
  block?: bigint | null
  expectedChainId?: number
  actualChainId?: number | null
  timeoutMs?: number
  // Disagreement: the other host and what differed ("block hashes").
  otherHost?: string
  what?: string
  range?: bigint | null
  waitMs?: number | null
  hint?: string
  // A block the user gave that is past the chain's newest block: their input, not the RPCs, is wrong.
  afterHead?: bigint
  // The key in settings cannot be sent at all (a character outside printable ASCII); nothing reached the service.
  unsendableKey?: boolean
}

export const RAW_TEXT_LIMIT = 500

// Longest Retry-After the transport waits for; a longer one fails as rate-limited with the wait in the text.
export const MAX_RETRY_AFTER_MS = 10_000

const SERVICE_NAMES: Record<ServiceKind, string> = {
  rpc: "the RPC",
  blockscout: "Blockscout",
  "safe-tx-service": "the Safe Transaction Service",
  etherscan: "Etherscan",
  sourcify: "Sourcify",
}

function serviceName(service: ServiceKind, start = false): string {
  const name = SERVICE_NAMES[service]
  return start ? name[0].toUpperCase() + name.slice(1) : name
}

const seconds = (ms: number) => `${Math.round(ms / 100) / 10} s`

type Text = { title: string; explanation: string; actions: string[] }

function text(kind: IssueKind, ctx: IssueContext, v: IssueVars): Text {
  const { host } = ctx
  const rpc = ctx.service === "rpc"
  const block = v.block === undefined || v.block === null ? "the requested block" : `block ${v.block}`
  const hint = v.hint ? ` ${v.hint}` : ""
  const status = ctx.raw.httpStatus
  switch (kind) {
    case "unreachable":
      return {
        title: rpc ? "Could not reach the RPC" : `Could not reach ${serviceName(ctx.service)}`,
        explanation: rpc
          ? `No answer came from ${host}. Most often the RPC does not accept requests from web pages (CORS), or it is down or misspelled.${hint}`
          : `No answer came from ${host}. It may be down, or it does not accept requests from web pages.${hint}`,
        actions: rpc ? ["Pick another RPC.", "Add your own RPC.", "Retry in a minute."] : ["Retry in a minute."],
      }
    case "csp-blocked":
      return {
        title: "Address not allowed",
        explanation: `This site connects only to https:// addresses and to http://localhost or http://127.0.0.1, and ${host} is neither.`,
        actions: ["Use an https RPC, or a node on this computer."],
      }
    case "timeout":
      return {
        title: "No answer in time",
        explanation: `${host} did not answer within ${v.timeoutMs ? seconds(v.timeoutMs) : "the time limit"}.${hint}`,
        actions: rpc ? ["Retry.", "Pick another RPC."] : ["Retry."],
      }
    case "rate-limited":
      return {
        title: "Rate limited",
        explanation:
          `${host} refused more requests from you for now; public ${rpc ? "RPCs" : "services"} limit requests per user.` +
          (v.waitMs ? ` It asked to wait ${seconds(v.waitMs)}, longer than this tool waits.` : "") +
          hint,
        actions: rpc ? ["Wait a minute and retry.", "Add your own RPC."] : ["Wait a minute and retry."],
      }
    case "access-denied":
      return {
        title: "Access denied",
        explanation: `${host} refused the request${status ? ` (HTTP ${status})` : ""}. It may need an API key, or it blocks requests from this site.${hint}`,
        actions: rpc ? ["Pick another RPC.", "Add an RPC with your own key."] : ["Check the key in settings, or skip."],
      }
    case "server-error":
      return {
        title: rpc ? "RPC server error" : "Server error",
        explanation: `${host} failed with an internal error.${hint}`,
        actions: rpc ? ["Retry.", "Pick another RPC."] : ["Retry."],
      }
    case "method-unsupported":
      return {
        title: "Not supported by this RPC",
        explanation: `${host} does not support ${ctx.raw.method}, needed to ${ctx.operation}.${hint}`,
        actions: ["Pick an RPC that supports it; otherwise this part is skipped."],
      }
    case "proof-window":
      return {
        title: "Block too old for this RPC's proofs",
        explanation: `${host} serves storage proofs only for its newest blocks, and ${block} is older.`,
        actions: ["Leave the block empty.", "Pick an archive RPC."],
      }
    case "not-archive":
      return {
        title: "Old state not available",
        explanation: `${host} no longer keeps the state of ${block}.${hint}`,
        actions: ["Use a newer block.", "Pick an archive RPC."],
      }
    case "block-unavailable":
      return v.afterHead !== undefined
        ? {
            title: "Block is in the future",
            explanation: `${capitalize(block)} is after the newest block (${v.afterHead}) on this chain.`,
            actions: ["Check the block number, or leave it empty."],
          }
        : {
            title: "Block not available yet",
            explanation: `${host} does not have ${block} yet; it is behind the chain.`,
            actions: ["Retry.", "Pick another RPC."],
          }
    case "range-too-large":
      return {
        title: "Event range too large",
        explanation: `${host} rejected ${v.range ? `${v.range} blocks` : "this many blocks"} of events in one call. Smaller ranges are tried.`,
        actions: [],
      }
    case "wrong-chain":
      return {
        title: "Wrong chain",
        explanation:
          v.actualChainId !== undefined && v.actualChainId !== null
            ? `${host} serves chain ${v.actualChainId}, not ${v.expectedChainId ?? "the chain asked for"}.`
            : `${host} does not serve chain ${v.expectedChainId ?? "asked for"}.${hint}`,
        actions: ["Check the URL.", "Pick another RPC."],
      }
    case "invalid-response":
      return {
        title: "Unreadable answer",
        explanation:
          status === 404
            ? `${host} answered HTTP 404: there is no ${rpc ? "RPC" : "API"} at this address.`
            : `${host} sent an answer the tool could not read.${hint}`,
        actions: rpc ? ["Check the URL.", "Pick another RPC."] : ["Retry later."],
      }
    case "proof-invalid":
      return {
        title: "Proof did not verify",
        explanation: `The proof from ${host} does not match the block's state root: the RPC sent wrong data, and this run is not verified.`,
        actions: ["Pick another RPC."],
      }
    case "non-mpt":
      return {
        title: "Proofs in another format",
        explanation: `${host} returned proofs that are not Ethereum Merkle Patricia proofs; this chain or this node stores state differently.`,
        actions: ["Pick another RPC; the other checks still run."],
      }
    case "disagreement":
      return {
        title: "RPCs disagree",
        explanation: `${host} and ${v.otherHost ?? "the other RPC"} returned different ${v.what ?? "data"} for ${block}; one is wrong or out of sync.`,
        actions: ["Retry.", "Pick another cross-check RPC."],
      }
    case "reverted":
      return {
        title: "Call reverted",
        explanation: `The call to ${ctx.operation} reverted; usually the contract has no such function. This is often expected.`,
        actions: [],
      }
    case "key-required":
      return rpc
        ? {
            title: "API key needed",
            explanation: `${host} needs an API key or a paid plan for this request.${hint}`,
            actions: ["Pick another RPC.", "Add an RPC with your own key."],
          }
        : {
            title: "API key needed",
            explanation: `${serviceName(ctx.service, true)} needs an API key for this.${hint}`,
            actions: ["Add a key in settings, or skip."],
          }
    case "key-rejected":
      return v.unsendableKey
        ? {
            title: "API key cannot be sent",
            explanation: `The key for ${serviceName(ctx.service)} contains a character that cannot be sent; paste it again.`,
            actions: ["Paste the key again in settings."],
          }
        : {
            title: "API key rejected",
            explanation: `${serviceName(ctx.service, true)} rejected the key.${hint}`,
            actions: ["Check the key in settings."],
          }
    case "plan-unsupported":
      return {
        title: "Not on the free plan",
        explanation: `${rpc ? host : serviceName(ctx.service, true)} does not serve this chain on the free plan.`,
        actions: rpc ? ["Pick another RPC."] : ["Use Blockscout or your own RPC."],
      }
    case "not-found":
      return {
        title: "Not found",
        explanation: `${serviceName(ctx.service, true)} has no record of this.${hint}`,
        actions: [],
      }
    case "cancelled":
      return { title: "Cancelled", explanation: "A new run started.", actions: [] }
    case "unknown":
      // The answer's own words stay in the technical details: an RPC's text must not land in the report's prose.
      return {
        title: "Unexpected error",
        explanation: `${host} failed with an error this tool does not recognise; the technical details show its answer.`,
        actions: rpc ? ["Retry.", "Pick another RPC."] : ["Retry."],
      }
  }
}

const capitalize = (text: string) => text[0].toUpperCase() + text.slice(1)

// Whether the transport may try the same endpoint again.
function transient(kind: IssueKind, failure: RawFailure, message: string, waitMs: number | null): boolean {
  switch (kind) {
    case "unreachable":
      return failure.kind === "fetch-failed" && failure.answeredBefore
    case "rate-limited":
      return waitMs === null
    case "timeout":
    case "server-error":
    case "block-unavailable":
      return true
    case "not-archive":
      // dRPC's "Unknown state" passes on a retry; real pruning does not.
      return /unknown state/i.test(message)
    default:
      return false
  }
}

// Message rules run before code rules: a -32602 that says "proof window" is about the proof window.
const NEGATION =
  /not (currently |yet )?(found|supported|available|whitelisted|whitelist|allowed|implemented|enabled)|unsupported|does not exist|doesn't exist|unknown method/i
const NAMES_A_METHOD = /method|\beth_|\bdebug_|\bweb3_|\bnet_/i

const MESSAGE_RULES: [RegExp, IssueKind][] = [
  [/proof window|distance to target block|historical proof|oldest allowed block/i, "proof-window"],
  [
    /block range|blocks range|range (is )?too (large|big|wide)|ranges? over|exceeds? .*range|max(imum)? (block )?range|query returned more than|more than \d+ (results|logs)|too many (results|logs)|response size/i,
    "range-too-large",
  ],
  [
    /rate.?limit|usage limit|quota|too many requests|limit exceeded|maximum api usage|request limit|throttl/i,
    "rate-limited",
  ],
  // "Archive requests require a personal token" (PublicNode) is about a key, not about pruned state.
  [/personal token|token is required/i, "key-required"],
  [
    /missing trie node|unknown state|historical (state|version)|no state available|state .*not available|archive|pruned|state already discarded/i,
    "not-archive",
  ],
  [
    /header (not found|does not exist)|unknown block|block not found|block .*not found|block .*(does not|doesn't) exist|after last accepted block|requested block .*(in the future|not (yet )?available)/i,
    "block-unavailable",
  ],
  [
    /unknown network|network not (active|supported|found)|unsupported network|chain (is )?not supported/i,
    "wrong-chain",
  ],
  // A bare "not available" answers the method that was called (1RPC on Fantom for eth_getProof).
  [
    /not part of the official rpc api|different storage layout|^\s*(not (supported|available|allowed)|unsupported)\s*$/i,
    "method-unsupported",
  ],
  [/invalid api.?key|api.?key (is )?(invalid|rejected|not valid)/i, "key-rejected"],
  [/missing api.?key|api.?key (is )?required|requires? an api.?key|proceed with api.?key/i, "key-required"],
  [/timeout|timed out/i, "timeout"],
  [/free (api )?(access|plan)|paid (subscription )?plan/i, "plan-unsupported"],
  [/execution reverted|\brevert/i, "reverted"],
  [
    /api.?key|unauthori[sz]ed|forbidden|access denied|not authori[sz]ed|invalid token|origin not allowed|blocked/i,
    "access-denied",
  ],
  [
    /internal error|crashed|panic|route your request|cannot route|suitable provider|upstream|temporar|bad gateway|service unavailable|cannot find .*store/i,
    "server-error",
  ],
]

// "method is not available on the free plan" is about the method, not the plan.
const WEAKER_THAN_METHOD: ReadonlySet<IssueKind> = new Set([
  "timeout",
  "plan-unsupported",
  "access-denied",
  "server-error",
])

function byMessage(message: string): IssueKind | null {
  // HTML error pages hold arbitrary words; their status code decides.
  if (!message || message.trimStart().startsWith("<")) return null
  // A method rule needs the method named, so "unsupported platform" stays an access problem.
  const namesMethod = NEGATION.test(message) && NAMES_A_METHOD.test(message)
  for (const [pattern, kind] of MESSAGE_RULES) {
    if (!pattern.test(message)) continue
    return namesMethod && WEAKER_THAN_METHOD.has(kind) ? "method-unsupported" : kind
  }
  return namesMethod ? "method-unsupported" : null
}

function byRpcCode(code: number | null): IssueKind | null {
  switch (code) {
    case 3:
      return "reverted"
    case -32005:
      return "rate-limited"
    case -32601:
    case -32004:
      return "method-unsupported"
    case -32603:
      return "server-error"
    default:
      return null
  }
}

function byHttpStatus(status: number | null, service: ServiceKind): IssueKind | null {
  if (status === null) return null
  if (status === 429) return "rate-limited"
  if (status === 401 || status === 403) return "access-denied"
  if (status === 402) return "key-required"
  if (status === 408) return "timeout"
  if (status >= 500) return "server-error"
  if (status === 404 && service !== "rpc") return "not-found"
  if (status >= 300) return "invalid-response"
  return null
}

// A JSON-RPC error inside an HTTP error body (dRPC answers 400 with {"error":{"code":27,"message":"Unknown state"}}).
function rpcErrorInBody(body: string): { code: number | null; message: string } | null {
  try {
    const parsed: unknown = JSON.parse(body)
    if (typeof parsed !== "object" || parsed === null) return null
    const error = (parsed as { error?: unknown }).error
    const inner = typeof error === "object" && error !== null ? error : parsed
    const message = (inner as { message?: unknown }).message
    const code = (inner as { code?: unknown }).code
    if (typeof message !== "string" && typeof error !== "string") return null
    return {
      code: typeof code === "number" ? code : null,
      message: typeof message === "string" ? message : (error as string),
    }
  } catch {
    return null
  }
}

type Classified = { kind: IssueKind; message: string; code: number | null; status: number | null; body: string | null }

function kindOf(failure: RawFailure, service: ServiceKind): Classified {
  const base = { message: "", code: null, status: null, body: null }
  switch (failure.kind) {
    case "csp":
      return { ...base, kind: "csp-blocked" }
    case "aborted":
      return { ...base, kind: "cancelled" }
    case "timeout":
      return { ...base, kind: "timeout" }
    case "fetch-failed":
      return { ...base, kind: "unreachable", message: failure.message }
    case "shape":
      return { ...base, kind: "invalid-response", message: failure.message }
    case "json":
      return { ...base, kind: "invalid-response", body: failure.body }
    case "rpc": {
      const kind = byMessage(failure.message) ?? byRpcCode(failure.code) ?? "unknown"
      return { ...base, kind, message: failure.message, code: failure.code }
    }
    case "http": {
      const inner = rpcErrorInBody(failure.body)
      const message = inner?.message ?? failure.body
      const kind =
        byMessage(message) ??
        byRpcCode(inner?.code ?? null) ??
        byHttpStatus(failure.status, service) ??
        (inner ? "unknown" : "invalid-response")
      return {
        kind,
        message: inner?.message ?? "",
        code: inner?.code ?? null,
        status: failure.status,
        body: failure.body,
      }
    }
    case "api": {
      const kind = byMessage(failure.message) ?? byHttpStatus(failure.status, service) ?? "unknown"
      return { ...base, kind, message: failure.message, status: failure.status }
    }
  }
}

const cut = (value: string | null) => (value === null ? null : value.slice(0, RAW_TEXT_LIMIT))

// Builds the issue for a kind the caller already knows (wrong chain, disagreement, proof checks, API answers).
export function makeIssue(kind: IssueKind, ctx: IssueContext, vars: IssueVars = {}, isTransient = false): ReportIssue {
  return {
    kind,
    ...text(kind, ctx, vars),
    service: ctx.service,
    host: ctx.host,
    role: ctx.role,
    operation: ctx.operation,
    step: null,
    transient: isTransient,
    recovered: false,
    raw: { ...ctx.raw, message: cut(ctx.raw.message), body: cut(ctx.raw.body) },
  }
}

// One failure, one kind. `ctx.raw` should already be redacted; the failure's message and body are copied into it.
export function classify(failure: RawFailure, ctx: IssueContext, vars: IssueVars = {}): ReportIssue {
  const found = kindOf(failure, ctx.service)
  const waitMs =
    found.kind === "rate-limited" &&
    failure.kind === "http" &&
    failure.retryAfterMs !== null &&
    failure.retryAfterMs > MAX_RETRY_AFTER_MS
      ? failure.retryAfterMs
      : null
  const raw: RawIoDetail = {
    ...ctx.raw,
    httpStatus: ctx.raw.httpStatus ?? found.status,
    rpcCode: ctx.raw.rpcCode ?? found.code,
    message: ctx.raw.message ?? (found.message || null),
    body: ctx.raw.body ?? found.body,
  }
  const hints: IssueVars = { ...vars }
  if (found.kind === "unreachable" && failure.kind === "fetch-failed" && failure.answeredBefore) {
    hints.hint ??= "It answered earlier in this run, so it is probably rate limiting you without saying so."
  }
  if (found.kind === "method-unsupported" && /free plan|paid plan/i.test(found.message)) {
    hints.hint ??= "It is not on the provider's free plan."
  }
  if (found.kind === "timeout" && failure.kind === "timeout") hints.timeoutMs ??= failure.afterMs
  return makeIssue(
    found.kind,
    { ...ctx, raw },
    { ...hints, waitMs },
    transient(found.kind, failure, found.message, waitMs),
  )
}

// The IoError inside anything thrown through viem, or null.
export function ioErrorOf(error: unknown): IoError | null {
  if (error instanceof IoError) return error
  if (error instanceof BaseError) {
    const found = error.walk((e) => e instanceof IoError)
    return found instanceof IoError ? found : null
  }
  return null
}

// The issue of an IoError; anything else is a bug and is rethrown.
export function issueOf(error: unknown): ReportIssue {
  const io = ioErrorOf(error)
  if (!io) throw error
  return io.issue
}

// Kinds that are about one endpoint: the reader repeats the read on the next endpoint (section 6.8).
export const ENDPOINT_KINDS: ReadonlySet<IssueKind> = new Set<IssueKind>([
  "unreachable",
  "timeout",
  "rate-limited",
  "access-denied",
  "server-error",
  "method-unsupported",
  "proof-window",
  "not-archive",
  "block-unavailable",
  "wrong-chain",
  "invalid-response",
  "non-mpt",
  "proof-invalid",
  "plan-unsupported",
  "key-required",
  "key-rejected",
  // A pruned transaction index answers null for old transactions; the next RPC may have them.
  "not-found",
  "unknown",
])

// ---------------------------------------------------------------------------------------------------------------
// Redaction

export const REDACTED = "[redacted]"

// What must never leave settings and the transport: the path, query and credentials of every user RPC, and API keys.
export function secretsOf(settings: Settings): string[] {
  const secrets = new Set<string>()
  for (const chain of Object.values(settings.rpcs)) {
    for (const url of [chain.primary, chain.crossCheck]) {
      if (!url) continue
      secrets.add(url)
      try {
        const parsed = new URL(url)
        const rest = `${parsed.pathname}${parsed.search}${parsed.hash}`
        if (rest !== "/" && rest !== "") secrets.add(rest)
        for (const part of [parsed.pathname.slice(1), parsed.search.slice(1), parsed.username, parsed.password]) {
          if (part.length >= 4) secrets.add(part)
        }
        for (const value of parsed.searchParams.values()) if (value.length >= 4) secrets.add(value)
        // Each path segment alone too: an error that echoes only the key from "/v3/<key>" must not keep it.
        for (const segment of parsed.pathname.split("/")) if (segment.length >= 8) secrets.add(segment)
      } catch {
        // Not a URL: the whole string stays secret.
      }
    }
  }
  for (const key of [settings.safeTxService.apiKey, settings.etherscan.apiKey]) {
    if (key) secrets.add(key)
  }
  return [...secrets].flatMap((s) => [s, encodeURIComponent(s)]).sort((a, b) => b.length - a.length)
}

export function redactWith(textIn: string, secrets: readonly string[]): string {
  let out = textIn
  for (const secret of secrets) if (secret) out = out.split(secret).join(REDACTED)
  return out
}

export function redact(textIn: string, settings: Settings): string {
  return redactWith(textIn, secretsOf(settings))
}

// `raw.url`: the full URL of a default RPC (public, in the repo), only the origin of a user RPC, and any API URL
// without its `apikey` parameter.
export function rawUrl(url: string, origin: "default" | "user"): string {
  try {
    const parsed = new URL(url)
    if (origin === "user") return parsed.origin
    parsed.searchParams.delete("apikey")
    return parsed.toString()
  } catch {
    return origin === "user" ? REDACTED : url
  }
}
