// Probes one RPC the way the browser app will use it: CORS preflight for a JSON POST, eth_chainId, the header at
// latest - 3, and eth_getProof there verified with src/core/proof.ts. Endpoints that only prove the newest block get
// one tip-mode try (the proof's root matched to a recent header). Requests go through the app's own transport, so
// failures are classified with the same rules the app uses.
import { type Address, type GetProofReturnType, type Hex, hexToBigInt, keccak256, numberToHex } from "viem"
import { verifyAccountProof, verifyStorageProof } from "@/core/proof"
import type { IssueKind } from "@/core/report"
import { slotKey } from "@/core/slots"
import { ioErrorOf, issueOf } from "@/data/errors"
import { otherAccountFormat, proofClient } from "@/data/reader"
import { Transport } from "@/data/transport"
import { type Endpoint, IoError } from "@/data/types"
import { USER_AGENT } from "./http"

export const PROBE_ORIGIN = "https://example.pages.dev"
export const BLOCK_OFFSET = 3n
// Safe singleton slot 4 is `threshold`, 1 on every singleton from 1.3.0 on, so this is an inclusion proof.
export const PROOF_SLOT = slotKey(4n)
export const PROBE_TIMEOUT_MS = 8_000
const TIP_OFFSETS = [0n, 1n, 2n, 3n, 4n, -1n]

export type ProofStatus = "verified" | "window" | "unsupported" | "non-mpt" | "invalid" | "error"

export type RpcProbe = {
  chainId: "ok" | "mismatch" | "error"
  chainIdDetail: string | null
  corsPreflight: {
    ok: boolean
    status: number | null
    allowOrigin: string | null
    allowHeaders: string | null
    error: string | null
  }
  corsPost: { ok: boolean; allowOrigin: string | null }
  header: { ok: boolean; block: string | null; detail: string | null }
  proof: { status: ProofStatus; kind: IssueKind | null; detail: string | null } | null
  // One try at the newest block, for endpoints whose proof window excludes latest - 3.
  tip: { status: "verified" | "failed"; block: string | null; detail: string | null } | null
  clientVersion: string | null
  latencyMs: number | null
  probedAt: string
}

function proofStatus(kind: IssueKind): ProofStatus {
  if (kind === "proof-window" || kind === "not-archive") return "window"
  if (kind === "method-unsupported" || kind === "plan-unsupported") return "unsupported"
  if (kind === "non-mpt") return "non-mpt"
  if (kind === "proof-invalid") return "invalid"
  return "error"
}

async function preflight(url: string, timeoutMs: number): Promise<RpcProbe["corsPreflight"]> {
  try {
    const res = await fetch(url, {
      method: "OPTIONS",
      headers: {
        origin: PROBE_ORIGIN,
        "access-control-request-method": "POST",
        "access-control-request-headers": "content-type",
        "user-agent": USER_AGENT,
      },
      signal: AbortSignal.timeout(timeoutMs),
      redirect: "manual",
    })
    await res.arrayBuffer().catch(() => undefined)
    const allowOrigin = res.headers.get("access-control-allow-origin")
    const allowHeaders = res.headers.get("access-control-allow-headers")
    const allowMethods = res.headers.get("access-control-allow-methods")
    // Fetch spec, non-credentialed request: POST is a safelisted method; a `*` item is a wildcard in either list; the
    // content-type header must be allowed; the origin must match exactly.
    const items = (v: string | null) =>
      (v ?? "")
        .toLowerCase()
        .split(",")
        .map((x) => x.trim())
    const headerOk = items(allowHeaders).some((h) => h === "*" || h === "content-type")
    const methodOk = allowMethods === null || items(allowMethods).some((m) => m === "*" || m === "post")
    const originOk = allowOrigin === "*" || allowOrigin === PROBE_ORIGIN
    const ok = res.status >= 200 && res.status < 300 && originOk && headerOk && methodOk
    return { ok, status: res.status, allowOrigin, allowHeaders, error: null }
  } catch (error) {
    const name = (error as Error).name
    return {
      ok: false,
      status: null,
      allowOrigin: null,
      allowHeaders: null,
      error: name === "TimeoutError" ? "timeout" : (error as Error).message.slice(0, 160),
    }
  }
}

