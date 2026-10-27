// The one place that talks to the network: a fetch JSON-RPC client (one object per POST, never a batch), JSON GETs for
// the APIs, timeouts, retries with backoff, per-host and total limits, the call log, classification and redaction.
// viem runs on top of it through `custom()` with `retryCount: 0`, so its actions and formatters stay while retries and
// errors are ours (docs/ARCHITECTURE.md section 6.2).
import { createPublicClient, custom, type PublicClient } from "viem"
import type { EndpointRole, IssueKind, RawIoDetail, ReportIssue, ServiceKind, StepId } from "@/core/report"
import { classify, type IssueVars, makeIssue, MAX_RETRY_AFTER_MS, rawUrl, redactWith } from "@/data/errors"
import { NODE_USER_AGENT } from "@/data/constants"
import { allowedRpcUrl } from "@/data/settings"
import { type Endpoint, IoError, type IssueContext, type RawFailure } from "@/data/types"

export const TIMEOUTS = { call: 15_000, slow: 30_000, detection: 6_000, api: 20_000 } as const
export const LIMITS = { perHost: 4, total: 12 } as const
export const RETRY = { attempts: 3, backoffMs: [500, 1_500], jitterMs: 250 } as const

// eth_getLogs and debug_* scan or replay; they get the long timeout.
export function timeoutFor(method: string): number {
  return method === "eth_getLogs" || method.startsWith("debug_") ? TIMEOUTS.slow : TIMEOUTS.call
}

export type CallContext = {
  role: EndpointRole
  // Plain words: "read the Safe's storage proof".
  operation: string
  step?: StepId | null
  timeoutMs?: number
  attempts?: number
  vars?: IssueVars
}

export type CallLogEntry = {
  at: string
  host: string
  service: ServiceKind
  method: string
  role: EndpointRole
  elapsedMs: number
  attempts: number
  outcome: "ok" | IssueKind
}

export type TransportOptions = {
  fetch?: typeof fetch
  // The run's signal: aborting it cancels everything, queued requests included.
  signal?: AbortSignal
  // From `secretsOf(settings)`: replaced in every raw message, body and parameter list.
  secrets?: readonly string[]
  limits?: { perHost: number; total: number }
  maxBytes?: { default: number; slow: number }
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>
  random?: () => number
  now?: () => number
}

export type ApiRequest = {
  service: ServiceKind
  operation: string
  headers?: Record<string, string>
  // Statuses returned to the caller instead of thrown (Sourcify answers 404 for "not verified").
  accept?: number[]
  timeoutMs?: number
  step?: StepId | null
}

export type ApiResponse = { status: number; body: unknown }

class Semaphore {
  private active = 0
  private readonly queue: (() => void)[] = []
  private readonly max: number

  constructor(max: number) {
    this.max = max
  }

  async acquire(signal?: AbortSignal): Promise<void> {
    if (this.active < this.max) {
      this.active++
      return
    }
    await new Promise<void>((resolve, reject) => {
      const onAbort = () => {
        const index = this.queue.indexOf(grant)
        if (index >= 0) this.queue.splice(index, 1)
        reject(new DOMException("Aborted", "AbortError"))
      }
      const grant = () => {
        signal?.removeEventListener("abort", onAbort)
        resolve()
      }
      if (signal?.aborted) return onAbort()
      signal?.addEventListener("abort", onAbort, { once: true })
      this.queue.push(grant)
    })
    this.active++
  }

  release(): void {
    this.active--
    this.queue.shift()?.()
  }
}

function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new DOMException("Aborted", "AbortError"))
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort)
      resolve()
    }, ms)
    const onAbort = () => {
      clearTimeout(timer)
      reject(new DOMException("Aborted", "AbortError"))
    }
    signal?.addEventListener("abort", onAbort, { once: true })
  })
}

// Retry-After in seconds or as an HTTP date.
export function parseRetryAfter(value: string | null, now: number): number | null {
  if (!value) return null
  if (/^\d+$/.test(value.trim())) return Number(value.trim()) * 1_000
  const date = Date.parse(value)
  return Number.isNaN(date) ? null : Math.max(0, date - now)
}

// Largest answer read: 32 MB, and 128 MB for eth_getLogs and debug_* (a hostile RPC could otherwise exhaust the tab).
export const MAX_RESPONSE_BYTES = { default: 32 * 1024 * 1024, slow: 128 * 1024 * 1024 } as const

// Node's own User-Agent ("node") is refused by Blockscout on some chains; a browser sets its own and must not be given
// one (setting it can force a CORS preflight).
const inNode =
  typeof (globalThis as { process?: { versions?: { node?: string } } }).process?.versions?.node === "string"
