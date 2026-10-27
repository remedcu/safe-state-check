import {
  type Address,
  parseAbi,
  encodeAbiParameters,
  encodeFunctionData,
  getAddress,
  type Hex,
  hexToBigInt,
  pad,
  toHex,
  zeroAddress,
} from "viem"
import { describe, expect, it } from "vitest"
import { FIXTURES } from "@/core/__tests__/fixtures/appendixB"
import { ADDRESS, HASH, REGISTRY } from "@/core/__tests__/fixtures/registry"
import { FACTORY_ABI, SAFE_ABI } from "@/core/abis"
import { FALLBACK_HANDLER_SLOT, SENTINEL } from "@/core/constants"
import { FINDINGS } from "@/core/findings"
import type { CheckEvent, CheckRequest, Report } from "@/core/report"
import { moduleSlot, ownerSlot, sharedSignerSlot, slotKey } from "@/core/slots"
import { storageRoot } from "@/core/trie"
import { SIGNATURE_CAVEAT } from "@/core/pending"
import { decideVerdict, NOT_CHECKED } from "@/core/verdict"
import { runCheck } from "@/check/run"
import { IssueLog, type RunEnv } from "@/check/state"
import {
  account,
  B1_OWNER,
  B1_REALITY,
  B1_SAFE,
  B3_SAFE,
  b1World,
  b3World,
  configEventLog,
  CROSS,
  defaultHistory,
  type FakeWorld,
  fakeDeps,
  ioError,
  issue,
  PRIMARY,
  withStorage,
} from "@/check/__tests__/fakeDeps"
import { EVENT_TOPICS } from "@/core/constants"
import type { StsMultisigTx } from "@/data/types"
import { approvedHashSlot } from "@/core/slots"

const NOW = () => new Date("2026-10-12T12:00:00.000Z")
const OTHER: Address = "0x00000000000000000000000000000000000fa11B"
const UNKNOWN_CODE: Hex = "0x6080604052600080fd"

async function check(
  world: FakeWorld,
  request: Partial<CheckRequest> = {},
  env: Partial<RunEnv> = {},
  before?: (controller: AbortController) => void,
) {
  const { deps, log, controller } = fakeDeps(world)
  before?.(controller)
  const events: CheckEvent[] = []
  const report = await runCheck(
    { address: B1_SAFE, chainId: 1, block: null, ...request },
    deps,
    (event) => events.push(event),
    { registry: REGISTRY, now: NOW, ...env },
  )
  return { report, events, log }
}

async function reportOf(
  world: FakeWorld,
  request: Partial<CheckRequest> = {},
  env: Partial<RunEnv> = {},
): Promise<Report> {
  const { report } = await check(world, request, env)
  if (report === null) throw new Error("the run stopped")
  return report
}

const codes = (report: Report) => report.findings.map((f) => f.code)

describe("runCheck on the Reward Distribution Safe (B1)", () => {
  it("gives Storage fully explained with the reviewed veto module", async () => {
    const report = await reportOf(b1World())

    expect(report.verdict).toMatchObject({ kind: "explained", matchedBy: "config", unverified: [] })
    expect(report.storage).toMatchObject({
      state: "complete",
      data: { support: "supported", actualRoot: FIXTURES[0].root, matchedBy: "config" },
    })
    if (report.storage.state !== "complete") throw new Error("storage")
    expect(report.storage.data.formula.text).toBe(
      "Expected non-zero slots: 10 = 1 singleton + 1 owner count + 1 threshold + 1 nonce + 2 owner entries + 3 module entries + 1 fallback handler.",
    )
    // The owner is an EIP-7702 delegated account at block 26176126; 1.5.0 is deployed on chain 1.
    expect(codes(report)).toEqual(["delegated-owner", "version-behind"])
  })

  it("identifies every account", async () => {
    const report = await reportOf(b1World())
    if (report.identity.state !== "complete" || report.modules.state !== "complete") throw new Error("sections")
    if (report.owners.state !== "complete" || report.handlers.state !== "complete") throw new Error("sections")

    expect(report.identity.data).toMatchObject({ version: "1.4.1", supported: true, versionCall: "1.4.1", l2: false })
    expect(report.owners.data.owners[0]).toMatchObject({
      address: B1_OWNER,
      kind: "delegated-eoa",
      flags: ["delegated-owner"],
    })
    const [veto, reality] = report.modules.data.modules
    expect(veto.identification).toMatchObject({ status: "reviewed", via: "codehash" })
    expect(reality.identification).toMatchObject({
      status: "known",
      via: "eip1167",
      implementation: ADDRESS.realityERC20,
    })
    expect(reality.zodiac).toMatchObject({
      ownerIsSafe: true,
      guard: zeroAddress,
      reality: { timeout: "86400", minimumBond: (10n ** 18n).toString() },
      cross: "match",
    })
    expect(report.handlers.data.fallbackHandler).toMatchObject({ address: ADDRESS.compat141, flags: [] })
    expect(report.handlers.data.moduleGuard).toMatchObject({ applicable: false, address: null })
    expect(report.verification).toMatchObject({
      agreement: "agreed",
      reorg: "unchanged",
      proofs: { allVerified: true },
    })
    expect(report.notChecked.slice(0, NOT_CHECKED.length)).toEqual([...NOT_CHECKED])
    // The signature caveat once, in one wording.
    expect(report.notChecked.filter((line) => line.startsWith("Signatures"))).toEqual([SIGNATURE_CAVEAT])
  })

  it("streams events in order: started, steps and sections, then finished", async () => {
    const { events, report } = await check(b1World())

    expect(events[0].type).toBe("started")
    expect(events.at(-1)).toEqual({ type: "finished", report })
    expect(events.filter((e) => e.type === "finished" || e.type === "stopped")).toHaveLength(1)
    const steps = events.flatMap((e) => (e.type === "step" ? [e.step] : []))
    for (const id of ["anchor", "identity", "config", "storage", "owners", "modules", "handlers", "reorg", "verdict"]) {
      const statuses = steps.filter((s) => s.id === id).map((s) => s.status)
      expect(statuses[0]).toBe("running")
      expect(statuses.at(-1)).toBe("done")
    }
    for (const id of ["history", "pending"]) {
      expect(
        steps
          .filter((s) => s.id === id)
          .map((s) => s.status)
          .at(-1),
      ).toBe("done")
    }
    for (const id of ["storage-events", "diagnosis"]) {
      expect(steps.filter((s) => s.id === id).map((s) => s.status)).toEqual(["skipped"])
    }
    // A section arrives as soon as its step is done, before the verdict starts.
    const storageSection = events.findIndex((e) => e.type === "section" && e.patch.key === "storage")
    const verdictStart = events.findIndex((e) => e.type === "step" && e.step.id === "verdict")
    expect(storageSection).toBeGreaterThan(0)
    expect(storageSection).toBeLessThan(verdictStart)
    expect(events.filter((e) => e.type === "finding")).toHaveLength(2) // delegated-owner and version-behind
    expect(report?.steps.every((s) => s.status !== "pending" && s.status !== "running")).toBe(true)
  })

  it("marks the later steps skipped with a reason", async () => {
    const report = await reportOf(b1World())

    expect(report.history).toMatchObject({ state: "complete", data: { complete: true } })
    expect(report.pending).toMatchObject({ state: "complete" })
    expect(report.steps.find((s) => s.id === "storage-events")?.note).toBe(
      "Not needed: the storage root matched with the configuration slots.",
    )
    expect(report.diagnosis).toBeNull()
    expect(report.crossChain).toBeNull()
  })

  // Invariants 1 and 15: the matched rows rebuild the actual root, and they all come from one proven read.
  it("rebuilds the matched root from the rows of one read", async () => {
    const { report, log } = await check(b1World())
    if (report?.storage.state !== "complete") throw new Error("storage")
    const { slots, actualRoot } = report.storage.data

    expect(await storageRoot(slots.map((row) => ({ slot: row.key, value: hexToBigInt(row.value) })))).toBe(actualRoot)
    const safeReads = log.filter((entry) => entry.method === "proveAccount" && entry.address === B1_SAFE)
    const covering = safeReads.filter((entry) => slots.every((row) => entry.slots?.includes(row.key)))
    expect(covering.length).toBeGreaterThanOrEqual(1)
    expect(report.verification.proofs.blocks).toEqual(["26176126"])
  })

  // Invariant 13.
  it("survives a JSON round trip", async () => {
    const report = await reportOf(b1World())

    expect(JSON.parse(JSON.stringify(report))).toEqual(report)
  })

  // Invariant 6.
  it("derives severity from the code and the verdict from the report alone", async () => {
    const report = await reportOf(
      withStorage(b1World(), B1_SAFE, (entries) => [...entries, ...FIXTURES[1].entries.slice(-1)]),
    )

    for (const f of report.findings) expect(f.severity).toBe(FINDINGS[f.code].severity)
    expect(decideVerdict(report)).toEqual(report.verdict)
  })
})

