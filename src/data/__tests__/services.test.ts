// Detection, the API clients, the history source, the creation finder and openSession, over a fake network.
import { encodeAbiParameters, type Hex, keccak256, numberToHex, pad } from "viem"
import { describe, expect, it } from "vitest"
import { EVENT_TOPICS } from "@/core/constants"
import { getChain } from "@/data/chains"
import { canPair, userEndpoint } from "@/data/endpoints"
import { detectChains, detectionChains } from "@/data/detect"
import knownJson from "@/data/generated/known-contracts.json"
import { Events } from "@/data/logs"
import type { Reader } from "@/data/reader"
import { open } from "@/data/session"
import { defaultSettings } from "@/data/settings"
import { Transport } from "@/data/transport"
import { SafeTxServiceClient } from "@/data/safeTxService"
import { SourcifyClient } from "@/data/sourcify"
import type { CheckDeps, KnownContractsFile, Settings } from "@/data/types"
import { CapabilityCache } from "@/data/probe"
import {
  archiveNode,
  BLOCK,
  BLAST,
  DRPC,
  fakeNetwork,
  type Handler,
  HttpAnswer,
  override,
  PUBLICNODE,
  RpcError,
  SAFE,
  TEAM,
  testChain,
} from "@/data/__tests__/fakeRpc"

const known = knownJson as unknown as KnownContractsFile
const SINGLETON_141 = known.contracts.find((c) => c.id === "Safe@1.4.1/canonical")?.address as Hex

// Any code whose hash is not a known proxy.
const OTHER_CODE = "0x6001600055"

function detectNode(answer: { code: Hex; slot0?: Hex }): Handler {
  return (method) => {
    if (method === "eth_getCode") return answer.code
    if (method === "eth_getStorageAt") return answer.slot0 ?? pad("0x00", { size: 32 })
    return new RpcError(-32601, "method not found")
  }
}

describe("detectChains", () => {
  it("asks only the Safe{Wallet} chains in the popular phase (invariant 14), most used first", async () => {
    const popular = detectionChains("popular")
    const network = fakeNetwork({})

    const results = await detectChains(SAFE, { scope: "popular", fetch: network.fetch })

    expect(popular.every((c) => c.safeWallet && c.rpcs.length > 0)).toBe(true)
    expect(popular[0].chainId).toBe(1)
    const asked = new Set(network.calls.map((c) => c.host))
    const allowed = new Set(popular.flatMap((c) => c.rpcs.map((r) => new URL(r.url).host)))
    expect([...asked].every((h) => allowed.has(h))).toBe(true)
    expect(results.map((r) => r.chainId)).toEqual(popular.map((c) => c.chainId))
    expect(detectionChains("all").length).toBeGreaterThan(popular.length)
  })

  it("calls a known singleton in slot 0 a Safe, other code a contract, no code empty", async () => {
    const eth = new URL(getChain(1)?.rpcs[0].url ?? "").host
    const gno = new URL(getChain(100)?.rpcs[0].url ?? "").host
    const base = new URL(getChain(8453)?.rpcs[0].url ?? "").host
    const network = fakeNetwork({
      [eth]: detectNode({ code: OTHER_CODE, slot0: pad(SINGLETON_141.toLowerCase() as Hex, { size: 32 }) }),
      [gno]: detectNode({ code: OTHER_CODE }),
      [base]: detectNode({ code: "0x" }),
    })
    const seen: number[] = []

    const results = await detectChains(SAFE, {
      scope: "popular",
      fetch: network.fetch,
      onResult: (r) => seen.push(r.chainId),
    })
    const byChain = new Map(results.map((r) => [r.chainId, r]))

    expect(byChain.get(1)).toMatchObject({ status: "safe", singleton: SINGLETON_141, version: "1.4.1" })
    expect(byChain.get(100)?.status).toBe("contract")
    expect(byChain.get(8453)?.status).toBe("empty")
    expect(byChain.get(137)?.status).toBe("error")
    expect(byChain.get(137)?.issue?.kind).toBe("unreachable")
    expect(seen).toHaveLength(results.length)
  })
})

