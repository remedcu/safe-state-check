import { createMerkleProof, createMPT } from "@ethereumjs/mpt"
import { bytesToHex, type Hex, hexToBytes, numberToBytes, numberToHex, toRlp } from "viem"
import { EMPTY_TRIE_ROOT } from "@/core/proof"
import { ownerSlot } from "@/core/slots"
import { describe, expect, it } from "vitest"
import type { ReportIssue } from "@/core/report"
import { buildPool } from "@/data/endpoints"
import { CapabilityCache } from "@/data/probe"
import { Reader } from "@/data/reader"
import { defaultSettings } from "@/data/settings"
import { Transport } from "@/data/transport"
import { IoError, type ChainInfo, type DefaultRpc, type Settings } from "@/data/types"
import {
  archiveNode,
  BLAST,
  BLOCK,
  BLOCK_HASH,
  CODE_HASH,
  DRPC,
  type Handler,
  HttpAnswer,
  ONERPC,
  override,
  PROVIDERS,
  PUBLICNODE,
  RECORDED_HEADER,
  recordedProof,
  RpcError,
  SAFE,
  TEAM,
  SLOTS,
  STATE_ROOT,
  STORAGE_HASH,
  testChain,
  VALUES,
} from "@/data/__tests__/fakeRpc"
import { fakeNetwork } from "@/data/__tests__/fakeRpc"
import emptyStorage from "@/data/__tests__/fixtures/proof-empty-storage-26176126.json"

const host = (rpc: DefaultRpc) => new URL(rpc.url).host
const windowError = () => new RpcError(-32602, "distance to target block exceeds maximum proof window")

function setup(
  chain: ChainInfo,
  handlers: Record<string, Handler>,
  settings: Settings = defaultSettings(),
): { reader: Reader; issues: ReportIssue[]; calls: ReturnType<typeof fakeNetwork>["calls"] } {
  const network = fakeNetwork(handlers)
  const issues: ReportIssue[] = []
  const transport = new Transport({ fetch: network.fetch, sleep: async () => undefined })
  const reader = new Reader(chain, buildPool(chain, settings, PROVIDERS), {
    transport,
    capabilities: new CapabilityCache(),
    settings,
    onIssue: (issue) => issues.push(issue),
    probeAddress: SAFE,
  })
  return { reader, issues, calls: network.calls }
}

// Flips the last byte of the leaf, so the leaf no longer hashes to its parent's reference.
function tampered() {
  const proof = recordedProof()
  const last = proof.accountProof.length - 1
  const node = proof.accountProof[last]
  proof.accountProof[last] = `${node.slice(0, -2)}${(parseInt(node.slice(-2), 16) ^ 1).toString(16).padStart(2, "0")}`
  return proof
}

// A whole state trie made up by a lying RPC: the Safe's account with the real slots plus owners[0x...02], and proofs
// that verify against the forged trie's own root.
async function forgedProof() {
  const storage = await createMPT({ useKeyHashing: true })
  const slots: [Hex, bigint][] = [...VALUES, [ownerSlot("0x0000000000000000000000000000000000000002"), 1n]]
  for (const [slot, value] of slots) await storage.put(hexToBytes(slot), toRlp(numberToBytes(value), "bytes"))
  const state = await createMPT({ useKeyHashing: true })
  const account = toRlp([numberToHex(1), "0x", bytesToHex(storage.root()), CODE_HASH])
  await state.put(hexToBytes(SAFE), hexToBytes(account))
  return {
    address: SAFE,
    balance: "0x0",
    nonce: "0x1",
    codeHash: CODE_HASH,
    storageHash: bytesToHex(storage.root()),
    accountProof: (await createMerkleProof(state, hexToBytes(SAFE))).map((n) => bytesToHex(n)),
    storageProof: await Promise.all(
      slots.map(async ([key, value]) => ({
        key,
        value: numberToHex(value),
        proof: (await createMerkleProof(storage, hexToBytes(key))).map((n) => bytesToHex(n)),
      })),
    ),
  }
}