const NODE_HEADERS: Record<string, string> =
  inNode && (globalThis as { window?: unknown }).window === undefined ? { "user-agent": NODE_USER_AGENT } : {}

type Target = { url: string; host: string; origin: "default" | "user"; service: ServiceKind }

// `tooLarge`: the answer passed the size cap and was not read.
type Attempt =
  | { ok: true; value: unknown; status: number }
  | { ok: false; failure: RawFailure; status: number | null; tooLarge?: number }

// The body as text, or null once it passes `limit` bytes (the rest is not read).
async function readCapped(res: Response, limit: number): Promise<string | null> {
  const declared = Number(res.headers.get("content-length"))
  if (Number.isFinite(declared) && declared > limit) {
    await res.body?.cancel().catch(() => undefined)
    return null
  }
  if (!res.body) return res.text()
  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let total = 0
  let text = ""
  for (;;) {
    const { done, value } = await reader.read()
    if (done) return text + decoder.decode()
    total += value.byteLength
    if (total > limit) {
      await reader.cancel().catch(() => undefined)
      return null
    }
    text += decoder.decode(value, { stream: true })
  }
}

const sizeText = (bytes: number) => (bytes >= 1024 * 1024 ? `${bytes / 1024 / 1024} MB` : `${bytes} bytes`)

const tooLarge = (limit: number): Attempt => ({
  ok: false,
  failure: { kind: "shape", message: `The answer is larger than ${sizeText(limit)}.` },
  status: null,
  tooLarge: limit,
})

let nextId = 1

export class Transport {
  readonly log: CallLogEntry[] = []
  private readonly fetchFn: typeof fetch
  private readonly signal: AbortSignal | undefined
  private readonly secrets: readonly string[]
  private readonly sleep: (ms: number, signal?: AbortSignal) => Promise<void>
  private readonly random: () => number
  private readonly now: () => number
  private readonly perHostMax: number
  private readonly maxBytes: { default: number; slow: number }
  private readonly total: Semaphore
  private readonly perHost = new Map<string, Semaphore>()
  // Hosts that sent any HTTP answer in this run: a later network failure there is probably a silent rate limit.
  private readonly answered = new Set<string>()

  constructor(options: TransportOptions = {}) {
    this.fetchFn = options.fetch ?? ((input, init) => globalThis.fetch(input, init))
    this.signal = options.signal
    this.secrets = options.secrets ?? []
    this.sleep = options.sleep ?? defaultSleep
    this.random = options.random ?? Math.random
    this.now = options.now ?? Date.now
    this.maxBytes = options.maxBytes ?? MAX_RESPONSE_BYTES
    const limits = options.limits ?? LIMITS
    this.perHostMax = limits.perHost
    this.total = new Semaphore(limits.total)
  }

  get aborted(): boolean {
    return this.signal?.aborted ?? false
  }

  redact(text: string): string {
    return redactWith(text, this.secrets)
  }