describe("Safe Transaction Service", () => {
  const base = "https://api.safe.global/tx-service/eth/api/v1"

  it("sends Authorization only with a key", async () => {
    const network = fakeNetwork({ "api.safe.global": () => new HttpAnswer(200, '{"results":[],"next":null}') })
    const transport = new Transport({ fetch: network.fetch })

    await new SafeTxServiceClient(base, null, transport).messages(SAFE)
    await new SafeTxServiceClient(base, "KEY", transport).messages(SAFE)

    const headers = network.calls.map((c) => new Headers(c.init.headers).get("authorization"))
    expect(headers).toEqual([null, "Bearer KEY"])
    expect(network.calls[0].url).toBe(`${base}/safes/${SAFE}/messages/?limit=100`)
  })

  it("says the key cannot be sent, and sends nothing, when it holds a character a header cannot carry", async () => {
    const network = fakeNetwork({ "api.safe.global": () => new HttpAnswer(200, '{"results":[],"next":null}') })
    const client = new SafeTxServiceClient(base, "abc123\u200b", new Transport({ fetch: network.fetch }))

    const result = await client.messages(SAFE)

    expect(network.calls).toHaveLength(0)
    expect(result).toMatchObject({
      ok: false,
      issue: { kind: "key-rejected", title: "API key cannot be sent", actions: ["Paste the key again in settings."] },
    })
  })

  it("maps 404 to not-found and reads delegates from API v2", async () => {
    const network = fakeNetwork({
      "api.safe.global": () => new HttpAnswer(404, ""),
    })
    const client = new SafeTxServiceClient(base, null, new Transport({ fetch: network.fetch }))

    const creation = await client.creation(SAFE)
    await client.delegates(SAFE)

    expect(creation).toMatchObject({ ok: false, issue: { kind: "not-found", service: "safe-tx-service" } })
    expect(network.calls[1].url).toContain("/api/v2/delegates/?safe=")
  })
})

describe("Sourcify", () => {
  it("reads exact, partial and not verified", async () => {
    const answers = [
      new HttpAnswer(200, '{"match":"exact_match"}'),
      new HttpAnswer(200, '{"match":"match"}'),
      new HttpAnswer(404, '{"match":null}'),
      // A server error is retried twice before it fails.
      new HttpAnswer(500, "oops"),
      new HttpAnswer(500, "oops"),
      new HttpAnswer(500, "oops"),
    ]
    const network = fakeNetwork({ "sourcify.dev": () => answers.shift() })
    const client = new SourcifyClient(new Transport({ fetch: network.fetch, sleep: async () => undefined }))

    expect(await client.match(1, SAFE)).toMatchObject({ ok: true, data: "exact_match" })
    expect(await client.match(1, SAFE)).toMatchObject({ ok: true, data: "match" })
    expect(await client.match(1, SAFE)).toMatchObject({ ok: true, data: "not-verified" })
    expect((await client.match(1, SAFE)).ok).toBe(false)
  })
})

async function session(
  handlers: Record<string, Handler>,
  settings: Settings = defaultSettings(),
  chain = testChain([DRPC, PUBLICNODE]),
) {
  const network = fakeNetwork(handlers)
  const issues: unknown[] = []
  const result = await open(
    1,
    settings,
    { fetch: network.fetch, onIssue: (i) => issues.push(i) },
    {
      chain,
      capabilities: new CapabilityCache(),
    },
  )
  if (!result.ok) throw new Error(result.message)
  return { deps: result.deps as CheckDeps, calls: network.calls, issues }
}

describe("openSession", () => {
  it("stops on an unknown chain and on a chain without any RPC", async () => {
    const unknown = await open(424242424242, defaultSettings())
    const off = await open(1, {
      ...defaultSettings(),
      rpcs: { "1": { primary: null, crossCheck: null, useDefaults: false } },
    })

    expect(unknown).toMatchObject({ ok: false, reason: "unknown-chain" })
    expect(off).toMatchObject({ ok: false, reason: "no-rpc", message: expect.stringContaining("turned off") })
  })

  it("never calls Etherscan without a key, nor the Transaction Service when it is off (invariant 9)", async () => {
    const chain = { ...testChain([DRPC]), safeTxServiceApi: "https://api.safe.global/tx-service/eth/api/v1" }
    const off: Settings = { ...defaultSettings(), safeTxService: { enabled: false, apiKey: null } }

    const withService = await session({ [new URL(DRPC.url).host]: archiveNode() }, defaultSettings(), chain)
    const without = await session({ [new URL(DRPC.url).host]: archiveNode() }, off, chain)

    expect(withService.deps.safeTxService?.host).toBe("api.safe.global")
    expect(without.deps.safeTxService).toBeNull()
  })
})