describe("runCheck verdicts", () => {
  it("is red for a shadow owner (B1-neg)", async () => {
    const report = await reportOf(
      withStorage(b1World(), B1_SAFE, (entries) => [...entries, ...FIXTURES[1].entries.slice(-1)]),
    )

    expect(report.verdict.kind).toBe("unexplained")
    expect(report.storage).toMatchObject({ data: { matchedBy: null, actualRoot: FIXTURES[1].root } })
    expect(codes(report)).toContain("unexplained-storage")
    expect(report.steps.find((s) => s.id === "diagnosis")?.status).toBe("degraded")
  })

  it("is green on the SEF Safe (B3), 1.5.0", async () => {
    const report = await reportOf(b3World(), { address: B3_SAFE })

    expect(report.verdict.kind).toBe("explained")
    expect(report.storage).toMatchObject({ data: { actualRoot: FIXTURES[4].root } })
    expect(report.handlers).toMatchObject({ data: { moduleGuard: { applicable: true, address: null } } })
  })

  it("is amber with one operator", async () => {
    const report = await reportOf({
      ...b1World(),
      pair: { crossCheck: null, crossCheckMissing: "No second operator." },
    })

    expect(report.verification.agreement).toBe("single-operator")
    expect(report.verdict).toMatchObject({ kind: "unverified", reasons: ["No second operator."] })
  })

  it("is amber when both RPCs are one operator or both aggregators (invariant 2)", async () => {
    // Neither is an aggregator, so only the operator rule can catch this pair.
    const same = await reportOf({
      ...b1World(),
      pair: { primary: CROSS, crossCheck: { ...CROSS, url: "https://eth.publicnode.com", host: "eth.publicnode.com" } },
    })
    const aggregators = await reportOf({
      ...b1World(),
      pair: { crossCheck: { ...PRIMARY, operator: "1rpc", host: "public.1rpc.io" } },
    })

    expect(same.verification.agreement).toBe("single-operator")
    expect(aggregators.verification.agreement).toBe("single-operator")
    expect(same.verdict.kind).toBe("unverified")
  })

  it("is green on the user's own node marked as trusted, and says so", async () => {
    const own = {
      ...PRIMARY,
      url: "http://127.0.0.1:8545",
      host: "127.0.0.1:8545",
      origin: "user" as const,
      operator: "user:127.0.0.1",
    }
    const trusted = await reportOf({
      ...b1World(),
      pair: { primary: own, crossCheck: null, crossCheckMissing: "No second operator." },
      anchor: { header: "not-run", selfTrusted: true },
    })
    const defaultRpc = await reportOf({
      ...b1World(),
      pair: { crossCheck: null, crossCheckMissing: "No second operator." },
      anchor: { header: "not-run", selfTrusted: true },
    })

    expect(trusted.verification.agreement).toBe("self-trusted")
    expect(trusted.verdict.kind).toBe("explained")
    expect(trusted.verdict.reasons).toContain(
      "Checked against your own RPC 127.0.0.1:8545 only. No independent operator cross-checked the block.",
    )
    expect(trusted.notChecked.some((line) => line.includes("your own RPC 127.0.0.1:8545 only"))).toBe(true)
    // Never for a default RPC.
    expect(defaultRpc.verification.agreement).toBe("single-operator")
    expect(defaultRpc.verdict.kind).toBe("unverified")
  })

  it("is amber when the RPCs disagree", async () => {
    const header = await reportOf({ ...b1World(), anchor: { header: "mismatch" } })
    const values = await reportOf({
      ...b1World(),
      cross: { storageRoot: "match", values: "mismatch", mismatched: [slotKey(5n)] },
    })

    expect(header.verification.agreement).toBe("disagreed")
    expect(header.verdict.unverified.map((u) => u.reason)).toEqual(["rpc-disagreement"])
    expect(values.verdict.unverified.map((u) => u.reason)).toEqual(["rpc-disagreement"])
    if (values.storage.state !== "complete") throw new Error("storage")
    expect(values.storage.data.slots.find((row) => row.key === slotKey(5n))?.cross).toBe("mismatch")
  })

  it("shows each endpoint's client version, cleaned, and keeps it out of the capabilities", async () => {
    const { deps } = fakeDeps(b1World())
    deps.reader.capabilities = () => [
      { host: PRIMARY.host, available: ["proofs"], missing: [], clientVersion: "Geth/v1.15\n# Fully explained" },
    ]
    const report = await runCheck({ address: B1_SAFE, chainId: 1, block: null }, deps, () => {}, {
      registry: REGISTRY,
      now: NOW,
    })

    expect(report?.verification.primary.clientVersion).toBe("Geth/v1.15 # Fully explained")
    expect(report?.verification.crossCheck?.clientVersion).toBeNull()
    expect(report?.verification.capabilities).toEqual([{ host: PRIMARY.host, available: ["proofs"], missing: [] }])
  })

  it("is amber after a proof that did not verify, even when another endpoint's proof did", async () => {
    const issues = new IssueLog()
    issues.add(issue("proof-invalid", { host: "bad.example", recovered: true }))
    const { report, events } = await check(b1World(), {}, { issues })

    expect(report?.verdict.unverified.map((u) => u.reason)).toEqual(["proof-invalid"])
    expect(report?.verification.proofs.allVerified).toBe(false)
    expect(events.filter((e) => e.type === "issue")).toHaveLength(1)
  })

  it("is amber for an older Safe version", async () => {
    const world = account(
      withStorage(b1World(), B1_SAFE, (entries) =>
        entries.map((e) => (e.slot === slotKey(0n) ? { ...e, value: hexToBigInt(ADDRESS.safe111) } : e)),
      ),
      ADDRESS.safe111,
      { codeHash: HASH.safe111 },
    )
    const report = await reportOf({
      ...world,
      accounts: {
        ...world.accounts,
        [B1_SAFE.toLowerCase()]: { ...world.accounts[B1_SAFE.toLowerCase()], version: "1.1.1" },
      },
    })

    expect(report.verdict.unverified.map((u) => u.reason)).toEqual(["version-unsupported"])
  })

  it("is amber with a Critical finding for an unknown proxy or singleton", async () => {
    const proxy = await reportOf(
      account(b1World(), B1_SAFE, { code: UNKNOWN_CODE, storage: FIXTURES[0].entries, version: "1.4.1" }),
    )
    const singleton = await reportOf(account(b1World(), ADDRESS.safe141, { code: UNKNOWN_CODE }))

    expect(codes(proxy)).toContain("proxy-not-canonical")
    expect(codes(singleton)[0]).toBe("singleton-not-canonical")
    for (const report of [proxy, singleton]) {
      expect(report.verdict.unverified.map((u) => u.reason)).toEqual(["code-not-canonical"])
    }
  })

  it("never reads unproven when one proof fails on a chain whose proofs work: the module is not inspected", async () => {
    const { report, log } = await check({
      ...b1World(),
      failures: { [`proveAccount:${B1_REALITY.toLowerCase()}`]: ioError("non-mpt") },
    })
    if (report === null) throw new Error("stopped")

    expect(log.some((entry) => entry.method === "readUnproven")).toBe(false)
    expect(report.modules).toMatchObject({ state: "partial" })
    if (report.modules.state !== "partial") throw new Error("modules")
    expect(report.modules.data.modules.map((m) => m.kind)).toContain("unknown")
    expect(report.verdict.unverified.map((u) => u.reason)).toEqual(["inspection-incomplete"])
    expect(report.cards.find((card) => card.id === "modules")).toMatchObject({ value: "2", tone: "unknown" })
  })

  it("is amber when a needed read fails, and names the RPC", async () => {
    const report = await reportOf({
      ...b1World(),
      failures: { [`proveAccount:${B1_SAFE.toLowerCase()}`]: ioError("timeout", { title: "No answer in time" }) },
    })

    expect(report.verdict.unverified.map((u) => u.reason)).toEqual(["read-failed"])
    expect(report.steps.find((s) => s.id === "identity")?.note).toBe(
      "Primary RPC eth.drpc.org could not read the Safe: No answer in time.",
    )
    expect(report.issues.map((i) => i.kind)).toEqual(["timeout"])
  })

  it("restarts once on a reorg, and gives up on a second one", async () => {
    const once = await check({ ...b1World(), rechecks: ["changed"] })
    const twice = await check({ ...b1World(), rechecks: ["changed", "changed"] })

    expect(once.events.filter((e) => e.type === "restarted")).toHaveLength(1)
    expect(once.events.filter((e) => e.type === "started")).toHaveLength(1)
    expect(once.report?.verification.reorg).toBe("restarted")
    expect(once.report?.verdict.kind).toBe("explained")
    expect(twice.report?.verdict.unverified.map((u) => u.reason)).toEqual(["reorg"])
  })
})

