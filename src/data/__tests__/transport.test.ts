import { describe, expect, it } from "vitest"
import { secretsOf } from "@/data/errors"
import { defaultSettings } from "@/data/settings"
import { RETRY, Transport } from "@/data/transport"
import { type Endpoint, IoError, type Settings } from "@/data/types"
import { fakeNetwork, HttpAnswer, RpcError } from "@/data/__tests__/fakeRpc"

const ENDPOINT: Endpoint = {
  url: "https://rpc.example.org/",
  host: "rpc.example.org",
  operator: "user:example.org",
  operatorName: "example.org",
  aggregator: false,
  origin: "default",
}
const CTX = { role: "primary" as const, operation: "read the block number" }

function transportWith(handler: Parameters<typeof fakeNetwork>[0][string], options: { random?: () => number } = {}) {
  const network = fakeNetwork({ "rpc.example.org": handler })
  const sleeps: number[] = []
  const transport = new Transport({
    fetch: network.fetch,
    sleep: async (ms) => void sleeps.push(ms),
    random: options.random ?? (() => 0.5),
  })
  return { transport, sleeps, calls: network.calls }
}

describe("requests", () => {
  it("sends one JSON-RPC object per POST, without credentials or Authorization (invariants 9 and 10)", async () => {
    const { transport, calls } = transportWith(() => "0x1")

    await Promise.all([
      transport.rpc(ENDPOINT, "eth_chainId", [], CTX),
      transport.rpc(ENDPOINT, "eth_blockNumber", [], CTX),
    ])

    expect(calls).toHaveLength(2)
    for (const call of calls) {
      expect(Array.isArray(JSON.parse(String(call.init.body)))).toBe(false)
      expect(call.init.credentials).toBe("omit")
      expect(Object.keys(call.init.headers as object).map((h) => h.toLowerCase())).toEqual(["content-type"])
    }
  })

  it("returns a null result as null", async () => {
    const { transport } = transportWith(() => null)

    expect(await transport.rpc(ENDPOINT, "eth_getBlockByNumber", ["0x1", false], CTX)).toBeNull()
  })

  it("blocks plain http to anything but this computer before sending", async () => {
    const { transport, calls } = transportWith(() => "0x1")
    const plain = { ...ENDPOINT, url: "http://rpc.example.org" }
    const local = { ...ENDPOINT, url: "http://127.0.0.1:8545", host: "127.0.0.1:8545" }

    const error = await transport.rpc(plain, "eth_chainId", [], CTX).catch((e: unknown) => e)

    expect((error as IoError).kind).toBe("csp-blocked")
    expect(calls).toHaveLength(0)
    await expect(transport.rpc(local, "eth_chainId", [], CTX)).rejects.toMatchObject({ issue: { kind: "unreachable" } })
  })
})

describe("retries", () => {
  it("retries transient failures with 0.5 s and 1.5 s backoff plus jitter, then fails", async () => {
    const { transport, sleeps, calls } = transportWith(() => new HttpAnswer(503, "busy"), { random: () => 1 })

    const error = await transport.rpc(ENDPOINT, "eth_blockNumber", [], CTX).catch((e: unknown) => e)

    expect(calls).toHaveLength(RETRY.attempts)
    expect(sleeps).toEqual([750, 1_750])
    expect((error as IoError).issue).toMatchObject({ kind: "server-error", raw: { attempts: 3, httpStatus: 503 } })
  })

  it("honours a short Retry-After", async () => {
    let n = 0
    const { transport, sleeps } = transportWith(() =>
      n++ === 0 ? new HttpAnswer(429, "slow", { "retry-after": "4" }) : "0x5",
    )

    expect(await transport.rpc(ENDPOINT, "eth_blockNumber", [], CTX)).toBe("0x5")
    expect(sleeps).toEqual([4_000])
  })

  it("does not wait for a Retry-After over 10 s", async () => {
    const { transport, sleeps, calls } = transportWith(() => new HttpAnswer(429, "slow", { "retry-after": "60" }))

    const error = await transport.rpc(ENDPOINT, "eth_blockNumber", [], CTX).catch((e: unknown) => e)

    expect(calls).toHaveLength(1)
    expect(sleeps).toEqual([])
    expect((error as IoError).issue.explanation).toContain("wait 60 s")
  })

  it("does not retry permanent failures", async () => {
    const { transport, calls } = transportWith(() => new RpcError(-32601, "method not found"))

    await expect(transport.rpc(ENDPOINT, "eth_getProof", [], CTX)).rejects.toMatchObject({
      issue: { kind: "method-unsupported" },
    })
    expect(calls).toHaveLength(1)
  })

  it("retries a network failure only after the host answered before", async () => {
    let n = 0
    const network = fakeNetwork({
      "rpc.example.org": () => {
        n++
        if (n > 1 && n < 3) throw new TypeError("Failed to fetch")
        return "0x1"
      },
    })
    const fresh = new Transport({
      fetch: async () => Promise.reject(new TypeError("Failed to fetch")),
      sleep: async () => undefined,
    })
    const seen = new Transport({ fetch: network.fetch, sleep: async () => undefined })

    await expect(fresh.rpc(ENDPOINT, "eth_chainId", [], CTX)).rejects.toMatchObject({
      issue: { kind: "unreachable", transient: false, raw: { attempts: 1 } },
    })
    await seen.rpc(ENDPOINT, "eth_chainId", [], CTX)
    expect(await seen.rpc(ENDPOINT, "eth_chainId", [], CTX)).toBe("0x1")
    expect(n).toBe(3)
  })

  it("times out a call that does not answer", async () => {
    const { transport } = transportWith(() => new Promise(() => undefined))

    const error = await transport
      .rpc(ENDPOINT, "eth_blockNumber", [], { ...CTX, timeoutMs: 20, attempts: 1 })
      .catch((e: unknown) => e)

    expect((error as IoError).issue).toMatchObject({
      kind: "timeout",
      explanation: "rpc.example.org did not answer within 0 s.",
    })
  })

  it("cancels in-flight and queued calls when the run is aborted", async () => {
    const controller = new AbortController()
    const network = fakeNetwork({ "rpc.example.org": () => new Promise(() => undefined) })
    const transport = new Transport({
      signal: controller.signal,
      fetch: network.fetch,
      limits: { perHost: 1, total: 1 },
    })

    const calls = [0, 1].map(() => transport.rpc(ENDPOINT, "eth_blockNumber", [], CTX).catch((e: unknown) => e))
    await new Promise((resolve) => setTimeout(resolve, 5))
    expect(network.calls).toHaveLength(1)
    controller.abort()

    for (const error of await Promise.all(calls)) expect((error as IoError).kind).toBe("cancelled")
  })
})