describe("events", () => {
  const SET = (block: bigint, index: number): unknown => ({
    address: SAFE,
    topics: [EVENT_TOPICS.EnabledModule],
    data: pad("0x01", { size: 32 }),
    blockNumber: numberToHex(block),
    transactionHash: keccak256(numberToHex(block)),
    logIndex: numberToHex(index),
  })

  it("reads a cheap range from the RPC in probed chunks", async () => {
    const ranges: [bigint, bigint][] = []
    const node = override(archiveNode(), {
      eth_getLogs: (_, params) => {
        const { fromBlock, toBlock } = params[0] as { fromBlock: Hex; toBlock: Hex }
        if (BigInt(toBlock) - BigInt(fromBlock) + 1n > 1_000n) return new RpcError(-32602, "block range too large")
        ranges.push([BigInt(fromBlock), BigInt(toBlock)])
        return BigInt(fromBlock) <= BLOCK - 1500n && BigInt(toBlock) >= BLOCK - 1500n ? [SET(BLOCK - 1500n, 3)] : []
      },
    })
    const { deps } = await session({ [new URL(DRPC.url).host]: node, [new URL(PUBLICNODE.url).host]: archiveNode() })
    await deps.reader.anchor({ block: null })

    const read = await deps.events.logs({ address: SAFE, fromBlock: BLOCK - 4_999n, toBlock: BLOCK })

    expect(read).toMatchObject({ source: { service: "rpc", host: "eth.drpc.org" }, complete: true, toBlock: BLOCK })
    expect(read.logs.map((l) => l.blockNumber)).toEqual([BLOCK - 1500n])
    // The first range is the probe at the anchor (10,000 was refused); then five chunks from the oldest block up.
    expect(ranges[0]).toEqual([BLOCK - 999n, BLOCK])
    expect(ranges.slice(1)).toEqual(
      [0n, 1n, 2n, 3n, 4n].map((i) => [BLOCK - 4_999n + i * 1_000n, BLOCK - 4_000n + i * 1_000n]),
    )
  })

  it("uses Blockscout when the RPC would need over 200 chunks, keeps only the Safe's logs, and confirms on the cross-check", async () => {
    const item = (address: Hex, index: number) => ({
      address: { hash: address },
      topics: [EVENT_TOPICS.EnabledModule, null, null, null],
      data: pad("0x01", { size: 32 }),
      block_number: Number(BLOCK - 10n),
      transaction_hash: keccak256("0x01"),
      index,
    })
    const page = {
      items: [item(SAFE, 7), item("0x000000000000000000000000000000000000dEaD", 8)],
      next_page_params: null,
    }
    const receipt = (logs: unknown[]) => () => ({ status: "0x1", logs })
    const safeLog = {
      address: SAFE,
      topics: [EVENT_TOPICS.EnabledModule],
      data: pad("0x01", { size: 32 }),
      blockNumber: numberToHex(BLOCK - 10n),
      transactionHash: keccak256("0x01"),
      logIndex: "0x7",
    }
    const primary = override(archiveNode(), {
      eth_getLogs: (_, params) => {
        const { fromBlock, toBlock } = params[0] as { fromBlock: Hex; toBlock: Hex }
        return BigInt(toBlock) - BigInt(fromBlock) + 1n > 100n ? new RpcError(-32602, "block range too large") : []
      },
      // A hostile primary would confirm anything; the confirmation must come from the cross-check.
      eth_getTransactionReceipt: receipt([safeLog]),
    })
    const chain = { ...testChain([DRPC, PUBLICNODE]), blockscoutApi: "https://eth.blockscout.com/api/v2" }
    const { deps, calls } = await session(
      {
        [new URL(DRPC.url).host]: primary,
        [new URL(PUBLICNODE.url).host]: override(archiveNode(), { eth_getTransactionReceipt: receipt([]) }),
        "eth.blockscout.com": () => new HttpAnswer(200, JSON.stringify(page)),
      },
      defaultSettings(),
      chain,
    )
    await deps.reader.anchor({ block: null })

    const read = await deps.events.logs({ address: SAFE, fromBlock: BLOCK - 100_000n, toBlock: BLOCK })
    const confirmed = await deps.events.confirm(read.logs)

    expect(read).toMatchObject({ source: { service: "blockscout" }, complete: true })
    expect(read.logs.map((l) => l.logIndex)).toEqual([7])
    expect(confirmed).toMatchObject({ confirmed: [], unconfirmed: [{ logIndex: 7 }] })
    const receipts = calls.filter((c) => c.method === "eth_getTransactionReceipt").map((c) => c.host)
    expect(receipts).toEqual([new URL(PUBLICNODE.url).host])
    expect(calls.some((c) => c.host === "api.etherscan.io")).toBe(false)
  })
})