describe("runCheck stops", () => {
  const stop = (events: CheckEvent[]) => events.find((e) => e.type === "stopped")

  it("when there is no account or no code", async () => {
    const missing = await check({ accounts: {} })
    const empty = await check({ accounts: { [B1_SAFE.toLowerCase()]: { code: "0x" } } })

    expect(missing.report).toBeNull()
    expect(stop(missing.events)).toMatchObject({ reason: "not-deployed" })
    expect(stop(empty.events)).toMatchObject({ reason: "no-code" })
    expect(empty.events.filter((e) => e.type === "finished")).toHaveLength(0)
  })

  it("when the address is an EIP-7702 account, naming the delegate", async () => {
    const code = `0xef0100${OTHER.slice(2)}` as Hex
    const { report, events } = await check({ accounts: { [B1_SAFE.toLowerCase()]: { code } } })

    expect(report).toBeNull()
    expect(stop(events)).toMatchObject({ reason: "not-a-safe" })
    expect((stop(events) as { message: string }).message).toContain(`EIP-7702 delegation to ${OTHER}`)
  })

  it("when the address holds a contract that does not answer like a Safe", async () => {
    // A token: unknown code, no known singleton in slot 0, getThreshold() reverts.
    const { report, events } = await check({ accounts: { [B1_SAFE.toLowerCase()]: { code: UNKNOWN_CODE } } })

    expect(report).toBeNull()
    expect(stop(events)).toMatchObject({ reason: "not-a-safe" })
    expect((stop(events) as { message: string }).message).toContain("holds a contract that is not a Safe")
  })

  it("not for unknown proxy code that answers like a Safe: it goes on as a Safe that is not canonical", async () => {
    const world = account(
      withStorage(b1World(), B1_SAFE, (entries) => [
        ...entries.filter((entry) => entry.slot !== slotKey(0n)),
        { slot: slotKey(0n), value: hexToBigInt(OTHER) },
      ]),
      OTHER,
      { code: UNKNOWN_CODE },
    )
    // Neither the proxy code nor the singleton in slot 0 is known; only the getters say it is a Safe.
    const safe = world.accounts[B1_SAFE.toLowerCase()]
    world.accounts[B1_SAFE.toLowerCase()] = { ...safe, code: UNKNOWN_CODE, codeHash: undefined }
    const report = await reportOf(world)

    expect(codes(report)).toEqual(expect.arrayContaining(["proxy-not-canonical", "singleton-not-canonical"]))
    expect(report.verdict.unverified.map((u) => u.reason)).toContain("code-not-canonical")
  })

  it("not for unknown proxy code whose slot 0 is a known singleton, even when its getters cannot be called", async () => {
    const world = {
      ...account(b1World(), B1_SAFE, { code: UNKNOWN_CODE, storage: FIXTURES[0].entries, version: "1.4.1" }),
      failures: { [`call:${B1_SAFE.toLowerCase()}`]: ioError("not-archive") },
    }
    const report = await reportOf(world)

    expect(report.identity.state).toBe("complete")
    expect(codes(report)).toContain("proxy-not-canonical")
  })

  it("when no block can be pinned", async () => {
    const { report, events } = await check({ ...b1World(), failures: { anchor: ioError("unreachable") } })

    expect(report).toBeNull()
    expect(stop(events)).toMatchObject({ reason: "anchor-failed" })
    expect((stop(events) as { issues: unknown[] }).issues).toHaveLength(1)
  })

  it("when cancelled", async () => {
    const { report, events } = await check(b1World(), {}, {}, (controller) => controller.abort())

    expect(report).toBeNull()
    expect(stop(events)).toMatchObject({ reason: "cancelled" })
  })

  it("when cancelled while steps run in parallel", async () => {
    const { deps, controller } = fakeDeps(b1World())
    const find = deps.creation.find.bind(deps.creation)
    deps.creation = {
      find: async (safe, block) => {
        controller.abort()
        return find(safe, block)
      },
    }
    const events: CheckEvent[] = []
    const report = await runCheck({ address: B1_SAFE, chainId: 1, block: null }, deps, (e) => events.push(e), {
      registry: REGISTRY,
      now: NOW,
    })

    expect(report).toBeNull()
    expect(stop(events)).toMatchObject({ reason: "cancelled" })
    expect(events.filter((e) => e.type === "finished")).toHaveLength(0)
  })

  // Invariant 4.
  it("when a proven read is not at the user's block", async () => {
    const { report, events } = await check({ ...b1World(), readBlock: 26176127n }, { block: "26176126" })

    expect(report).toBeNull()
    expect(stop(events)).toMatchObject({ reason: "anchor-failed" })
  })
})

describe("runCheck config", () => {
  // 1.3.0 returns the first module not on the page as `next`; paging from it would skip one module per page.
  it("pages 1.3.0 module lists from the last module returned", async () => {
    const modules = Array.from({ length: 120 }, (_, i) => toHex(0x1000n + BigInt(i), { size: 20 }) as Address)
    const chain = [SENTINEL, ...modules, SENTINEL]
    const world = withStorage(b1World(), B1_SAFE, (entries) => [
      ...entries.filter(
        (e) => ![moduleSlot(SENTINEL), moduleSlot(ADDRESS.vetoModule), moduleSlot(B1_REALITY)].includes(e.slot),
      ),
      ...chain.slice(0, -1).map((from, i) => ({ slot: moduleSlot(from), value: hexToBigInt(chain[i + 1]) })),
    ])
    world.accounts[B1_SAFE.toLowerCase()].paging130 = true
    const report = await reportOf(world)

    expect(report.modules).toMatchObject({ state: "complete" })
    if (report.modules.state !== "complete") throw new Error("modules")
    expect(report.modules.data.modules).toHaveLength(120)
    expect(codes(report)).not.toContain("getter-mismatch")
    expect(codes(report).filter((c) => c === "eoa-module")).toHaveLength(120)
  })

  it("walks the lists from raw slots when eth_call fails", async () => {
    const { report, log } = await check({
      ...b1World(),
      failures: { [`call:${B1_SAFE.toLowerCase()}`]: ioError("not-archive") },
    })

    expect(report?.verdict.kind).toBe("explained")
    expect(codes(report!)).not.toContain("getter-mismatch")
    expect(report?.identity).toMatchObject({ data: { versionCall: null } })
    // Base read, then one read per list entry: owners[owner], then the two module entries.
    expect(log.filter((e) => e.method === "proveAccount" && e.address === B1_SAFE).length).toBeGreaterThanOrEqual(4)
  })
})

