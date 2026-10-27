// Safe Transaction Service client. Keyless by default (the switch is in settings.ts); `Authorization: Bearer` only with
// the user's key. The base URL comes from the Safe Config Service through chains.json, because 7 of 54
// chains use a URL segment other than their EIP-3770 name.
import { type Address, getAddress, type Hex } from "viem"
import { issueOf } from "@/data/errors"
import { checkApiKey } from "@/data/settings"
import type { ApiRequest, Transport } from "@/data/transport"
import type { ApiResult, SafeTxService, StsCreation, StsDelegate, StsMessage, StsMultisigTx } from "@/data/types"

const PAGE = 100
const MAX_PAGES = 10

type Page<T> = { results?: T[]; next?: string | null }

export class SafeTxServiceClient implements SafeTxService {
  readonly host: string
  private readonly base: string
  private readonly apiKey: string | null
  private readonly transport: Transport

  // `base` ends in /api/v1.
  constructor(base: string, apiKey: string | null, transport: Transport) {
    this.base = base.replace(/\/+$/, "")
    this.host = new URL(this.base).host
    this.apiKey = apiKey
    this.transport = transport
  }

  private request(operation: string, accept?: number[]): ApiRequest {
    return {
      service: "safe-tx-service",
      operation,
      accept,
      headers: this.apiKey ? { authorization: `Bearer ${this.apiKey}` } : undefined,
    }
  }

  private source() {
    return { service: "safe-tx-service" as const, host: this.host }
  }

  // A key fetch cannot put in a header (a zero-width space from a copied page) would fail before sending, and look
  // like the service is down; say what is wrong with the key instead.
  private keyProblem(url: string, operation: string): ApiResult<never> | null {
    if (this.apiKey === null || checkApiKey(this.apiKey).ok) return null
    const issue = this.transport.apiIssue(url, "safe-tx-service", operation, "unsendable API key", null, {
      kind: "key-rejected",
      vars: { unsendableKey: true },
    })
    return { ok: false, issue }
  }

  private async get<T>(url: string, operation: string, map: (body: unknown) => T): Promise<ApiResult<T>> {
    const problem = this.keyProblem(url, operation)
    if (problem) return problem
    try {
      const res = await this.transport.api(url, this.request(operation))
      return { ok: true, data: map(res.body), source: this.source() }
    } catch (error) {
      return { ok: false, issue: issueOf(error) }
    }
  }

  // Follows `next` links on the same host, up to MAX_PAGES.
  private async pages<T>(url: string, operation: string): Promise<ApiResult<T[]>> {
    const problem = this.keyProblem(url, operation)
    if (problem) return problem
    const items: T[] = []
    let next: string | null = url
    try {
      for (let page = 0; page < MAX_PAGES && next; page++) {
        const res = await this.transport.api(next, this.request(operation))
        const body = res.body as Page<T>
        items.push(...(body.results ?? []))
        next = body.next && new URL(body.next).host === this.host ? body.next : null
      }
      return { ok: true, data: items, source: this.source() }
    } catch (error) {
      return { ok: false, issue: issueOf(error) }
    }
  }

  creation(safe: Address): Promise<ApiResult<StsCreation>> {
    return this.get(`${this.base}/safes/${getAddress(safe)}/creation/`, "look up the Safe's creation", (body) => ({
      transactionHash: String((body as { transactionHash?: unknown }).transactionHash).toLowerCase() as Hex,
    }))
  }

  async queued(safe: Address, fromNonce: bigint): Promise<ApiResult<StsMultisigTx[]>> {
    const url = `${this.base}/safes/${getAddress(safe)}/multisig-transactions/?executed=false&nonce__gte=${fromNonce}&ordering=nonce&limit=${PAGE}`
    const result = await this.pages<Record<string, unknown>>(url, "read the queued transactions")
    if (!result.ok) return result
    return {
      ...result,
      data: result.data.map((t) => ({
        safeTxHash: String(t.safeTxHash).toLowerCase() as Hex,
        nonce: String(t.nonce),
        to: getAddress(String(t.to)),
        value: String(t.value ?? "0"),
        data: typeof t.data === "string" ? (t.data as Hex) : null,
        operation: t.operation === 1 ? 1 : 0,
        confirmationsRequired: Number(t.confirmationsRequired ?? 0),
        confirmations: owners(t.confirmations),
        isExecuted: t.isExecuted === true,
      })),
    }
  }

  async messages(safe: Address): Promise<ApiResult<StsMessage[]>> {
    const url = `${this.base}/safes/${getAddress(safe)}/messages/?limit=${PAGE}`
    const result = await this.pages<Record<string, unknown>>(url, "read the Safe's messages")
    if (!result.ok) return result
    return {
      ...result,
      data: result.data.map((m) => ({
        messageHash: String(m.messageHash).toLowerCase() as Hex,
        created: String(m.created),
        confirmations: owners(m.confirmations),
      })),
    }
  }

  async delegates(safe: Address): Promise<ApiResult<StsDelegate[]>> {
    // Delegates moved to API v2; v1 is deprecated.
    const url = `${this.base.replace(/\/api\/v1$/, "/api/v2")}/delegates/?safe=${getAddress(safe)}&limit=${PAGE}`
    const result = await this.pages<Record<string, unknown>>(url, "read the Safe's delegates")
    if (!result.ok) return result
    return {
      ...result,
      data: result.data.map((d) => ({
        delegate: getAddress(String(d.delegate)),
        delegator: getAddress(String(d.delegator)),
        label: String(d.label ?? ""),
      })),
    }
  }
}

function owners(value: unknown): { owner: Address }[] {
  return Array.isArray(value)
    ? value
        .filter((c): c is { owner: string } => typeof c === "object" && c !== null && typeof c.owner === "string")
        .map((c) => ({ owner: getAddress(c.owner) }))
    : []
}