describe("creation", () => {
  it("finds the creation block by binary search and the factory event in it", async () => {
    const created = BLOCK - 12_345n
    const tx = keccak256("0xc0de")
    const node = override(archiveNode(), {
      eth_getCode: (_, params) => (BigInt(params[1] as Hex) >= created ? "0x6001" : "0x"),
      eth_getLogs: (_, params) => {
        const { fromBlock } = params[0] as { fromBlock: Hex }
        return BigInt(fromBlock) === created
          ? [
              {
                address: BLAST.url.slice(0, 0) || SAFE,
                topics: [EVENT_TOPICS.ProxyCreation, pad(SAFE.toLowerCase() as Hex, { size: 32 })],
                data: encodeAbiParameters([{ type: "address" }], [SAFE]),
                blockNumber: numberToHex(created),
                transactionHash: tx,
                logIndex: "0x0",
              },
            ]
          : []
      },
    })
    const { deps } = await session({ [new URL(DRPC.url).host]: node, [new URL(PUBLICNODE.url).host]: archiveNode() })
    await deps.reader.anchor({ block: null })

    const lookup = await deps.creation.find(SAFE, BLOCK)

    expect(lookup).toEqual({
      found: true,
      txHash: tx,
      blockNumber: created,
      source: { service: "rpc", host: "eth.drpc.org" },
    })
  })
})

describe("secrets end to end (invariant 8)", () => {
  it("keeps a user RPC's path and the Etherscan key out of every issue", async () => {
    const url = "https://host.example/SECRET?key=SECRET"
    const settings: Settings = {
      ...defaultSettings(),
      rpcs: { "1": { primary: url, crossCheck: null, useDefaults: false } },
      etherscan: { apiKey: "SECRET" },
    }
    const leaky = (body: string) => () => new HttpAnswer(400, `${body} ${url} apikey=SECRET`)
    const node = override(archiveNode(), {
      eth_getLogs: leaky("logs refused"),
      eth_call: () => new RpcError(-32000, `cannot serve ${url}`),
    })
    const { deps, issues } = await session(
      {
        "host.example": node,
        "api.etherscan.io": () =>
          new HttpAnswer(200, '{"status":"0","message":"NOTOK","result":"Invalid API Key SECRET"}'),
      },
      settings,
      testChain([]),
    )
    await deps.reader.anchor({ block: null })
    const thrown = await deps.reader.call(SAFE, "0x12345678").catch((e: unknown) => e)
    const read = await deps.events.logs({ address: SAFE, fromBlock: 0n, toBlock: BLOCK })

    const text = JSON.stringify({ issues, thrown: (thrown as { issue: unknown }).issue, read: read.issues })
    expect(read.issues.map((i) => i.kind)).toContain("key-rejected")
    expect(text).not.toContain("SECRET")
  })
})