describe("runCheck accounts", () => {
  it("flags an EOA module and an unknown fallback handler", async () => {
    const world = account(account(b1World(), ADDRESS.vetoModule, { code: "0x" }), ADDRESS.compat141, {
      code: UNKNOWN_CODE,
    })
    const report = await reportOf(world)

    expect(codes(report)).toEqual(
      expect.arrayContaining(["eoa-module", "unknown-fallback-handler", "codehash-mismatch"]),
    )
    expect(report.verdict.kind).toBe("explained")
    expect(report.verdict.counts.critical).toBe(1)
  })

  it("looks one level into an owner that is a Safe", async () => {
    const inner = getAddress("0x00000000000000000000000000000000000000aa")
    const world = account(b1World(), B1_OWNER, {
      codeHash: HASH.proxy141,
      storage: [
        { slot: slotKey(0n), value: hexToBigInt(ADDRESS.safe141) },
        { slot: slotKey(3n), value: 1n },
        { slot: slotKey(4n), value: 1n },
        { slot: ownerSlot(SENTINEL), value: hexToBigInt(inner) },
        { slot: ownerSlot(inner), value: 1n },
      ],
    })
    const report = await reportOf(world)

    expect(report.owners).toMatchObject({
      data: { owners: [{ kind: "safe", safe: { version: "1.4.1", owners: [inner], threshold: "1" }, flags: [] }] },
    })
    expect(codes(report)).toEqual(["version-behind"])
  })

  it("counts the shared passkey signer's slots once its code is proven", async () => {
    const signer = ADDRESS.sharedSigner
    const base = hexToBigInt(sharedSignerSlot(signer))
    const passkeyWorld = (codeHash: Hex) =>
      account(
        withStorage(b1World(), B1_SAFE, (entries) => [
          ...entries.filter((e) => e.slot !== ownerSlot(SENTINEL) && e.slot !== ownerSlot(B1_OWNER)),
          { slot: ownerSlot(SENTINEL), value: hexToBigInt(signer) },
          { slot: ownerSlot(signer), value: 1n },
          ...[0n, 1n, 2n].map((offset) => ({ slot: slotKey(base + offset), value: 11n + offset })),
        ]),
        signer,
        { codeHash },
      )
    const proven = await reportOf(passkeyWorld(HASH.sharedSigner))
    const fake = await reportOf(passkeyWorld(HASH.compat141))

    expect(proven.verdict.kind).toBe("explained")
    expect(codes(proven)).toEqual(expect.arrayContaining(["contract-owner", "passkey-signer-slots"]))
    expect(fake.verdict.kind).toBe("unexplained")
    expect(codes(fake).filter((c) => c === "unexplained-storage")).toHaveLength(3)
  })
})

describe("runCheck creation", () => {
  const initializer = (to: Address = zeroAddress, payment = 0n) =>
    encodeFunctionData({
      abi: SAFE_ABI,
      functionName: "setup",
      args: [[B1_OWNER], 1n, to, "0x", ADDRESS.compat141, zeroAddress, payment, zeroAddress],
    })
  const TX = "0x00000000000000000000000000000000000000000000000000000000000000c7" as const
  // The receipt's ProxyCreation (1.4.1 shape) from `factory` for this Safe: what ties the transaction to the Safe.
  const proxyCreation = (factory: Address) =>
    configEventLog(
      factory,
      [EVENT_TOPICS.ProxyCreation, pad(B1_SAFE, { size: 32 })],
      pad(ADDRESS.safe141, { size: 32 }),
    )
  const created = (input: Hex, to: Address = ADDRESS.factory141): FakeWorld => ({
    ...account(account(b1World(), ADDRESS.factory141, { codeHash: HASH.factory141 }), OTHER, { code: UNKNOWN_CODE }),
    creation: {
      lookup: {
        found: true,
        txHash: TX,
        blockNumber: 20000000n,
        source: { service: "blockscout", host: "eth.blockscout.com" },
      },
      tx: { hash: TX, from: B1_OWNER, to, input, blockNumber: 20000000n, status: true, cross: "match" },
      logs: [proxyCreation(to)],
      diff: {
        [B1_SAFE]: {
          pre: {},
          post: {
            [slotKey(4n)]: toHex(1n, { size: 32 }),
            [FALLBACK_HANDLER_SLOT]: toHex(hexToBigInt(ADDRESS.compat141), { size: 32 }),
          },
        },
      },
    },
  })
  const factoryCall = (setup: Hex) =>
    encodeFunctionData({ abi: FACTORY_ABI, functionName: "createProxyWithNonce", args: [ADDRESS.safe141, setup, 0n] })

  it("decodes a direct factory call and its setup", async () => {
    const report = await reportOf(created(factoryCall(initializer())))

    expect(report.creation).toMatchObject({
      state: "complete",
      data: {
        txHash: TX,
        factory: { address: ADDRESS.factory141, method: "createProxyWithNonce", identification: { status: "known" } },
        singleton: ADDRESS.safe141,
        saltNonce: "0",
        setup: { owners: [B1_OWNER], threshold: "1", to: zeroAddress, payment: "0" },
      },
    })
    if (report.creation.state !== "complete") throw new Error("creation")
    expect(report.creation.data.storageDiff?.map((row) => row.meaning).sort()).toEqual([
      "fallback handler",
      "threshold (slot 4)",
    ])
    expect(codes(report)).toEqual(["delegated-owner", "version-behind"])
  })

  it("flags an unknown setup delegatecall and a payment", async () => {
    const report = await reportOf(created(factoryCall(initializer(OTHER, 5n))))

    expect(codes(report)).toEqual(expect.arrayContaining(["setup-delegatecall-unknown", "setup-payment"]))
  })

  it("finds the factory call in a call trace", async () => {
    const world = created("0x", OTHER)
    // The trace alone ties the transaction to this Safe.
    world.creation!.logs = []
    world.creation!.trace = {
      type: "CALL",
      from: B1_OWNER,
      to: OTHER,
      input: "0x",
      value: 0n,
      calls: [
        {
          type: "CALL",
          from: OTHER,
          to: ADDRESS.factory141,
          input: factoryCall(initializer()),
          value: 0n,
          calls: [{ type: "CREATE2", from: ADDRESS.factory141, to: B1_SAFE, input: "0x", value: 0n, calls: [] }],
        },
      ],
    }
    const report = await reportOf(world)

    expect(report.creation).toMatchObject({ state: "complete", data: { factory: { address: ADDRESS.factory141 } } })
  })

  it("flags an unknown factory", async () => {
    const report = await reportOf(created(factoryCall(initializer()), OTHER))

    expect(codes(report)).toContain("factory-not-canonical")
  })

  it("does not read another Safe's creation: the receipt must show this Safe being created", async () => {
    const world = created(factoryCall(initializer(OTHER)))
    world.creation!.logs = []
    const report = await reportOf(world)

    expect(report.creation).toEqual({
      state: "unavailable",
      reason:
        "The creation transaction was found, but neither a call trace nor its receipt shows it creating this Safe.",
    })
    expect(codes(report)).not.toContain("setup-delegatecall-unknown")
  })

  it("shows no creation when the cross-check's copy of the transaction differs", async () => {
    const world = created(factoryCall(initializer()))
    world.creation!.tx = { ...world.creation!.tx!, cross: "mismatch" }
    const report = await reportOf(world)

    expect(report.creation).toMatchObject({ state: "unavailable" })
    if (report.creation.state !== "unavailable") throw new Error("creation")
    expect(report.creation.reason).toContain("different copies")
  })

  it("says when only one RPC read the creation transaction", async () => {
    const world = created(factoryCall(initializer()))
    world.creation!.tx = { ...world.creation!.tx!, cross: "not-served" }
    const report = await reportOf(world)

    expect(report.creation).toMatchObject({ state: "partial" })
    if (report.creation.state !== "partial") throw new Error("creation")
    expect(report.creation.gaps).toContain(
      `The cross-check RPC ${CROSS.host} did not serve the creation transaction, so the primary RPC ${PRIMARY.host} alone read it.`,
    )
  })

  it("names the one RPC that had the creation transaction when only the cross-check served it", async () => {
    const world = created(factoryCall(initializer()))
    world.creation!.tx = { ...world.creation!.tx!, cross: "not-served", singleSource: true }
    const report = await reportOf(world)

    if (report.creation.state !== "partial") throw new Error("creation")
    expect(report.creation.gaps).toContain(
      `Only the cross-check RPC ${CROSS.host} had the creation transaction, so one RPC alone read it and nothing was compared.`,
    )
  })

  it("says which RPC could not read the creation transaction or its receipt", async () => {
    const world = created(factoryCall(initializer()))
    const noTx = await reportOf({
      ...world,
      failures: { transaction: ioError("not-found", { title: "Not found", operation: "read transaction 0xc7" }) },
    })
    const noReceipt = await reportOf({
      ...world,
      failures: {
        receiptLogs: ioError("timeout", { title: "No answer in time", operation: "read the events of 0xc7" }),
      },
    })

    expect(noTx.creation).toEqual({
      state: "unavailable",
      reason:
        "The creation transaction could not be read. Primary RPC eth.drpc.org could not read transaction 0xc7: Not found.",
    })
    expect(noReceipt.creation).toEqual({
      state: "unavailable",
      reason:
        "The creation transaction was found, but its receipt could not be read, so it cannot be tied to this Safe. Primary RPC eth.drpc.org could not read the events of 0xc7: No answer in time.",
    })
  })

  it("keeps a failed read of the setup target apart from no code: a gap, no finding", async () => {
    const world = {
      ...created(factoryCall(initializer(ADDRESS.toL2Setup141))),
      failures: { [`proveAccount:${ADDRESS.toL2Setup141.toLowerCase()}`]: ioError("rate-limited") },
    }
    const report = await reportOf(world)

    expect(codes(report)).not.toContain("setup-delegatecall-unknown")
    expect(report.creation).toMatchObject({ state: "partial" })
    if (report.creation.state !== "partial") throw new Error("creation")
    expect(report.creation.gaps[0]).toContain(`Setup target ${ADDRESS.toL2Setup141} could not be inspected.`)
  })

  it("says which RPC could not read the creation transaction an indexer named", async () => {
    const failed = issue("not-found", {
      title: "Not found",
      host: "polygon-bor-rpc.publicnode.com",
      operation: "read transaction 0x4ef9...54df",
    })
    const report = await reportOf({
      ...b1World(),
      creation: {
        lookup: {
          found: false,
          tried: [
            { service: "safe-tx-service", host: "api.safe.global" },
            { service: "rpc", host: "polygon-bor-rpc.publicnode.com" },
          ],
          issues: [failed],
        },
      },
    })

    expect(report.creation).toEqual({
      state: "unavailable",
      reason:
        "The creation transaction could not be read. Primary RPC polygon-bor-rpc.publicnode.com could not read transaction 0x4ef9...54df: Not found. Asked: api.safe.global, polygon-bor-rpc.publicnode.com.",
    })
  })

  it("says plainly when the creation transaction was not found", async () => {
    const report = await reportOf(b1World())

    expect(report.creation).toEqual({
      state: "unavailable",
      reason: "The creation transaction was not found (tried eth.blockscout.com).",
    })
    expect(report.steps.find((s) => s.id === "creation")?.status).toBe("degraded")
  })
})