async function verifyProof(stateRoot: Hex, address: Address, proof: GetProofReturnType): Promise<void> {
  const account = await verifyAccountProof(stateRoot, address, proof)
  const entry = proof.storageProof[0]
  if (!entry) throw new Error("no storage proof returned")
  if (account === null) {
    if (entry.value !== 0n) throw new Error("the account does not exist but the slot is non-zero")
    return
  }
  await verifyStorageProof(account.storageHash, PROOF_SLOT, entry)
}

export async function probeRpc(
  endpoint: Endpoint,
  chainId: number,
  address: Address | null,
  options: { timeoutMs?: number; tip?: boolean } = {},
): Promise<RpcProbe> {
  const timeoutMs = options.timeoutMs ?? PROBE_TIMEOUT_MS
  const latencies: number[] = []
  let allowOrigin: string | null = null
  // Node's fetch sends no Origin; the browser will, and CORS answers depend on it.
  const transport = new Transport({
    limits: { perHost: 4, total: 1_000 },
    fetch: async (input, init) => {
      const started = performance.now()
      const res = await fetch(input, {
        ...init,
        headers: { ...(init?.headers as Record<string, string>), origin: PROBE_ORIGIN, "user-agent": USER_AGENT },
      })
      latencies.push(Math.round(performance.now() - started))
      allowOrigin = res.headers.get("access-control-allow-origin")
      return res
    },
  })
  const ctx = { role: "detection" as const, operation: "probe", timeoutMs, attempts: 2 }
  const rpc = (method: string, params: unknown[]) => transport.rpc(endpoint, method, params, ctx)
  const probe: RpcProbe = {
    chainId: "error",
    chainIdDetail: null,
    corsPreflight: await preflight(endpoint.url, timeoutMs),
    corsPost: { ok: false, allowOrigin: null },
    header: { ok: false, block: null, detail: null },
    proof: null,
    tip: null,
    clientVersion: null,
    latencyMs: null,
    probedAt: new Date().toISOString(),
  }
  const finish = () => {
    latencies.sort((a, b) => a - b)
    probe.latencyMs = latencies.length ? latencies[Math.floor(latencies.length / 2)] : null
    return probe
  }

  try {
    const id = await rpc("eth_chainId", [])
    probe.corsPost = { ok: allowOrigin === "*" || allowOrigin === PROBE_ORIGIN, allowOrigin }
    if (typeof id !== "string" || BigInt(id) !== BigInt(chainId)) {
      probe.chainId = "mismatch"
      probe.chainIdDetail = `returned ${String(id)}`
      return finish()
    }
    probe.chainId = "ok"
  } catch (error) {
    probe.chainIdDetail =
      `${issueOf(error).kind}: ${issueOf(error).raw.message ?? issueOf(error).raw.body ?? ""}`.slice(0, 200)
    return finish()
  }
  try {
    const version = await rpc("web3_clientVersion", [])
    probe.clientVersion = typeof version === "string" ? version.slice(0, 80) : null
  } catch (error) {
    issueOf(error)
  }

  let stateRoot: Hex
  let block: bigint
  try {
    block = hexToBigInt((await rpc("eth_blockNumber", [])) as Hex) - BLOCK_OFFSET
    const header = (await rpc("eth_getBlockByNumber", [numberToHex(block), false])) as { stateRoot?: Hex } | null
    if (!header?.stateRoot)
      throw new IoError(transport.issue("block-unavailable", endpoint, "eth_getBlockByNumber", ctx))
    stateRoot = header.stateRoot
    probe.header = { ok: true, block: block.toString(), detail: null }
  } catch (error) {
    const issue = issueOf(error)
    probe.header = {
      ok: false,
      block: null,
      detail: `${issue.kind}: ${issue.raw.message ?? issue.raw.body ?? ""}`.slice(0, 200),
    }
    return finish()
  }
  if (!address) return finish()

  const client = proofClient(transport, endpoint, ctx)
  const proveAt = async (root: Hex, proof: GetProofReturnType) => {
    try {
      await verifyProof(root, address, proof)
    } catch (error) {
      if (ioErrorOf(error)) throw error
      const kind = (await otherAccountFormat(root, address, proof)) ? "non-mpt" : "proof-invalid"
      throw new IoError(transport.issue(kind, endpoint, "eth_getProof", ctx, (error as Error).message))
    }
  }
  try {
    await proveAt(stateRoot, await client.getProof({ address, storageKeys: [PROOF_SLOT], blockNumber: block }))
    probe.proof = { status: "verified", kind: null, detail: null }
  } catch (error) {
    const issue = issueOf(error)
    probe.proof = {
      status: proofStatus(issue.kind),
      kind: issue.kind,
      detail: (issue.raw.message ?? issue.raw.body ?? "").slice(0, 200),
    }
  }

  if (probe.proof.status === "window" && options.tip !== false) {
    try {
      const proof = await client.getProof({ address, storageKeys: [PROOF_SLOT], blockTag: "latest" })
      const root = keccak256(proof.accountProof[0] ?? "0x")
      const head = hexToBigInt((await rpc("eth_blockNumber", [])) as Hex)
      let matched: bigint | null = null
      for (const offset of TIP_OFFSETS) {
        const header = (await rpc("eth_getBlockByNumber", [numberToHex(head - offset), false]).catch(() => null)) as {
          stateRoot?: Hex
        } | null
        if (header?.stateRoot === root) {
          matched = head - offset
          break
        }
      }
      if (matched === null) throw new Error(`the proof root matched no header from ${head - 4n} to ${head + 1n}`)
      await proveAt(root, proof)
      probe.tip = { status: "verified", block: matched.toString(), detail: null }
    } catch (error) {
      const io = ioErrorOf(error)
      probe.tip = {
        status: "failed",
        block: null,
        detail: (io ? `${io.issue.kind}: ${io.issue.raw.message ?? ""}` : (error as Error).message).slice(0, 200),
      }
    }
  }
  return finish()
}