describe("anchor", () => {
  it("pins latest - 3 on the primary and confirms the header on another operator", async () => {
    const { reader } = setup(testChain([DRPC, PUBLICNODE]), {
      [host(DRPC)]: archiveNode(),
      [host(PUBLICNODE)]: archiveNode(),
    })

    const anchor = await reader.anchor({ block: null })

    expect(anchor).toMatchObject({ number: BLOCK, hash: BLOCK_HASH, stateRoot: STATE_ROOT, pinnedBy: "offset" })
    expect(anchor.header).toBe("match")
    expect(anchor.note).toBeNull()
    expect(reader.pair().primary.host).toBe("eth.drpc.org")
    expect(reader.pair().crossCheck?.host).toBe("ethereum-rpc.publicnode.com")
  })

  it("moves the primary to the next endpoint that proves the block and says why", async () => {
    const { reader, issues } = setup(testChain([DRPC, BLAST]), {
      [host(DRPC)]: override(archiveNode(), { eth_getProof: windowError }),
      [host(BLAST)]: archiveNode(),
    })

    const anchor = await reader.anchor({ block: null })

    expect(reader.pair().primary.host).toBe(host(BLAST))
    expect(anchor.note).toContain("eth.drpc.org could not prove block 26176126")
    expect(issues.map((i) => [i.kind, i.recovered])).toContainEqual(["proof-window", true])
  })

  it("never moves a user block: no proof at that block stops the run", async () => {
    const { reader } = setup(testChain([DRPC, BLAST]), {
      [host(DRPC)]: override(archiveNode(), { eth_getProof: windowError }),
      [host(BLAST)]: override(archiveNode(), { eth_getProof: windowError }),
    })

    const error = await reader.anchor({ block: BLOCK }).catch((e: unknown) => e)

    expect(error).toBeInstanceOf(IoError)
    expect((error as IoError).kind).toBe("proof-window")
  })

  it("falls to tip mode, binding the newest proof to the header whose stateRoot is its root", async () => {
    // Head is two blocks past the recorded one; the recorded proof is what "latest" returns.
    const head = BLOCK + 2n
    const headers = [
      RECORDED_HEADER,
      { number: head, hash: `0x${"aa".repeat(32)}` as Hex, stateRoot: `0x${"bb".repeat(32)}` as Hex },
      { number: head - 1n, hash: `0x${"cc".repeat(32)}` as Hex, stateRoot: `0x${"dd".repeat(32)}` as Hex },
      { number: head - 3n, hash: `0x${"ee".repeat(32)}` as Hex, stateRoot: `0x${"ff".repeat(32)}` as Hex },
    ]
    const tipOnly = override(archiveNode({ head, headers }), {
      eth_getProof: (_, params) => (params[2] === "latest" ? recordedProof() : windowError()),
    })
    const { reader, calls } = setup(testChain([PUBLICNODE, DRPC]), {
      [host(PUBLICNODE)]: tipOnly,
      [host(DRPC)]: override(archiveNode({ head, headers }), { eth_getProof: windowError }),
    })

    const anchor = await reader.anchor({ block: null })

    expect(anchor).toMatchObject({ number: BLOCK, hash: BLOCK_HASH, pinnedBy: "tip", header: "match" })
    expect(anchor.note).toContain("tip mode")
    const read = await reader.proveAccount(SAFE, SLOTS.slice(0, 2))
    const again = await reader.proveAccount(SAFE, SLOTS.slice(2, 4))
    expect(read.anchor.number).toBe(BLOCK)
    // Each tip read of the Safe re-requests every key asked so far.
    expect(again.values.size).toBe(4)
    const lastProof = calls.filter((c) => c.method === "eth_getProof").at(-1)
    expect(lastProof?.params[1]).toHaveLength(4)
    // The cross-check confirmed the tip block's header.
    expect(
      calls.some(
        (c) => c.host === host(DRPC) && c.method === "eth_getBlockByNumber" && c.params[0] === numberToHex(BLOCK),
      ),
    ).toBe(true)
  })

  it("anchors header-only when no endpoint serves proofs, and proveAccount refuses", async () => {
    const noProofs = override(archiveNode(), { eth_getProof: () => new RpcError(-32601, "method not found") })
    const { reader } = setup(testChain([DRPC, BLAST]), { [host(DRPC)]: noProofs, [host(BLAST)]: noProofs })

    const anchor = await reader.anchor({ block: null })
    const refused = await reader.proveAccount(SAFE, SLOTS).catch((e: unknown) => e)
    const unproven = await reader.readUnproven(SAFE, SLOTS.slice(0, 3))

    expect(anchor.note).toContain("without proofs")
    expect((refused as IoError).kind).toBe("method-unsupported")
    expect(reader.capabilities().find((c) => c.host === host(DRPC))?.missing).toContain("proofs")
    expect(unproven.values.get(SLOTS[0])).toBe(VALUES.get(SLOTS[0]))
    expect(unproven.cross.values).toBe("match")
  })

  it("skips an endpoint that serves another chain", async () => {
    const { reader, issues } = setup(testChain([DRPC, BLAST]), {
      [host(DRPC)]: archiveNode({ chainId: 10 }),
      [host(BLAST)]: archiveNode(),
    })

    await reader.anchor({ block: null })

    expect(reader.pair().primary.host).toBe(host(BLAST))
    expect(issues.find((i) => i.kind === "wrong-chain")?.explanation).toBe("eth.drpc.org serves chain 10, not 1.")
  })
})