describe("runCheck history, pending and diagnosis", () => {
  const HASH_A: Hex = "0x9b8d6c1a8f5dfcb5d6b5c1f0a9e0c8f6f2a4d3e1b7c9a5f3e2d1c0b9a8f7e6d5"

  it("flags a module enabled with no event as config-without-event (High)", async () => {
    // The history is only the SafeSetup; the veto module is enabled now but no EnabledModule announced it.
    const world: FakeWorld = {
      ...b1World(),
      history: [
        configEventLog(
          B1_SAFE,
          [EVENT_TOPICS.SafeSetup, pad(B1_SAFE, { size: 32 })],
          buildSetup([B1_OWNER], 1n, ADDRESS.compat141),
        ),
        configEventLog(B1_SAFE, [EVENT_TOPICS.EnabledModule, pad(B1_REALITY, { size: 32 })]),
      ],
    }
    const report = await reportOf(world)

    expect(report.history).toMatchObject({ state: "complete", data: { complete: true } })
    const codesOf = report.findings.map((f) => f.code)
    expect(codesOf.filter((c) => c === "config-without-event")).toHaveLength(1)
    expect(report.findings.find((f) => f.code === "config-without-event")?.subject).toBe(ADDRESS.vetoModule)
  })

  it("softens the finding to Medium when the history came from an indexer", async () => {
    const world: FakeWorld = {
      ...b1World(),
      historySource: { service: "blockscout", host: "eth.blockscout.com" },
      history: [
        configEventLog(
          B1_SAFE,
          [EVENT_TOPICS.SafeSetup, pad(B1_SAFE, { size: 32 })],
          buildSetup([B1_OWNER], 1n, ADDRESS.compat141),
        ),
        configEventLog(B1_SAFE, [EVENT_TOPICS.EnabledModule, pad(B1_REALITY, { size: 32 })]),
      ],
    }
    const report = await reportOf(world)

    expect(report.findings.map((f) => f.code)).toContain("config-without-event-unconfirmed")
    expect(report.findings.map((f) => f.code)).not.toContain("config-without-event")
  })

  it("raises no config finding and reports history-incomplete on a partial history", async () => {
    const report = await reportOf({ ...b1World(), history: "none", historyComplete: false })

    expect(report.findings.map((f) => f.code)).toContain("history-incomplete")
    expect(report.findings.map((f) => f.code)).not.toContain("config-without-event")
    expect(report.history).toMatchObject({ state: "partial" })
  })

  it("lists a pending approved hash and a queued transaction", async () => {
    const queued: StsMultisigTx = {
      safeTxHash: HASH_A,
      nonce: "5",
      to: B1_OWNER,
      value: "0",
      data: null,
      operation: 0,
      confirmationsRequired: 2,
      confirmations: [{ owner: B1_OWNER }],
      isExecuted: false,
    }
    const world = withStorage(
      {
        ...b1World(),
        queued: [queued],
        history: [
          configEventLog(
            B1_SAFE,
            [EVENT_TOPICS.SafeSetup, pad(B1_SAFE, { size: 32 })],
            buildSetup([B1_OWNER], 1n, ADDRESS.compat141),
          ),
          configEventLog(B1_SAFE, [EVENT_TOPICS.EnabledModule, pad(ADDRESS.vetoModule, { size: 32 })]),
          configEventLog(B1_SAFE, [EVENT_TOPICS.EnabledModule, pad(B1_REALITY, { size: 32 })]),
          configEventLog(B1_SAFE, [EVENT_TOPICS.ApproveHash, HASH_A, pad(B1_OWNER, { size: 32 })]),
        ],
      },
      B1_SAFE,
      (entries) => [...entries, { slot: approvedHashSlot(B1_OWNER, HASH_A), value: 1n }],
    )
    const report = await reportOf(world)

    const codesOf = report.findings.map((f) => f.code)
    expect(codesOf).toContain("pending-approved-hash")
    expect(codesOf).toContain("queued-transaction")
    // The approved hash slot is benign, so the root still matches in pass 2.
    expect(report.verdict.kind).toBe("explained")
    expect(report.storage).toMatchObject({ data: { matchedBy: "events" } })
    if (report.pending.state !== "complete") throw new Error("pending")
    expect(report.pending.data.approvedHashes[0]).toMatchObject({ owner: B1_OWNER, hash: HASH_A })
  })

  it("enumerates every slot in diagnosis; a shadow address never seen stays unexplained (red)", async () => {
    // The shadow owner 0x...02 appears nowhere in the config or events, so enumeration finds the extra slot but
    // cannot reverse its key to an address. It is honest to report unexplained storage, not a named shadow owner.
    const negEntries = [...FIXTURES[1].entries]
    const world: FakeWorld = {
      ...withStorage(b1World(), B1_SAFE, () => negEntries),
      storageRange: {
        values: new Map(negEntries.map((e) => [e.slot.toLowerCase() as Hex, BigInt(e.value)])),
        complete: true,
      },
    }
    const report = await reportOf(world)

    expect(report.verdict.kind).toBe("unexplained")
    expect(report.findings.map((f) => f.code)).toContain("unexplained-storage")
    expect(report.diagnosis?.steps.find((s) => s.id === "enumeration")?.status).toBe("explained")
    expect(report.diagnosis?.unexplained.some((row) => row.status === "unexplained")).toBe(true)
  })

  it("records what diagnosis could not do when no enumeration or trace is served", async () => {
    const report = await reportOf(
      withStorage(b1World(), B1_SAFE, (entries) => [...entries, ...FIXTURES[1].entries.slice(-1)]),
    )

    expect(report.diagnosis?.steps.find((s) => s.id === "enumeration")).toMatchObject({
      status: "unavailable",
      missing: ["storageRange"],
    })
    expect(report.verdict.kind).toBe("unexplained")
  })
})

