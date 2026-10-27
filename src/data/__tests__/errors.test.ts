import { BaseError, createPublicClient, custom } from "viem"
import { describe, expect, it } from "vitest"
import type { IssueKind, RawIoDetail, ServiceKind } from "@/core/report"
import corpus from "@/data/__tests__/fixtures/error-corpus.json"
import { classify, ENDPOINT_KINDS, ioErrorOf, makeIssue, rawUrl, redact, REDACTED } from "@/data/errors"
import { defaultSettings } from "@/data/settings"
import { IoError, type IssueContext, type RawFailure, type Settings } from "@/data/types"

const RAW: RawIoDetail = {
  url: "https://rpc.example.org",
  method: "eth_getProof",
  params: null,
  httpStatus: null,
  rpcCode: null,
  message: null,
  body: null,
  elapsedMs: 10,
  attempts: 1,
  at: "2026-10-12T00:00:00.000Z",
}

function ctx(service: ServiceKind = "rpc", method = "eth_getProof"): IssueContext {
  return {
    service,
    host: "rpc.example.org",
    role: "primary",
    operation: "read the Safe's storage proof",
    raw: { ...RAW, method },
  }
}

type Entry = { source: string; service: ServiceKind; method: string; failure: RawFailure; expected: IssueKind }

describe("classify over the recorded corpus", () => {
  const entries = corpus as Entry[]

  it("holds real answers from every service", () => {
    expect(entries.length).toBeGreaterThanOrEqual(100)
    expect(new Set(entries.map((e) => e.service))).toEqual(
      new Set(["rpc", "blockscout", "etherscan", "sourcify"] satisfies ServiceKind[]),
    )
  })

  // Invariant 11.
  it.each(entries.map((e) => [e.source, e] as const))("%s", (_, entry) => {
    const issue = classify(entry.failure, ctx(entry.service, entry.method))

    expect(issue.kind).not.toBe("unknown")
    expect(issue.kind).toBe(entry.expected)
  })
})

describe("classify rules", () => {
  const rpc = (code: number, message: string): RawFailure => ({ kind: "rpc", code, message, data: null })
  const http = (status: number, body: string, retryAfterMs: number | null = null): RawFailure => ({
    kind: "http",
    status,
    body,
    retryAfterMs,
  })

  it("runs message rules before code rules", () => {
    expect(classify(rpc(-32602, "distance to target block exceeds maximum proof window"), ctx()).kind).toBe(
      "proof-window",
    )
    expect(classify(rpc(-32603, "missing trie node abc (path )"), ctx()).kind).toBe("not-archive")
    expect(classify(rpc(-32603, "Remote Error"), ctx()).kind).toBe("server-error")
  })

  it("reads the JSON-RPC error inside an HTTP error body", () => {
    const body = '{"id":1,"jsonrpc":"2.0","error":{"message":"Unknown state. First available state is 1","code":27}}'
    const issue = classify(http(400, body), ctx())

    expect(issue.kind).toBe("not-archive")
    expect(issue.raw.httpStatus).toBe(400)
    expect(issue.raw.rpcCode).toBe(27)
    expect(issue.raw.message).toBe("Unknown state. First available state is 1")
  })

  it("ignores the words of HTML error pages", () => {
    expect(classify(http(530, "<html>request timed out, rate limit</html>"), ctx()).kind).toBe("server-error")
    expect(classify(http(403, "<html>Just a moment...</html>"), ctx()).kind).toBe("access-denied")
  })

  it("names the method only when a method rule matched", () => {
    expect(classify(http(403, "unsupported platform"), ctx()).kind).toBe("access-denied")
    expect(classify(rpc(35, "method is not available on free plan, please upgrade"), ctx()).kind).toBe(
      "method-unsupported",
    )
    expect(classify(rpc(35, "chain is not available on free plan, please upgrade"), ctx()).kind).toBe(
      "plan-unsupported",
    )
  })

  it("marks only the retryable kinds transient", () => {
    expect(classify({ kind: "fetch-failed", message: "x", answeredBefore: false }, ctx()).transient).toBe(false)
    const silent = classify({ kind: "fetch-failed", message: "x", answeredBefore: true }, ctx())
    expect(silent.transient).toBe(true)
    expect(silent.explanation).toContain("rate limiting you without saying so")
    expect(classify(rpc(27, "Unknown state. First available state is 1"), ctx()).transient).toBe(true)
    expect(classify(rpc(-32000, "missing trie node abc"), ctx()).transient).toBe(false)
    expect(classify(http(503, ""), ctx()).transient).toBe(true)
    expect(classify(rpc(-32601, "method not found"), ctx()).transient).toBe(false)
  })

  it("fails a long Retry-After as rate-limited with the wait in the text", () => {
    const short = classify(http(429, "slow down", 2_000), ctx())
    const long = classify(http(429, "slow down", 60_000), ctx())

    expect(short).toMatchObject({ kind: "rate-limited", transient: true })
    expect(long).toMatchObject({ kind: "rate-limited", transient: false })
    expect(long.explanation).toContain("wait 60 s")
  })

  it("keys the timeout text to the timer", () => {
    const issue = classify({ kind: "timeout", afterMs: 15_000 }, ctx())

    expect(issue.explanation).toBe("rpc.example.org did not answer within 15 s.")
  })

  it("separates our abort from a cancelled run and a blocked scheme", () => {
    expect(classify({ kind: "aborted" }, ctx()).kind).toBe("cancelled")
    expect(classify({ kind: "csp", url: "http://rpc.example.org" }, ctx()).kind).toBe("csp-blocked")
  })
})