describe("pair rules", () => {
  it("never pairs two aggregators", async () => {
    const { reader } = setup(testChain([DRPC, ONERPC]), {
      [host(DRPC)]: archiveNode(),
      [host(ONERPC)]: archiveNode(),
    })

    const anchor = await reader.anchor({ block: null })

    expect(anchor.header).toBe("not-run")
    expect(reader.pair().crossCheck).toBeNull()
    expect(reader.pair().crossCheckMissing).toContain("aggregators")
  })

  it("never pairs an operator with itself, defaults off leaves the user's RPC alone", async () => {
    const settings: Settings = {
      ...defaultSettings(),
      rpcs: { "1": { primary: "https://my-node.example/rpc", crossCheck: null, useDefaults: false } },
    }
    const { reader, calls } = setup(testChain([DRPC, BLAST]), { "my-node.example": archiveNode() }, settings)

    const anchor = await reader.anchor({ block: null })

    expect(anchor.header).toBe("not-run")
    expect(anchor.selfTrusted).toBeUndefined()
    expect(calls.every((c) => c.host === "my-node.example")).toBe(true)
  })

  it("trusts the user's own node alone only when it is marked and no other operator answers", async () => {
    const own = (useDefaults: boolean): Settings => ({
      ...defaultSettings(),
      rpcs: { "1": { primary: "https://my-node.example/rpc", crossCheck: null, useDefaults, ownNode: true } },
    })
    const alone = setup(testChain([BLAST]), { "my-node.example": archiveNode() }, own(false))
    const withDefaults = setup(
      testChain([BLAST]),
      { "my-node.example": archiveNode(), [host(BLAST)]: archiveNode() },
      own(true),
    )

    expect((await alone.reader.anchor({ block: null })).selfTrusted).toBe(true)
    const anchor = await withDefaults.reader.anchor({ block: null })
    expect(anchor.selfTrusted).toBeUndefined()
    expect(anchor.header).toBe("match")
  })

  it("reports a header the cross-check disagrees on", async () => {
    const forked = { ...RECORDED_HEADER, hash: `0x${"99".repeat(32)}` as Hex }
    const { reader, issues } = setup(testChain([DRPC, PUBLICNODE]), {
      [host(DRPC)]: archiveNode(),
      [host(PUBLICNODE)]: archiveNode({ headers: [forked] }),
    })

    const anchor = await reader.anchor({ block: null })

    expect(anchor.header).toBe("mismatch")
    expect(issues.map((i) => i.kind)).toContain("disagreement")
  })
})