describe("review fixes", () => {
  it("keeps detection going when one RPC answers a short storage word", async () => {
    const eth = new URL(getChain(1)?.rpcs[0].url ?? "").host
    const gno = new URL(getChain(100)?.rpcs[0].url ?? "").host
    const network = fakeNetwork({
      [eth]: detectNode({ code: OTHER_CODE, slot0: "0x" }),
      [gno]: detectNode({ code: OTHER_CODE, slot0: pad(SINGLETON_141.toLowerCase() as Hex, { size: 32 }) }),
    })

    const results = await detectChains(SAFE, { scope: "popular", fetch: network.fetch })
    const byChain = new Map(results.map((r) => [r.chainId, r]))

    expect(byChain.get(1)?.status).toBe("contract")
    expect(byChain.get(100)).toMatchObject({ status: "safe", version: "1.4.1" })
  })

  it("asks no public indexer when the user turned them off", async () => {
    const chain = { ...testChain([DRPC]), blockscoutApi: "https://eth.blockscout.com/api/v2" }
    const off: Settings = { ...defaultSettings(), publicIndexers: false }
    const { deps, calls } = await session({ [new URL(DRPC.url).host]: archiveNode() }, off, chain)

    const match = await deps.sourcify.match(1, SAFE)
    await deps.reader.anchor({ block: null })
    await deps.creation.find(SAFE, BLOCK)

    expect(deps.publicIndexers).toBe(false)
    expect(match).toMatchObject({ ok: true, data: "not-checked" })
    expect(calls.some((c) => c.host === "eth.blockscout.com" || c.host === "sourcify.dev")).toBe(false)
  })

  it("counts localhost and 127.0.0.1 as one operator", () => {
    const chain = testChain([])
    const a = userEndpoint("http://localhost:8545", chain, [])
    const b = userEndpoint("http://127.0.0.1:8545", chain, [])

    expect(a.operator).toBe(b.operator)
    expect(canPair(a, b)).toBe(false)
  })
})

describe("history budget and log failover", () => {
  const range = (params: unknown[]) => {
    const { fromBlock, toBlock } = params[0] as { fromBlock: Hex; toBlock: Hex }
    return [BigInt(fromBlock), BigInt(toBlock)] as const
  }
  // Serves logs only for ranges up to `max` blocks; counts the chunks it served.
  const logNode = (max: bigint, served: [bigint, bigint][] = []) =>
    override(archiveNode(), {
      eth_getLogs: (_, params) => {
        const [from, to] = range(params)
        if (to - from + 1n > max) return new RpcError(-32602, "block range too large")
        served.push([from, to])
        return []
      },
    })

  it("asks the indexer first when the RPC would need more than 50 chunks", async () => {
    const chain = { ...testChain([DRPC, PUBLICNODE]), blockscoutApi: "https://eth.blockscout.com/api/v2" }
    const { deps, calls } = await session(
      {
        [new URL(DRPC.url).host]: logNode(100n),
        [new URL(PUBLICNODE.url).host]: archiveNode(),
        "eth.blockscout.com": () => new HttpAnswer(200, '{"items":[],"next_page_params":null}'),
      },
      defaultSettings(),
      chain,
    )
    await deps.reader.anchor({ block: null })

    const read = await deps.events.logs({ address: SAFE, fromBlock: BLOCK - 5_999n, toBlock: BLOCK })

    expect(read.source.service).toBe("blockscout")
    expect(calls.filter((c) => c.method === "eth_getLogs")).toHaveLength(3)
  })

  it("stops at the time budget and says how far it got", async () => {
    const { deps } = await session({
      [new URL(DRPC.url).host]: logNode(100n),
      [new URL(PUBLICNODE.url).host]: archiveNode(),
    })
    await deps.reader.anchor({ block: null })
    let clock = 0
    const events = new Events({
      reader: deps.reader as Reader,
      blockscout: null,
      etherscan: null,
      budgetMs: 1_000,
      now: () => (clock += 100),
    })

    const read = await events.logs({ address: SAFE, fromBlock: BLOCK - 99_999n, toBlock: BLOCK })

    expect(read).toMatchObject({ complete: false, stoppedBy: "time" })
    expect(read.toBlock).toBeLessThan(BLOCK)
    expect(read.toBlock).toBeGreaterThanOrEqual(BLOCK - 99_999n + 99n)
  })

  it("moves a chunk one RPC finds too large to another RPC that takes it whole", async () => {
    let narrowed = false
    const wide: [bigint, bigint][] = []
    const primary = override(logNode(1_000n), {
      eth_getLogs: (method, params) => (narrowed ? logNode(100n) : logNode(1_000n))(method, params),
    })
    const { deps } = await session(
      {
        [new URL(DRPC.url).host]: primary,
        [new URL(BLAST.url).host]: archiveNode(),
        [new URL(TEAM.url).host]: logNode(1_000n, wide),
      },
      defaultSettings(),
      testChain([DRPC, BLAST, TEAM]),
    )
    await deps.reader.anchor({ block: null })
    await (deps.reader as Reader).logsRange(SAFE)
    narrowed = true

    const read = await deps.events.logs({ address: SAFE, fromBlock: BLOCK - 2_999n, toBlock: BLOCK })

    expect(read.complete).toBe(true)
    expect(wide).toHaveLength(3)
  })

  it("moves a refused log chunk to the next log-capable RPC, and splits a range every RPC refuses", async () => {
    let limited = false
    const served: [bigint, bigint][] = []
    const primary = override(logNode(1_000n), {
      eth_getLogs: (method, params) =>
        limited ? new HttpAnswer(429, "slow down", { "retry-after": "60" }) : logNode(1_000n)(method, params),
    })
    const { deps } = await session(
      {
        [new URL(DRPC.url).host]: primary,
        [new URL(BLAST.url).host]: archiveNode(),
        [new URL(TEAM.url).host]: logNode(100n, served),
      },
      defaultSettings(),
      testChain([DRPC, BLAST, TEAM]),
    )
    await deps.reader.anchor({ block: null })
    await (deps.reader as Reader).logsRange(SAFE)
    limited = true

    const read = await deps.events.logs({ address: SAFE, fromBlock: BLOCK - 2_999n, toBlock: BLOCK })

    expect(read).toMatchObject({ complete: true, toBlock: BLOCK })
    expect(served.length).toBe(30)
    expect(served.every(([from, to]) => to - from + 1n === 100n)).toBe(true)
  })
})