// The non-indexed data of a SafeSetup event: owners[], threshold, initializer (zero), fallbackHandler.
function buildSetup(owners: Address[], threshold: bigint, handler: Address): Hex {
  return encodeAbiParameters(
    [{ type: "address[]" }, { type: "uint256" }, { type: "address" }, { type: "address" }],
    [owners, threshold, zeroAddress, handler],
  )
}

describe("runCheck on a header-only anchor", () => {
  // The reader refuses every proof; readUnproven serves the state, so owners and modules still fill.
  it("marks storage unsupported but still inspects owners and modules (amber)", async () => {
    const report = await reportOf({
      ...b1World(),
      anchor: { headerOnly: "unsupported" },
      chain: { rootCheck: { status: "unsupported", reason: "x" } },
    })

    expect(report.storage).toMatchObject({ state: "complete", data: { support: "unsupported", actualRoot: null } })
    if (report.storage.state !== "complete") throw new Error("storage")
    expect(report.storage.data.slots.every((row) => row.proven === false)).toBe(true)
    expect(report.owners.state).toBe("complete")
    expect(report.modules.state).toBe("complete")
    expect(report.verdict.kind).toBe("unverified")
    expect(report.verdict.unverified.map((u) => u.reason)).toContain("root-check-unsupported")
    // The delegated-owner finding still appears from the unproven reads.
    expect(report.findings.map((f) => f.code)).toContain("delegated-owner")
    // The chain's own proof format, not a fault of the RPC.
    expect(report.verdict.reasons[0]).toContain("This is the chain's design, not a fault of the RPC.")
  })

  it("says no-proof-rpc, not non-standard proofs, when no RPC proves the block on a chain whose proofs work", async () => {
    const { report, log } = await check({ ...b1World(), anchor: { headerOnly: "no-proof-rpc" } })
    if (report === null) throw new Error("stopped")

    expect(report.storage).toMatchObject({ state: "complete", data: { support: "no-proof-rpc" } })
    expect(report.verdict.unverified.map((u) => u.reason)).toEqual(["no-proof-rpc", "unproven-read"])
    // Identity and the inspections ran on unproven reads, and no proof was asked for.
    expect(report.identity.state).toBe("complete")
    expect(report.owners.state).toBe("complete")
    expect(log.some((entry) => entry.method === "proveAccount")).toBe(false)
    expect(report.verification.coverage.slotValues).not.toBe("match")
  })
})

describe("runCheck diagnosis and root finding (fixes from the anvil suite)", () => {
  const SHADOW_X: Address = "0x0000000000000000000000000000000000000002"
  const negWorld = (): FakeWorld => withStorage(b1World(), B1_SAFE, () => [...FIXTURES[1].entries])
  const traced = (accounts: Address[]): FakeWorld => ({
    ...negWorld(),
    creation: {
      lookup: { found: false, tried: [], issues: [] },
      diff: Object.fromEntries([
        [
          B1_SAFE,
          {
            pre: {},
            post: { [ownerSlot(SHADOW_X)]: "0x0000000000000000000000000000000000000000000000000000000000000001" },
          },
        ],
        ...accounts.map((account) => [account, { pre: {}, post: {} }]),
      ]),
    },
  })

  // Fix 1: the account the trace touched names the slot.
  it("classifies a shadow owner from the accounts the traces touched, and the root then matches", async () => {
    const report = await reportOf(traced([SHADOW_X]))

    expect(report.findings.map((f) => f.code)).toContain("shadow-owner")
    expect(report.findings.find((f) => f.code === "shadow-owner")?.subject).toBe(SHADOW_X)
    expect(report.storage).toMatchObject({ data: { matchedBy: "traces" } })
    // Every slot found: no generic "root does not match" finding, and the verdict is red on the shadow entry.
    expect(report.findings.filter((f) => f.code === "unexplained-storage")).toEqual([])
    expect(report.verdict.kind).toBe("unexplained")
    expect(report.diagnosis?.steps.find((s) => s.id === "traces")?.status).toBe("explained")
  })

  it("keeps the slot unexplained when no trace or event names its address", async () => {
    const report = await reportOf(traced([]))

    expect(report.findings.map((f) => f.code)).not.toContain("shadow-owner")
    expect(report.findings.filter((f) => f.code === "unexplained-storage" && f.section === "diagnosis")).toHaveLength(1)
    // The root matches (the key was found) but the slot is still unexplained, so it is red.
    expect(report.storage).toMatchObject({ data: { matchedBy: "traces" } })
    expect(report.verdict.kind).toBe("unexplained")
  })

  // Fix 2: the pass-1 mismatch is not a finding once pass 2 explains it.
  it("raises no root finding when pass 2 matches", async () => {
    const HASH_A: Hex = "0x9b8d6c1a8f5dfcb5d6b5c1f0a9e0c8f6f2a4d3e1b7c9a5f3e2d1c0b9a8f7e6d5"
    const world = withStorage(
      {
        ...b1World(),
        history: [
          configEventLog(
            B1_SAFE,
            [EVENT_TOPICS.SafeSetup, pad(B1_SAFE, { size: 32 })],
            buildSetup([B1_OWNER], 1n, ADDRESS.compat141),
          ),
          configEventLog(B1_SAFE, [EVENT_TOPICS.EnabledModule, pad(ADDRESS.vetoModule, { size: 32 })]),
          configEventLog(B1_SAFE, [EVENT_TOPICS.EnabledModule, pad(B1_REALITY, { size: 32 })]),
          configEventLog(B1_SAFE, [EVENT_TOPICS.ApproveHash, HASH_A, pad(B1_OWNER, { size: 32 })]),
        ],
      },
      B1_SAFE,
      (entries) => [...entries, { slot: approvedHashSlot(B1_OWNER, HASH_A), value: 1n }],
    )
    const { report, events } = await check(world)
    if (report === null) throw new Error("stopped")

    expect(report.verdict.kind).toBe("explained")
    expect(report.findings.map((f) => f.code)).not.toContain("unexplained-storage")
    // Never streamed either: the UI must not show a High finding that later disappears.
    expect(events.some((e) => e.type === "finding" && e.finding.code === "unexplained-storage")).toBe(false)
  })

  it("keeps one root finding when nothing explains the mismatch", async () => {
    const report = await reportOf(negWorld())

    expect(report.findings.filter((f) => f.code === "unexplained-storage" && f.section === "storage")).toHaveLength(1)
  })
})