describe("proveAccount", () => {
  it("verifies every slot against the anchor and cross-checks the values", async () => {
    const { reader } = setup(testChain([DRPC, PUBLICNODE]), {
      [host(DRPC)]: archiveNode(),
      [host(PUBLICNODE)]: override(archiveNode(), { eth_getProof: windowError }),
    })
    await reader.anchor({ block: null })

    const read = await reader.proveAccount(SAFE, SLOTS)

    expect(read.account).toMatchObject({ storageHash: STORAGE_HASH, codeHash: CODE_HASH })
    expect([...read.values]).toEqual([...VALUES].map(([k, v]) => [k.toLowerCase(), v]))
    expect(read.servedBy).toBe("eth.drpc.org")
    expect(read.cross).toEqual({ storageRoot: "not-served", values: "match", mismatched: [] })
  })

  it("flags a cross-check value that differs", async () => {
    const lying = override(archiveNode(), {
      eth_getProof: windowError,
      eth_getStorageAt: (_, params) =>
        params[1] === SLOTS[2] ? numberToHex(7n, { size: 32 }) : archiveNode()("eth_getStorageAt", params),
    })
    const { reader, issues } = setup(testChain([DRPC, PUBLICNODE]), {
      [host(DRPC)]: archiveNode(),
      [host(PUBLICNODE)]: lying,
    })
    await reader.anchor({ block: null })

    const read = await reader.proveAccount(SAFE, SLOTS)

    expect(read.cross.values).toBe("mismatch")
    expect(read.cross.mismatched).toEqual([SLOTS[2]])
    expect(issues.map((i) => i.kind)).toContain("disagreement")
  })

  it("maps a forged proof to proof-invalid and repeats the read elsewhere", async () => {
    let anchorDone = false
    const { reader, issues } = setup(testChain([DRPC, BLAST]), {
      [host(DRPC)]: override(archiveNode(), { eth_getProof: () => (anchorDone ? tampered() : recordedProof()) }),
      [host(BLAST)]: archiveNode(),
    })
    await reader.anchor({ block: null })
    anchorDone = true

    const read = await reader.proveAccount(SAFE, SLOTS)

    expect(read.servedBy).toBe(host(BLAST))
    expect(issues.find((i) => i.kind === "proof-invalid")).toMatchObject({ host: "eth.drpc.org", recovered: true })
  })

  it("rejects a self-consistent proof from a forged trie that hides a shadow owner", async () => {
    let anchorDone = false
    const forged = await forgedProof()
    const { reader, issues } = setup(testChain([DRPC]), {
      [host(DRPC)]: override(archiveNode(), { eth_getProof: () => (anchorDone ? forged : recordedProof()) }),
    })
    await reader.anchor({ block: null })
    anchorDone = true

    const error = await reader.proveAccount(SAFE, SLOTS).catch((e: unknown) => e)

    expect((error as IoError).kind).toBe("proof-invalid")
    expect(issues).toHaveLength(0)
  })

  it("anchors header-only on non-MPT proofs and refuses proven reads with one kind", async () => {
    const zkTrie = () => ({ ...recordedProof(), accountProof: ["0x09aabb"] })
    const { reader } = setup(testChain([DRPC]), { [host(DRPC)]: override(archiveNode(), { eth_getProof: zkTrie }) })

    const anchor = await reader.anchor({ block: null })

    expect(anchor.headerOnly).toBe("unsupported")
    expect(reader.capabilities()[0].missing).toContain("proofs")
    const refused = await reader.proveAccount(SAFE, SLOTS).catch((e: unknown) => e)
    expect((refused as IoError).issue.kind).toBe("method-unsupported")
  })

  it("calls a proof mismatch the chain's format, not a lying RPC, on a chain known to use other proofs", async () => {
    const chain: ChainInfo = { ...testChain([DRPC]), rootCheck: { status: "unsupported", reason: "Other proofs." } }
    const { reader, issues } = setup(chain, { [host(DRPC)]: override(archiveNode(), { eth_getProof: tampered }) })

    const anchor = await reader.anchor({ block: null })

    expect(anchor.headerOnly).toBe("unsupported")
    expect(issues.map((i) => i.kind)).toEqual(["non-mpt"])
  })

  it("says header-only because of the proof window when no RPC proves recent blocks", async () => {
    const { reader } = setup(testChain([DRPC]), {
      [host(DRPC)]: override(archiveNode(), { eth_getProof: windowError }),
    })

    const anchor = await reader.anchor({ block: null })
    const refused = await reader.proveAccount(SAFE, SLOTS).catch((e: unknown) => e)

    expect(anchor.headerOnly).toBe("no-proof-rpc")
    expect((refused as IoError).issue.kind).toBe("method-unsupported")
  })

  it("treats a non-MPT answer after a verified anchor as an invalid proof", async () => {
    let anchorDone = false
    const zkTrie = () => (anchorDone ? { ...recordedProof(), accountProof: ["0x09aabb"] } : recordedProof())
    const { reader } = setup(testChain([DRPC]), { [host(DRPC)]: override(archiveNode(), { eth_getProof: zkTrie }) })
    await reader.anchor({ block: null })
    anchorDone = true

    const error = await reader.proveAccount(SAFE, SLOTS).catch((e: unknown) => e)

    expect((error as IoError).kind).toBe("proof-invalid")
  })

  it("moves a proven read on after any failure, a revert included", async () => {
    let anchorDone = false
    const reverting = override(archiveNode(), {
      eth_getProof: () => (anchorDone ? new RpcError(3, "execution reverted") : recordedProof()),
    })
    const { reader, issues } = setup(testChain([DRPC, BLAST, TEAM]), {
      [host(DRPC)]: reverting,
      [host(BLAST)]: override(archiveNode(), { eth_getProof: windowError }),
      [host(TEAM)]: archiveNode(),
    })
    await reader.anchor({ block: null })
    anchorDone = true

    const read = await reader.proveAccount(SAFE, SLOTS)

    expect(reader.pair().crossCheck?.host).toBe(host(BLAST))
    expect(read.servedBy).toBe(host(TEAM))
    expect(issues.find((i) => i.kind === "reverted")).toMatchObject({ host: "eth.drpc.org", recovered: true })
  })

  it("uses the cross-check's own verified proof when every other endpoint fails, comparing nothing", async () => {
    let anchorDone = false
    const { reader } = setup(testChain([DRPC, BLAST]), {
      [host(DRPC)]: override(archiveNode(), {
        eth_getProof: () => (anchorDone ? new RpcError(3, "execution reverted") : recordedProof()),
      }),
      [host(BLAST)]: archiveNode(),
    })
    await reader.anchor({ block: null })
    anchorDone = true

    const read = await reader.proveAccount(SAFE, SLOTS)

    expect(read.servedBy).toBe(host(BLAST))
    expect(read.account?.storageHash).toBe(STORAGE_HASH)
    expect(read.cross).toEqual({ storageRoot: "not-served", values: "not-served", mismatched: [] })
  })

  it("reads every slot of a proven empty storage trie as zero", async () => {
    // The node proves the empty trie with no nodes at all, which core/proof.ts accepts for the empty root.
    const owner = emptyStorage.proof.address as Hex
    const { reader } = setup(testChain([DRPC]), {
      [host(DRPC)]: override(archiveNode(), {
        eth_getProof: (_, params) => (params[0] === owner ? structuredClone(emptyStorage.proof) : recordedProof()),
      }),
    })
    await reader.anchor({ block: null })

    const read = await reader.proveAccount(owner, [SLOTS[0]])

    expect(read.account?.storageHash).toBe(EMPTY_TRIE_ROOT)
    expect(read.values.get(SLOTS[0])).toBe(0n)
  })

  it("reads Scroll's keccakCodeHash as the code hash", async () => {
    const scroll = () => {
      const { codeHash, ...rest } = recordedProof()
      return { ...rest, keccakCodeHash: codeHash, poseidonCodeHash: `0x${"12".repeat(32)}` }
    }
    const { reader } = setup(testChain([DRPC]), { [host(DRPC)]: override(archiveNode(), { eth_getProof: scroll }) })
    await reader.anchor({ block: null })

    const read = await reader.proveAccount(SAFE, SLOTS)

    expect(read.account?.codeHash).toBe(CODE_HASH)
  })
})