// A Blockscout instance counts when API v2 answers with CORS for any origin and its eth-rpc serves the right chain.
// The instance's chain is its eth-rpc chain id, or, when that endpoint is rate limited (Base answers 429 there while
// API v2 works), block 1's hash compared with the chain's own RPC.
export async function probeBlockscout(
  explorerUrl: string,
  chainId: number,
  timeoutMs = PROBE_TIMEOUT_MS,
  rpcUrl: string | null = null,
): Promise<{ apiBase: string; ok: boolean; detail: string | null }> {
  const base = explorerUrl.replace(/\/+$/, "")
  const apiBase = `${base}/api/v2`
  const headers = { origin: PROBE_ORIGIN, "user-agent": USER_AGENT }
  const get = (url: string, init: RequestInit = {}) =>
    fetch(url, { headers, ...init, signal: AbortSignal.timeout(timeoutMs), redirect: "manual" })
  try {
    const stats = await get(`${apiBase}/stats`)
    const allowOrigin = stats.headers.get("access-control-allow-origin")
    const text = await stats.text()
    if (stats.status !== 200) return { apiBase, ok: false, detail: `stats HTTP ${stats.status}` }
    JSON.parse(text)
    if (allowOrigin !== "*" && allowOrigin !== PROBE_ORIGIN)
      return { apiBase, ok: false, detail: `CORS ${allowOrigin}` }
    const rpc = await get(`${base}/api/eth-rpc`, {
      method: "POST",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] }),
    })
    const answer = (await rpc.json().catch(() => ({}))) as { result?: unknown }
    if (typeof answer.result === "string") {
      const chainOk = BigInt(answer.result) === BigInt(chainId)
      return { apiBase, ok: chainOk, detail: chainOk ? null : `chain ${answer.result}` }
    }
    if (!rpcUrl) return { apiBase, ok: false, detail: `eth-rpc HTTP ${rpc.status}, no RPC to compare block 1` }
    const theirs = (await (await get(`${apiBase}/blocks/1`)).json()) as { hash?: unknown }
    const ours = (await (
      await fetch(rpcUrl, {
        method: "POST",
        headers: { "content-type": "application/json", "user-agent": USER_AGENT },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_getBlockByNumber", params: ["0x1", false] }),
        signal: AbortSignal.timeout(timeoutMs),
      })
    ).json()) as { result?: { hash?: unknown } }
    const same =
      typeof theirs.hash === "string" && theirs.hash.toLowerCase() === String(ours.result?.hash).toLowerCase()
    return { apiBase, ok: same, detail: same ? "chain checked by block 1 hash" : "block 1 hash differs from the RPC" }
  } catch (error) {
    return { apiBase, ok: false, detail: (error as Error).message.slice(0, 160) }
  }
}