describe("calldataAddresses", () => {
  it("keeps address-shaped argument words only: not the selector, zero words or full 32-byte values", async () => {
    const { calldataAddresses } = await import("@/check/steps/diagnosis")
    const data = encodeFunctionData({
      abi: parseAbi(["function f(address a, bytes32 h, uint256 z)"]),
      functionName: "f",
      args: [B1_OWNER, `0x${"ab".repeat(32)}`, 0n],
    })

    expect(calldataAddresses(data)).toEqual([B1_OWNER])
    expect(calldataAddresses("0x")).toEqual([])
  })
})

describe("runCheck names a setup-only shadow owner from the creation calldata", () => {
  it("tries the addresses in the setup data, so a shadow written at setup by a helper is named", async () => {
    const SHADOW_X: Address = "0x0000000000000000000000000000000000000002"
    const HELPER: Address = "0x00000000000000000000000000000000000fa11B"
    const TX = "0x00000000000000000000000000000000000000000000000000000000000000c8" as const
    const helperCall = encodeFunctionData({
      abi: parseAbi(["function write(address x)"]),
      functionName: "write",
      args: [SHADOW_X],
    })
    const setup = encodeFunctionData({
      abi: SAFE_ABI,
      functionName: "setup",
      args: [[B1_OWNER], 1n, HELPER, helperCall, ADDRESS.compat141, zeroAddress, 0n, zeroAddress],
    })
    const input = encodeFunctionData({
      abi: FACTORY_ABI,
      functionName: "createProxyWithNonce",
      args: [ADDRESS.safe141, setup, 0n],
    })
    const base = account(
      account(
        withStorage(b1World(), B1_SAFE, () => [...FIXTURES[1].entries]),
        ADDRESS.factory141,
        {
          codeHash: HASH.factory141,
        },
      ),
      HELPER,
      { code: "0x6080604052600080fd" },
    )
    const world: FakeWorld = {
      ...base,
      creation: {
        lookup: { found: true, txHash: TX, blockNumber: 1n, source: { service: "rpc", host: "eth.drpc.org" } },
        tx: { hash: TX, from: B1_OWNER, to: ADDRESS.factory141, input, blockNumber: 1n, status: true },
        logs: [
          configEventLog(
            ADDRESS.factory141,
            [EVENT_TOPICS.ProxyCreation, pad(B1_SAFE, { size: 32 })],
            pad(ADDRESS.safe141, { size: 32 }),
          ),
        ],
        // The trace shows the slot written but not the helper's argument as an account.
        diff: {
          [B1_SAFE]: {
            pre: {},
            post: { [ownerSlot(SHADOW_X)]: "0x0000000000000000000000000000000000000000000000000000000000000001" },
          },
        },
      },
    }
    const report = await reportOf(world)

    expect(report.findings.find((f) => f.code === "shadow-owner")?.subject).toBe(SHADOW_X)
    expect(report.findings.map((f) => f.code)).toContain("setup-delegatecall-unknown")
  })
})