describe("other reads", () => {
  it("compares eth_call on the cross-check", async () => {
    const answer = (data: Hex): Handler => override(archiveNode(), { eth_call: () => data, eth_getProof: windowError })
    const same = setup(testChain([DRPC, PUBLICNODE]), {
      [host(DRPC)]: override(archiveNode(), { eth_call: () => "0x01" }),
      [host(PUBLICNODE)]: answer("0x01"),
    })
    const different = setup(testChain([DRPC, PUBLICNODE]), {
      [host(DRPC)]: override(archiveNode(), { eth_call: () => "0x01" }),
      [host(PUBLICNODE)]: answer("0x02"),
    })
    await same.reader.anchor({ block: null })
    await different.reader.anchor({ block: null })

    expect((await same.reader.call(SAFE, "0xa0e67e2b")).cross).toBe("match")
    expect((await different.reader.call(SAFE, "0xa0e67e2b")).cross).toBe("mismatch")
  })

  it("throws reverted without trying other endpoints", async () => {
    const { reader, calls } = setup(testChain([DRPC, BLAST]), {
      [host(DRPC)]: override(archiveNode(), { eth_call: () => new RpcError(3, "execution reverted") }),
      [host(BLAST)]: archiveNode(),
    })
    await reader.anchor({ block: null })

    const error = await reader.call(SAFE, "0x12345678").catch((e: unknown) => e)

    expect((error as IoError).kind).toBe("reverted")
    expect(calls.filter((c) => c.method === "eth_call" && c.host === host(BLAST))).toHaveLength(1)
  })

  it("rejects code that does not match the proven code hash", async () => {
    const { reader } = setup(testChain([DRPC]), {
      [host(DRPC)]: override(archiveNode(), { eth_getCode: () => "0x6001" }),
    })
    await reader.anchor({ block: null })

    const error = await reader.code(SAFE, CODE_HASH).catch((e: unknown) => e)

    expect((error as IoError).kind).toBe("invalid-response")
  })

  it("rechecks the anchor hash on both endpoints", async () => {
    let reorged = false
    const moving: Handler = (method, params) =>
      method === "eth_getBlockByNumber" && reorged
        ? { ...(archiveNode()(method, params) as object), hash: `0x${"77".repeat(32)}` }
        : archiveNode()(method, params)
    const { reader } = setup(testChain([DRPC, PUBLICNODE]), { [host(DRPC)]: archiveNode(), [host(PUBLICNODE)]: moving })
    const anchor = await reader.anchor({ block: null })

    expect(await reader.recheckAnchor(anchor)).toBe("unchanged")
    reorged = true
    expect(await reader.recheckAnchor(anchor)).toBe("changed")
    // The restart pins again from scratch and sees the new hash.
    expect((await reader.anchor({ block: null })).header).toBe("mismatch")
  })

  it("fails a rate-limited read over to another operator, never onto the cross-check", async () => {
    const answers = (data: Hex) => override(archiveNode(), { eth_call: () => data })
    const limited = override(archiveNode(), { eth_call: () => new HttpAnswer(429, "slow down") })
    const three = setup(testChain([DRPC, BLAST, PUBLICNODE]), {
      [host(DRPC)]: limited,
      [host(BLAST)]: answers("0x01"),
      [host(PUBLICNODE)]: answers("0x01"),
    })
    const two = setup(testChain([DRPC, BLAST]), { [host(DRPC)]: limited, [host(BLAST)]: answers("0x01") })
    await three.reader.anchor({ block: null })
    await two.reader.anchor({ block: null })

    const read = await three.reader.call(SAFE, "0xa0e67e2b")
    const error = await two.reader.call(SAFE, "0xa0e67e2b").catch((e: unknown) => e)

    expect(three.reader.pair().crossCheck?.host).toBe(host(BLAST))
    expect(read).toMatchObject({ servedBy: host(PUBLICNODE), cross: "match" })
    expect(three.issues.find((i) => i.kind === "rate-limited")).toMatchObject({ recovered: true, raw: { attempts: 3 } })
    expect((error as IoError).kind).toBe("rate-limited")
    expect(two.calls.filter((c) => c.method === "eth_call" && c.host === host(BLAST))).toHaveLength(1)
  })

  it("takes a transaction only the cross-check has, labelled single-source, on a chain with two RPCs", async () => {
    const tx = { from: SAFE, to: null, input: "0xb63e800d", blockNumber: numberToHex(BLOCK - 5n) }
    const pruned = override(archiveNode(), {
      eth_getTransactionByHash: () => null,
      eth_getTransactionReceipt: () => null,
    })
    const full = override(archiveNode(), {
      eth_getTransactionByHash: () => tx,
      eth_getTransactionReceipt: () => ({ status: "0x1", logs: [] }),
    })
    const both = setup(testChain([DRPC, BLAST]), { [host(DRPC)]: pruned, [host(BLAST)]: full })
    const neither = setup(testChain([DRPC, BLAST]), { [host(DRPC)]: pruned, [host(BLAST)]: pruned })
    await both.reader.anchor({ block: null })
    await neither.reader.anchor({ block: null })
    const hash: Hex = `0x${"cd".repeat(32)}`

    expect(both.reader.pair().crossCheck?.host).toBe(host(BLAST))
    expect(await both.reader.transaction(hash)).toMatchObject({
      input: "0xb63e800d",
      cross: "not-served",
      singleSource: true,
    })
    expect(await both.reader.receiptLogs(hash)).toEqual([])
    expect(both.issues.find((i) => i.kind === "not-found")).toMatchObject({ recovered: true })
    await expect(neither.reader.transaction(hash)).rejects.toMatchObject({ issue: { kind: "not-found" } })
  })

  it("compares the creation transaction with the cross-check, and moves past a pruned index", async () => {
    const tx = (input: Hex) => ({ from: SAFE, to: null, input, blockNumber: numberToHex(BLOCK - 5n) })
    const receipt = { status: "0x1", logs: [] }
    const node = (input: Hex | null) =>
      override(archiveNode(), {
        eth_getTransactionByHash: () => (input === null ? null : tx(input)),
        eth_getTransactionReceipt: () => (input === null ? null : receipt),
      })
    const { reader, issues } = setup(testChain([DRPC, BLAST, TEAM]), {
      [host(DRPC)]: node(null),
      [host(BLAST)]: node("0xbeef"),
      [host(TEAM)]: node("0xb63e800d"),
    })
    await reader.anchor({ block: null })

    const read = await reader.transaction(`0x${"ab".repeat(32)}`)

    expect(read).toMatchObject({ input: "0xb63e800d", blockNumber: BLOCK - 5n, cross: "mismatch" })
    expect(issues.map((i) => i.kind)).toEqual(expect.arrayContaining(["not-found", "disagreement"]))
  })
})