describe("indexer items without a transaction hash", () => {
  const block = BLOCK - 20n
  const tx = keccak256("0x5afe")
  const item = (index: number) => ({
    address: { hash: SAFE },
    topics: [EVENT_TOPICS.EnabledModule, null, null, null],
    data: pad("0x01", { size: 32 }),
    block_number: Number(block),
    transaction_hash: "",
    index,
  })
  const page = { items: [item(4), item(3)], next_page_params: null }
  const rpcLog = (index: number) => ({
    address: SAFE,
    topics: [EVENT_TOPICS.EnabledModule],
    data: pad("0x01", { size: 32 }),
    blockNumber: numberToHex(block),
    transactionHash: tx,
    logIndex: numberToHex(index),
  })
  const run = async (blockLogs: Handler) => {
    const chain = { ...testChain([DRPC, PUBLICNODE]), blockscoutApi: "https://gnosisscan.io/api/v2" }
    const node = override(archiveNode(), {
      eth_getLogs: (method, params) => {
        const { fromBlock, toBlock } = params[0] as { fromBlock: Hex; toBlock: Hex }
        if (fromBlock === toBlock) return blockLogs(method, params)
        return BigInt(toBlock) - BigInt(fromBlock) + 1n > 100n ? new RpcError(-32602, "block range too large") : []
      },
    })
    const { deps } = await session(
      {
        [new URL(DRPC.url).host]: node,
        [new URL(PUBLICNODE.url).host]: archiveNode(),
        "gnosisscan.io": () => new HttpAnswer(200, JSON.stringify(page)),
      },
      defaultSettings(),
      chain,
    )
    await deps.reader.anchor({ block: null })
    return deps.events.logs({ address: SAFE, fromBlock: BLOCK - 100_000n, toBlock: BLOCK })
  }

  it("reads those blocks from the RPC and gets the hashes back", async () => {
    const read = await run(() => [rpcLog(3), rpcLog(4)])

    expect(read).toMatchObject({ source: { service: "blockscout" }, complete: true })
    expect(read.logs.map((l) => [l.logIndex, l.transactionHash])).toEqual([
      [3, tx],
      [4, tx],
    ])
  })

  it("never reports complete when those blocks cannot be read", async () => {
    const read = await run(() => new HttpAnswer(503, "down"))

    expect(read).toMatchObject({ complete: false, stoppedBy: "failure" })
    expect(read.logs).toEqual([])
  })
})