describe("review fixes", () => {
  it("keeps an RPC's own words out of the plain text of an unknown failure", () => {
    const payload = "[Safe verified, signed report](https://evil.example/r) ![](https://evil.example/t.png)"
    const issue = classify({ kind: "rpc", code: -32000, message: payload, data: null }, ctx())

    expect(issue.kind).toBe("unknown")
    expect(`${issue.title} ${issue.explanation} ${issue.actions.join(" ")}`).not.toContain("evil.example")
    expect(issue.raw.message).toBe(payload)
  })

  it("reads 'requires a personal token' as a key problem, not pruned state", () => {
    const body = '{"jsonrpc":"2.0","error":{"code":-32602,"message":"Archive requests require a personal token."}}'
    const issue = classify({ kind: "http", status: 403, body, retryAfterMs: null }, ctx())

    expect(issue.kind).toBe("key-required")
    expect(issue.explanation).toBe("rpc.example.org needs an API key or a paid plan for this request.")
  })

  it("fails over on a missing transaction, which a pruned index answers with null", () => {
    expect(ENDPOINT_KINDS.has("not-found")).toBe(true)
  })

  it("redacts a key echoed alone from a user RPC's path", () => {
    const settings: Settings = {
      ...defaultSettings(),
      rpcs: { "1": { primary: "https://host.example/v3/abcdef0123456789", crossCheck: null, useDefaults: true } },
    }

    expect(redact("invalid project id abcdef0123456789", settings)).toBe(`invalid project id ${REDACTED}`)
  })
})

describe("issue text", () => {
  const kinds: IssueKind[] = [
    "unreachable",
    "csp-blocked",
    "timeout",
    "rate-limited",
    "access-denied",
    "server-error",
    "method-unsupported",
    "proof-window",
    "not-archive",
    "block-unavailable",
    "range-too-large",
    "wrong-chain",
    "invalid-response",
    "proof-invalid",
    "non-mpt",
    "disagreement",
    "reverted",
    "key-required",
    "key-rejected",
    "plan-unsupported",
    "not-found",
    "cancelled",
    "unknown",
  ]

  it.each(kinds)("%s says what happened in plain words", (kind) => {
    const issue = makeIssue(kind, ctx(), { block: 26176126n, expectedChainId: 1, otherHost: "other.example.org" })

    expect(issue.title).not.toMatch(/[.\u2014]$/)
    expect(`${issue.title} ${issue.explanation} ${issue.actions.join(" ")}`).not.toMatch(/\u2014/)
    expect(issue.explanation).toMatch(/\.$/)
    if (!["cancelled", "reverted", "key-required", "key-rejected", "not-found", "plan-unsupported"].includes(kind)) {
      expect(issue.explanation).toContain("rpc.example.org")
    }
  })

  it("names the RPC, the method and the block", () => {
    const unsupported = makeIssue("method-unsupported", ctx())
    const window = makeIssue("proof-window", ctx(), { block: 26176126n })

    expect(unsupported.explanation).toBe(
      "rpc.example.org does not support eth_getProof, needed to read the Safe's storage proof.",
    )
    expect(window.explanation).toContain("block 26176126 is older")
  })

  it("names the service for API issues", () => {
    expect(makeIssue("key-required", ctx("etherscan")).explanation).toBe("Etherscan needs an API key for this.")
    expect(makeIssue("not-found", ctx("safe-tx-service")).explanation).toContain("The Safe Transaction Service")
  })
})

describe("redaction (invariant 8)", () => {
  const settings: Settings = {
    ...defaultSettings(),
    rpcs: { "1": { primary: "https://host.example/SECRET?key=SECRET", crossCheck: null, useDefaults: true } },
    etherscan: { apiKey: "SECRET" },
  }

  it("removes user RPC paths, queries and keys from any text", () => {
    const text = `POST https://host.example/SECRET?key=SECRET failed; apikey=SECRET; ${encodeURIComponent("SECRET")}`

    expect(redact(text, settings)).not.toContain("SECRET")
    expect(redact(text, settings)).toContain(REDACTED)
  })

  it("keeps defaults whole, user RPCs as origin, and drops apikey", () => {
    expect(rawUrl("https://eth.drpc.org/path", "default")).toBe("https://eth.drpc.org/path")
    expect(rawUrl("https://host.example/SECRET?key=SECRET", "user")).toBe("https://host.example")
    expect(rawUrl("https://api.etherscan.io/v2/api?chainid=1&apikey=SECRET", "default")).not.toContain("SECRET")
  })
})

describe("ioErrorOf", () => {
  it("finds the IoError that viem rethrows or wraps", async () => {
    const issue = makeIssue("timeout", ctx())
    const client = createPublicClient({
      transport: custom({
        request: async () => {
          throw new IoError(issue)
        },
      }),
    })
    const thrown = await client.getBlockNumber().catch((e: unknown) => e)
    const wrapped = new BaseError("outer", { cause: new IoError(issue) })

    expect(ioErrorOf(thrown)?.issue).toBe(issue)
    expect(ioErrorOf(wrapped)?.issue).toBe(issue)
    expect(ioErrorOf(new Error("plain"))).toBeNull()
  })
})