describe("independence and recovery", () => {
  it("never lets the cross-check's operator serve a tip-mode proof it would then confirm itself", async () => {
    const head = BLOCK + 2n
    const headers = [
      RECORDED_HEADER,
      { number: head, hash: `0x${"aa".repeat(32)}` as Hex, stateRoot: `0x${"bb".repeat(32)}` as Hex },
      { number: head - 1n, hash: `0x${"cc".repeat(32)}` as Hex, stateRoot: `0x${"dd".repeat(32)}` as Hex },
      { number: head - 3n, hash: `0x${"ee".repeat(32)}` as Hex, stateRoot: `0x${"ff".repeat(32)}` as Hex },
    ]
    let reads = 0
    const tipOnly = override(archiveNode({ head, headers }), {
      eth_getProof: (_, params) => {
        if (params[2] !== "latest") return windowError()
        return ++reads > 1 ? new HttpAnswer(429, "slow down") : recordedProof()
      },
    })
    // The cross-check could serve a tip proof too, but must only confirm headers.
    const crossCheck = override(archiveNode({ head, headers }), {
      eth_getProof: (_, params) => (params[2] === "latest" ? recordedProof() : new HttpAnswer(429, "busy")),
    })
    const { reader, calls } = setup(testChain([PUBLICNODE, DRPC]), {
      [host(PUBLICNODE)]: tipOnly,
      [host(DRPC)]: crossCheck,
    })
    await reader.anchor({ block: null })

    const error = await reader.proveAccount(SAFE, SLOTS).catch((e: unknown) => e)

    expect(reader.pair().crossCheck?.host).toBe(host(DRPC))
    expect((error as IoError).kind).toBe("rate-limited")
    expect(calls.some((c) => c.host === host(DRPC) && c.method === "eth_getProof" && c.params[2] === "latest")).toBe(
      false,
    )
  })

  it("names a user block past the chain's newest block as the user's input, once, without asking for headers", async () => {
    const { reader, issues, calls } = setup(testChain([DRPC, BLAST]), {
      [host(DRPC)]: archiveNode(),
      [host(BLAST)]: archiveNode({ head: BLOCK + 1n }),
    })

    const error = await reader.anchor({ block: 99_999_999n }).catch((e: unknown) => e)

    expect((error as IoError).issue).toMatchObject({
      kind: "block-unavailable",
      title: "Block is in the future",
      explanation: `Block 99999999 is after the newest block (${BLOCK + 3n}) on this chain.`,
      actions: ["Check the block number, or leave it empty."],
    })
    expect(issues).toHaveLength(0)
    expect(calls.some((c) => c.method === "eth_getBlockByNumber")).toBe(false)
  })

  it("reports every anchor failure except the one it throws", async () => {
    const { reader, issues } = setup(testChain([DRPC, BLAST]), {
      [host(DRPC)]: override(archiveNode(), { eth_getBlockByNumber: () => new HttpAnswer(403, "denied") }),
      [host(BLAST)]: override(archiveNode(), { eth_getBlockByNumber: () => new HttpAnswer(401, "denied") }),
    })

    const error = await reader.anchor({ block: null }).catch((e: unknown) => e)

    expect((error as IoError).issue.host).toBe("eth.drpc.org")
    expect(issues.map((i) => i.host)).toEqual([host(BLAST)])
  })

  it("rechecks the anchor on whichever endpoint answers", async () => {
    let limited = false
    const primary = override(archiveNode(), {
      eth_getBlockByNumber: (method, params) =>
        limited ? new HttpAnswer(429, "slow", { "retry-after": "60" }) : archiveNode()(method, params),
    })
    const { reader } = setup(testChain([DRPC, PUBLICNODE]), {
      [host(DRPC)]: primary,
      [host(PUBLICNODE)]: archiveNode(),
    })
    const anchor = await reader.anchor({ block: null })
    limited = true

    expect(await reader.recheckAnchor(anchor)).toBe("unchanged")
    expect(await reader.recheckAnchor({ ...anchor, hash: `0x${"12".repeat(32)}` })).toBe("changed")
  })

  it("reads history from another endpoint when the primary serves no logs", async () => {
    const { reader } = setup(testChain([DRPC, BLAST, TEAM]), {
      [host(DRPC)]: override(archiveNode(), {
        eth_getLogs: () => new HttpAnswer(403, '{"error":{"message":"Archive requests require a personal token"}}'),
      }),
      [host(BLAST)]: archiveNode(),
      [host(TEAM)]: override(archiveNode(), { eth_getLogs: () => [] }),
    })
    await reader.anchor({ block: null })

    expect(await reader.logsRange(SAFE)).toBe(10_000)
    expect(reader.logsHost()).toBe(host(TEAM))
  })

  it("hands each endpoint's client version to the verification section", async () => {
    const { reader } = setup(testChain([DRPC, PUBLICNODE]), {
      [host(DRPC)]: archiveNode(),
      [host(PUBLICNODE)]: archiveNode(),
    })
    await reader.anchor({ block: null })
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(reader.capabilities().map((c) => c.clientVersion)).toEqual(["test/1.0", "test/1.0"])
  })
})