  // One JSON-RPC call. Resolves with `result` (which may be null) or throws IoError.
  async rpc(endpoint: Endpoint, method: string, params: readonly unknown[], ctx: CallContext): Promise<unknown> {
    const body = JSON.stringify({ jsonrpc: "2.0", id: nextId++, method, params })
    const target: Target = { url: endpoint.url, host: endpoint.host, origin: endpoint.origin, service: "rpc" }
    return this.run(target, method, JSON.stringify(params), ctx, async (signal) => {
      const res = await this.fetchFn(endpoint.url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body,
        credentials: "omit",
        signal,
      })
      const limit = timeoutFor(method) === TIMEOUTS.slow ? this.maxBytes.slow : this.maxBytes.default
      const text = await readCapped(res, limit)
      return text === null ? tooLarge(limit) : this.readRpc(res, text)
    })
  }

  // A JSON GET against an API. Statuses in `accept` come back to the caller; any other non-2xx throws IoError.
  async api(url: string, request: ApiRequest): Promise<ApiResponse> {
    const host = new URL(url).host
    const target: Target = { url, host, origin: "default", service: request.service }
    const ctx: CallContext = {
      role: "api",
      operation: request.operation,
      step: request.step,
      timeoutMs: request.timeoutMs ?? TIMEOUTS.api,
    }
    const result = await this.run(target, "GET", null, ctx, async (signal) => {
      const res = await this.fetchFn(url, {
        method: "GET",
        headers: { accept: "application/json", ...NODE_HEADERS, ...request.headers },
        credentials: "omit",
        signal,
      })
      const text = await readCapped(res, this.maxBytes.default)
      if (text === null) return tooLarge(this.maxBytes.default)
      if (!res.ok && !request.accept?.includes(res.status)) {
        return { ok: false, failure: this.httpFailure(res, text), status: res.status } satisfies Attempt
      }
      try {
        return { ok: true, value: { status: res.status, body: text ? JSON.parse(text) : null }, status: res.status }
      } catch {
        return { ok: false, failure: { kind: "json", body: text }, status: res.status } satisfies Attempt
      }
    })
    return result as ApiResponse
  }

  // An issue the caller found in an answer that arrived fine (wrong chain, bad proof, code hash mismatch).
  issue(
    kind: IssueKind,
    endpoint: Endpoint,
    method: string,
    ctx: CallContext,
    message: string | null = null,
  ): ReportIssue {
    const issueCtx: IssueContext = {
      service: "rpc",
      host: endpoint.host,
      role: ctx.role,
      operation: ctx.operation,
      raw: {
        url: this.redact(rawUrl(endpoint.url, endpoint.origin)),
        method,
        params: null,
        httpStatus: null,
        rpcCode: null,
        message: message === null ? null : this.redact(message),
        body: null,
        elapsedMs: 0,
        attempts: 1,
        at: new Date(this.now()).toISOString(),
      },
    }
    return { ...makeIssue(kind, issueCtx, ctx.vars), step: ctx.step ?? null }
  }

  // An API that answered fine at the HTTP level but reported an error in its body (Etherscan's `status: "0"`).
  apiIssue(
    url: string,
    service: ServiceKind,
    operation: string,
    message: string,
    status: number | null,
    known?: { kind: IssueKind; vars: IssueVars },
  ): ReportIssue {
    const issueCtx: IssueContext = {
      service,
      host: new URL(url).host,
      role: "api",
      operation,
      raw: {
        url: this.redact(rawUrl(url, "default")),
        method: "GET",
        params: null,
        httpStatus: status,
        rpcCode: null,
        message: null,
        body: null,
        elapsedMs: 0,
        attempts: 1,
        at: new Date(this.now()).toISOString(),
      },
    }
    if (known) return makeIssue(known.kind, { ...issueCtx, raw: { ...issueCtx.raw, message } }, known.vars)
    return classify({ kind: "api", message: this.redact(message), status }, issueCtx)
  }

  // A viem client whose every request goes through `rpc` with this context.
  client(endpoint: Endpoint, ctx: CallContext): PublicClient {
    return createPublicClient({
      transport: custom(
        {
          request: ({ method, params }: { method: string; params?: unknown[] }) =>
            this.rpc(endpoint, method, params ?? [], ctx),
        },
        { retryCount: 0 },
      ),
    })
  }

  private readRpc(res: Response, text: string): Attempt {
    if (!res.ok) return { ok: false, failure: this.httpFailure(res, text), status: res.status }
    let parsed: unknown
    try {
      parsed = JSON.parse(text)
    } catch {
      return { ok: false, failure: { kind: "json", body: text }, status: res.status }
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return {
        ok: false,
        failure: { kind: "shape", message: "The answer is not one JSON-RPC object." },
        status: res.status,
      }
    }
    const answer = parsed as { result?: unknown; error?: { code?: unknown; message?: unknown; data?: unknown } }
    if (answer.error !== undefined && answer.error !== null) {
      const { code, message, data } = answer.error
      return {
        ok: false,
        failure: {
          kind: "rpc",
          code: typeof code === "number" ? code : 0,
          message: typeof message === "string" ? message : JSON.stringify(answer.error),
          data: data ?? null,
        },
        status: res.status,
      }
    }
    if (!("result" in answer)) {
      return {
        ok: false,
        failure: { kind: "shape", message: "The answer has neither result nor error." },
        status: res.status,
      }
    }
    return { ok: true, value: answer.result, status: res.status }
  }

  private httpFailure(res: Response, body: string): RawFailure {
    return {
      kind: "http",
      status: res.status,
      body,
      retryAfterMs: parseRetryAfter(res.headers.get("retry-after"), this.now()),
    }
  }

  private semaphore(host: string): Semaphore {
    let semaphore = this.perHost.get(host)
    if (!semaphore) this.perHost.set(host, (semaphore = new Semaphore(this.perHostMax)))
    return semaphore
  }

  // Timeouts, retries, limits, logging and classification around one request.
  private async run(
    target: Target,
    method: string,
    params: string | null,
    ctx: CallContext,
    send: (signal: AbortSignal) => Promise<Attempt>,
  ): Promise<unknown> {
    const started = this.now()
    const timeoutMs = ctx.timeoutMs ?? (target.service === "rpc" ? timeoutFor(method) : TIMEOUTS.api)
    const maxAttempts = ctx.attempts ?? RETRY.attempts
    const raw = (attempts: number): RawIoDetail => ({
      url: this.redact(rawUrl(target.url, target.origin)),
      method,
      params: params === null ? null : this.redact(params).slice(0, 500),
      httpStatus: null,
      rpcCode: null,
      message: null,
      body: null,
      elapsedMs: this.now() - started,
      attempts,
      at: new Date(started).toISOString(),
    })
    const fail = (failure: RawFailure, attempts: number, extra: Partial<RawIoDetail> = {}, limit?: number) => {
      const issueCtx: IssueContext = {
        service: target.service,
        host: target.host,
        role: ctx.role,
        operation: ctx.operation,
        raw: { ...raw(attempts), ...extra },
      }
      const hint = limit ? { hint: `Its answer was larger than ${sizeText(limit)}, so it was not read.` } : {}
      const issue = classify(this.redactFailure(failure), issueCtx, { timeoutMs, ...ctx.vars, ...hint })
      return { ...issue, step: ctx.step ?? null }
    }
    const record = (attempts: number, outcome: CallLogEntry["outcome"]) =>
      this.log.push({
        at: new Date(started).toISOString(),
        host: target.host,
        service: target.service,
        method,
        role: ctx.role,
        elapsedMs: this.now() - started,
        attempts,
        outcome,
      })

    if (!allowedRpcUrl(target.url)) {
      const issue = fail({ kind: "csp", url: rawUrl(target.url, target.origin) }, 0)
      record(0, issue.kind)
      throw new IoError(issue)
    }

    for (let attempt = 1; ; attempt++) {
      const result = await this.once(target, timeoutMs, send)
      if (result.ok) {
        record(attempt, "ok")
        return result.value
      }
      const issue = fail(result.failure, attempt, {}, result.tooLarge)
      const retryAfter = result.failure.kind === "http" ? result.failure.retryAfterMs : null
      if (!issue.transient || attempt >= maxAttempts || this.aborted) {
        record(attempt, issue.kind)
        throw new IoError(issue)
      }
      const backoff = RETRY.backoffMs[Math.min(attempt - 1, RETRY.backoffMs.length - 1)]
      const wait =
        retryAfter !== null && retryAfter <= MAX_RETRY_AFTER_MS
          ? Math.max(retryAfter, backoff)
          : backoff + this.random() * RETRY.jitterMs
      try {
        await this.sleep(wait, this.signal)
      } catch {
        const cancelled = fail({ kind: "aborted" }, attempt)
        record(attempt, cancelled.kind)
        throw new IoError(cancelled)
      }
    }
  }

  private async once(
    target: Target,
    timeoutMs: number,
    send: (signal: AbortSignal) => Promise<Attempt>,
  ): Promise<Attempt> {
    if (this.aborted) return { ok: false, failure: { kind: "aborted" }, status: null }
    const hostLimit = this.semaphore(target.host)
    try {
      await hostLimit.acquire(this.signal)
    } catch {
      return { ok: false, failure: { kind: "aborted" }, status: null }
    }
    try {
      await this.total.acquire(this.signal)
    } catch {
      hostLimit.release()
      return { ok: false, failure: { kind: "aborted" }, status: null }
    }
    const controller = new AbortController()
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      controller.abort()
    }, timeoutMs)
    const onAbort = () => controller.abort()
    this.signal?.addEventListener("abort", onAbort, { once: true })
    if (this.aborted) controller.abort()
    try {
      const result = await send(controller.signal)
      if (result.status !== null) this.answered.add(target.host)
      return result
    } catch (error) {
      if (this.aborted) return { ok: false, failure: { kind: "aborted" }, status: null }
      if (timedOut) return { ok: false, failure: { kind: "timeout", afterMs: timeoutMs }, status: null }
      const message = error instanceof Error ? error.message : String(error)
      return {
        ok: false,
        failure: { kind: "fetch-failed", message, answeredBefore: this.answered.has(target.host) },
        status: null,
      }
    } finally {
      clearTimeout(timer)
      this.signal?.removeEventListener("abort", onAbort)
      this.total.release()
      hostLimit.release()
    }
  }

  private redactFailure(failure: RawFailure): RawFailure {
    switch (failure.kind) {
      case "http":
        return { ...failure, body: this.redact(failure.body) }
      case "json":
        return { ...failure, body: this.redact(failure.body) }
      case "rpc":
      case "shape":
      case "api":
      case "fetch-failed":
        return { ...failure, message: this.redact(failure.message) }
      default:
        return failure
    }
  }
}