describe("size cap", () => {
  it("refuses an answer past the cap without reading it, whether or not it declares its length", async () => {
    const big = JSON.stringify({ jsonrpc: "2.0", id: 1, result: `0x${"00".repeat(600)}` })
    const declared = new Transport({
      fetch: async () => new Response(big, { headers: { "content-length": String(big.length) } }),
      maxBytes: { default: 1024, slow: 1024 },
    })
    const streamed = new Transport({
      fetch: async () =>
        new Response(new ReadableStream({ start: (c) => (c.enqueue(new TextEncoder().encode(big)), c.close()) })),
      maxBytes: { default: 1024, slow: 1024 },
    })

    for (const transport of [declared, streamed]) {
      const error = await transport.rpc(ENDPOINT, "eth_getProof", [], CTX).catch((e: unknown) => e)
      expect((error as IoError).issue).toMatchObject({
        kind: "invalid-response",
        explanation: expect.stringContaining("larger than 1024 bytes, so it was not read"),
      })
    }
  })

  it("reads an answer under the cap", async () => {
    const transport = new Transport({
      fetch: async () => Response.json({ jsonrpc: "2.0", id: 1, result: "0x1" }),
      maxBytes: { default: 1024, slow: 1024 },
    })

    expect(await transport.rpc(ENDPOINT, "eth_chainId", [], CTX)).toBe("0x1")
  })
})

describe("after a cancel", () => {
  it("sends nothing once the run is aborted", async () => {
    const controller = new AbortController()
    const network = fakeNetwork({ "rpc.example.org": () => "0x1" })
    const transport = new Transport({ signal: controller.signal, fetch: network.fetch })
    controller.abort()

    const error = await transport.rpc(ENDPOINT, "eth_chainId", [], CTX).catch((e: unknown) => e)

    expect((error as IoError).kind).toBe("cancelled")
    expect(network.calls).toHaveLength(0)
  })
})

describe("limits", () => {
  it("keeps at most 4 requests in flight per host and 12 overall", async () => {
    let inFlight = 0
    let maxInFlight = 0
    const perHost = new Map<string, number>()
    let maxPerHost = 0
    const transport = new Transport({
      fetch: async (input) => {
        const host = new URL(String(input)).host
        inFlight++
        perHost.set(host, (perHost.get(host) ?? 0) + 1)
        maxInFlight = Math.max(maxInFlight, inFlight)
        maxPerHost = Math.max(maxPerHost, perHost.get(host) ?? 0)
        await new Promise((resolve) => setTimeout(resolve, 5))
        inFlight--
        perHost.set(host, (perHost.get(host) ?? 0) - 1)
        return Response.json({ jsonrpc: "2.0", id: 1, result: "0x1" })
      },
    })
    const endpoints = [0, 1, 2, 3, 4].map((i) => ({
      ...ENDPOINT,
      url: `https://h${i}.example/`,
      host: `h${i}.example`,
    }))

    await Promise.all(
      endpoints.flatMap((e) => Array.from({ length: 6 }, () => transport.rpc(e, "eth_chainId", [], CTX))),
    )

    expect(maxPerHost).toBe(4)
    expect(maxInFlight).toBe(12)
  })
})

describe("redaction (invariant 8)", () => {
  it("keeps a user RPC's path, query and keys out of every issue field", async () => {
    const url = "https://host.example/SECRET?key=SECRET"
    const settings: Settings = {
      ...defaultSettings(),
      rpcs: { "1": { primary: url, crossCheck: null, useDefaults: true } },
      etherscan: { apiKey: "SECRET" },
    }
    const network = fakeNetwork({
      "host.example": (_, params) => new HttpAnswer(400, `bad request to ${url} with ${JSON.stringify(params)}`),
    })
    const transport = new Transport({
      fetch: network.fetch,
      secrets: secretsOf(settings),
      sleep: async () => undefined,
    })
    const user: Endpoint = { ...ENDPOINT, url, host: "host.example", origin: "user" }

    const error = await transport.rpc(user, "eth_call", [{ data: "SECRET" }], CTX).catch((e: unknown) => e)
    const text = JSON.stringify((error as IoError).issue)

    expect(text).not.toContain("SECRET")
    expect((error as IoError).issue.raw.url).toBe("https://host.example")
    expect(network.calls[0].url).toBe(url)
  })
})