describe("runCheck approvals, events and the Transaction Service", () => {
  const H: Hex = "0x9b8d6c1a8f5dfcb5d6b5c1f0a9e0c8f6f2a4d3e1b7c9a5f3e2d1c0b9a8f7e6d5"
  const STRANGER: Address = "0x000000000000000000000000000000000000bEEF"
  const approve = (owner: Address) => configEventLog(B1_SAFE, [EVENT_TOPICS.ApproveHash, H, pad(owner, { size: 32 })])
  // Every non-zero slot of the Safe, as debug_storageRangeAt serves it.
  const enumerated = (world: FakeWorld) => ({
    values: new Map(
      (world.accounts[B1_SAFE.toLowerCase()].storage ?? []).map(({ slot, value }) => [
        slot.toLowerCase() as Hex,
        value,
      ]),
    ),
    complete: true,
  })
  const withApproval = () =>
    withStorage(b1World(), B1_SAFE, (entries) => [...entries, { slot: approvedHashSlot(B1_OWNER, H), value: 1n }])

  it("rates an approval written without its own ApproveHash event as Critical, even next to a planted one", async () => {
    const planted = withApproval()
    // The helper that wrote the slot also emitted ApproveHash naming someone else.
    const report = await reportOf({
      ...planted,
      history: [...defaultHistory(planted), approve(STRANGER)],
      storageRange: enumerated(planted),
    })

    expect(codes(report)).toContain("approval-without-event")
    expect(report.findings.find((f) => f.code === "approval-without-event")?.severity).toBe("critical")
    expect(report.verdict.kind).toBe("unexplained")
    if (report.storage.state !== "complete") throw new Error("storage")
    expect(report.storage.data.slots.find((row) => row.key === approvedHashSlot(B1_OWNER, H))?.status).toBe(
      "suspicious",
    )
  })

  it("is amber, not Critical, for an approval without its event when part of the history was not read", async () => {
    const planted = withApproval()
    // The hash is known from a planted ApproveHash naming someone else; the owner's own event may lie in the unread part.
    const report = await reportOf({
      ...planted,
      history: [...defaultHistory(planted), approve(STRANGER)],
      historyStop: { by: "time", at: 26000000n },
      storageRange: enumerated(planted),
    })

    expect(codes(report)).not.toContain("approval-without-event")
    expect(codes(report)).toContain("pending-approved-hash")
    expect(report.verdict.kind).toBe("unverified")
    expect(report.verdict.unverified.map((u) => u.reason)).toEqual(["history-incomplete"])
    if (report.storage.state !== "complete") throw new Error("storage")
    expect(report.storage.data.slots.find((row) => row.key === approvedHashSlot(B1_OWNER, H))).toMatchObject({
      status: "benign",
      eventNotRead: true,
    })
  })

  it("is amber when the approval's own event is not confirmed by a second RPC", async () => {
    const world = withApproval()
    const report = await reportOf({
      ...world,
      history: [...defaultHistory(world), approve(B1_OWNER)],
      unconfirmed: (log) => log.topics[0] === EVENT_TOPICS.ApproveHash,
    })

    expect(report.storage).toMatchObject({ state: "partial", data: { matchedBy: "events" } })
    expect(report.verdict.unverified.map((u) => u.reason)).toEqual(["read-failed"])
    expect(report.verdict.unverified[0].detail).toContain("not confirmed by a second RPC")
  })

  it("is amber, not red, when the read of the event slots fails", async () => {
    const world = withApproval()
    const slot = approvedHashSlot(B1_OWNER, H)
    const report = await reportOf({
      ...world,
      history: [...defaultHistory(world), approve(B1_OWNER)],
      proofFailure: (_address, slots) =>
        slots.includes(slot) ? ioError("rate-limited", { title: "Too many requests" }) : undefined,
    })

    expect(report.steps.find((s) => s.id === "storage-events")?.status).toBe("failed")
    expect(report.verdict.kind).toBe("unverified")
    expect(report.verdict.unverified).toEqual([
      { reason: "read-failed", detail: expect.stringContaining("Too many requests") },
    ])
    // No High finding rests on the failed read either.
    expect(codes(report)).not.toContain("unexplained-storage")
  })

  it("stays red when the approval's event lies beyond an incomplete history, and says what settles it", async () => {
    const world = withApproval()
    // The read stopped at its time limit before the ApproveHash block, so the history holds no ApproveHash.
    const report = await reportOf({
      ...world,
      historyStop: { by: "time", at: 26000000n },
      storageRange: enumerated(world),
    })

    expect(report.verdict.kind).toBe("unexplained")
    expect(report.verdict.reasons[1]).toMatch(
      /^The event history could be read only for blocks 0 to 26000000, so an approval or signed message from outside that range may explain these slots\./,
    )
  })

  it("shows the range an indexer actually read when it walked back only part of the way", async () => {
    const world = withApproval()
    const report = await reportOf({
      ...world,
      historySource: { service: "blockscout", host: "eth.blockscout.com" },
      historyStop: { by: "time", at: 26176126n, from: 26100000n },
      storageRange: enumerated(world),
    })

    expect(report.history).toMatchObject({ data: { fromBlock: "26100000", toBlock: "26176126" } })
    if (report.history.state !== "partial") throw new Error("history")
    expect(report.history.gaps[0]).toContain("it covers blocks 26100000 to 26176126, not 0 to 26176126")
    expect(report.verdict.reasons[1]).toMatch(/^The event history could be read only for blocks 26100000 to 26176126,/)
  })

  it("re-reads every pass-1 row with the event slots in one read (tip mode)", async () => {
    const world = withApproval()
    const { report, log } = await check({
      ...world,
      anchor: { pinnedBy: "tip" },
      history: [...defaultHistory(world), approve(B1_OWNER)],
    })
    const safeReads = log.filter((entry) => entry.method === "proveAccount" && entry.address === B1_SAFE)
    // The last read is pass 2; the one before the pending step's is pass 1.
    const withApprovalSlot = safeReads.filter((entry) => entry.slots?.includes(approvedHashSlot(B1_OWNER, H)))
    const pass2 = withApprovalSlot.at(-1)
    const pass1 = safeReads[safeReads.indexOf(withApprovalSlot[0]) - 1]

    expect(report?.storage).toMatchObject({ state: "complete", data: { matchedBy: "events" } })
    expect(pass1.slots!.every((key) => pass2?.slots?.includes(key))).toBe(true)
  })

  it("confirms only the events that clear a finding, and the executions of approved hashes", async () => {
    const world = withApproval()
    const execution = (hash: Hex) =>
      configEventLog(B1_SAFE, [EVENT_TOPICS.ExecutionSuccess, hash], pad(toHex(0n), { size: 32 }))
    const plain = execution(pad("0x01", { size: 32 }))
    const spends = execution(H)
    const { log } = await check({ ...world, history: [...defaultHistory(world), approve(B1_OWNER), plain, spends] })
    const confirmed = log.filter((entry) => entry.method === "confirm").flatMap((entry) => entry.slots ?? [])

    expect(confirmed).not.toContain(plain.transactionHash)
    expect(confirmed).toContain(spends.transactionHash)
    expect(confirmed).toHaveLength(defaultHistory(world).length + 2)
  })

  it("counts only the Safe's own logs: an EnabledModule from another address clears nothing", async () => {
    const world = b1World()
    const reality = pad(B1_REALITY, { size: 32 }).toLowerCase()
    const own = defaultHistory(world).filter((entry) => entry.topics[1]?.toLowerCase() !== reality)
    const foreign = configEventLog(OTHER, [EVENT_TOPICS.EnabledModule, pad(B1_REALITY, { size: 32 })])
    const report = await reportOf({ ...world, history: [...own, foreign] })

    expect(report.findings.find((f) => f.code === "config-without-event")?.subject).toBe(B1_REALITY)
  })

  it("names a shadow owner whose address appears only in an event", async () => {
    const neg = withStorage(b1World(), B1_SAFE, () => [...FIXTURES[1].entries])
    const shadow: Address = "0x0000000000000000000000000000000000000002"
    const removed = configEventLog(B1_SAFE, [EVENT_TOPICS.RemovedOwner, pad(shadow, { size: 32 })])
    const report = await reportOf({ ...neg, history: [...defaultHistory(neg), removed], storageRange: enumerated(neg) })

    expect(report.findings.find((f) => f.code === "shadow-owner")?.subject).toBe(shadow)
  })

  it("is amber when any read disagreed with the cross-check", async () => {
    const issues = new IssueLog()
    issues.add(issue("disagreement", { host: CROSS.host, role: "cross-check" }))
    const { report } = await check(b1World(), {}, { issues })

    expect(report?.verdict.unverified.map((u) => u.reason)).toEqual(["rpc-disagreement"])
  })

  it("says a corrupt owner list is corrupt, not that it changed between two reads", async () => {
    const world = withStorage(b1World(), B1_SAFE, (entries) => [
      ...entries.filter((entry) => entry.slot !== ownerSlot(B1_OWNER)),
      { slot: ownerSlot(B1_OWNER), value: hexToBigInt(OTHER) },
    ])
    const report = await reportOf(world)
    const gaps = report.storage.state === "partial" ? report.storage.gaps : []

    expect(codes(report)).toContain("list-corrupt")
    expect(gaps.join(" ")).not.toContain("changed between two reads")
  })

  it("lists the Transaction Service as a service, with its messages and delegates cleaned", async () => {
    const report = await reportOf({
      ...b1World(),
      stsMessages: [{ messageHash: H, created: "2026-10-01T00:00:00Z", confirmations: [{ owner: B1_OWNER }] }],
      stsDelegates: [
        { delegate: OTHER, delegator: B1_OWNER, label: `bot\n# Storage fully explained${"x".repeat(100)}` },
      ],
    })

    if (report.pending.state !== "complete") throw new Error("pending")
    expect(report.pending.data.sources).toContainEqual({ service: "safe-tx-service", host: "api.safe.global" })
    expect(report.pending.data.messages).toEqual([{ hash: H, confirmations: 1, created: "2026-10-01T00:00:00Z" }])
    expect(report.pending.data.delegates[0].label).not.toContain("\n")
    expect(report.pending.data.delegates[0].label.length).toBeLessThanOrEqual(67)
  })

  it("asks Sourcify only when public indexers are on", async () => {
    const world = account(b1World(), ADDRESS.compat141, { code: UNKNOWN_CODE })
    const on = await check(world)
    const off = await check({ ...world, publicIndexers: false })

    expect(on.log.some((entry) => entry.method === "sourcify")).toBe(true)
    expect(off.log.some((entry) => entry.method === "sourcify")).toBe(false)
  })

  it("says whether an event set the fallback handler", async () => {
    const complete = await reportOf(b1World())
    const none = await reportOf({ ...b1World(), history: "none" })

    expect(complete.handlers).toMatchObject({ data: { fallbackHandler: { announced: "yes" } } })
    expect(none.handlers).toMatchObject({ data: { fallbackHandler: { announced: "unknown" } } })
  })

  it("says where and why the history read stopped", async () => {
    const report = await reportOf({ ...b1World(), historyStop: { by: "time", at: 26000000n } })

    expect(report.history).toMatchObject({ state: "partial", data: { toBlock: "26000000", complete: false } })
    if (report.history.state !== "partial") throw new Error("history")
    expect(report.history.gaps[0]).toBe(
      `The history read stopped at its time limit: it covers blocks 0 to 26000000, not 0 to ${report.verification.anchor.number}.`,
    )
    expect(codes(report)).toContain("history-incomplete")
  })

  it("says plainly when no block range of the history could be read", async () => {
    // The first chunk failed: the read ends one block before it started.
    const report = await reportOf({ ...b1World(), historyStop: { by: "failure", at: -1n } })

    expect(report.history).toEqual({
      state: "unavailable",
      reason:
        "No block range of the event history could be read from eth.drpc.org, so no event was read. The issues list says why.",
    })
    expect(codes(report)).toContain("history-incomplete")
    expect(JSON.stringify(report)).not.toContain("block -1")
  })

  it("reports an event history that could not be read as incomplete, in the findings and the reasons", async () => {
    const report = await reportOf({ ...b1World(), failures: { logs: ioError("timeout") } })

    expect(codes(report)).toContain("history-incomplete")
    expect(report.verdict.reasons.join(" ")).toContain("The event history is incomplete")
  })

  it("rates a Safe used as a module like an owner Safe, not as an unknown module", async () => {
    const world = withStorage(
      { ...b1World(), accounts: { ...b1World().accounts, ...b3World().accounts } },
      B1_SAFE,
      (entries) => {
        const head = entries.find((entry) => entry.slot === moduleSlot(SENTINEL))!
        return [
          ...entries.filter((entry) => entry !== head),
          { slot: moduleSlot(SENTINEL), value: hexToBigInt(B3_SAFE) },
          { slot: moduleSlot(B3_SAFE), value: head.value },
        ]
      },
    )
    const report = await reportOf(world)

    if (report.modules.state !== "complete") throw new Error("modules")
    expect(report.modules.data.modules.find((m) => m.address === B3_SAFE)?.kind).toBe("safe")
    expect(report.findings.filter((f) => f.subject === B3_SAFE)).toEqual([])
  })
})
