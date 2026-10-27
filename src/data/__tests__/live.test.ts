// @vitest-environment node
// Live reads against public RPCs. Run with LIVE=1 npx vitest run src/data/__tests__/live.test.ts
import type { Hex } from "viem"
import { describe, expect, it } from "vitest"
import { getChain, providers } from "@/data/chains"
import { buildPool } from "@/data/endpoints"
import { CapabilityCache } from "@/data/probe"
import { Reader } from "@/data/reader"
import { defaultSettings } from "@/data/settings"
import { Transport } from "@/data/transport"
import type { ChainInfo, DefaultRpc, Settings } from "@/data/types"
import { SLOTS } from "@/data/__tests__/fakeRpc"

const B1 = "0xAd219b3c26fe42BF5FC66F67490745a4fa5dff59"
const B1_ROOT = "0x4321ab747900a628bc24642a1cff166280215c287be657997cff8468934b693e"
const SAFEDAO_GNOSIS = "0x9D02bed59170cdE96782Ea9a9b17F9bCF4916127"

function readerFor(chain: ChainInfo, settings: Settings = defaultSettings()) {
  const issues: string[] = []
  const reader = new Reader(chain, buildPool(chain, settings, providers()), {
    transport: new Transport(),
    capabilities: new CapabilityCache(),
    settings,
    onIssue: (issue) => issues.push(`${issue.kind} ${issue.host}: ${issue.raw.message ?? ""}`),
    probeAddress: B1,
  })
  return { reader, issues }
}

function only(chainId: number, urls: string[]): ChainInfo {
  const chain = getChain(chainId) as ChainInfo
  const rpcs = urls.map((url) => chain.rpcs.find((r) => r.url === url) as DefaultRpc)
  return { ...chain, rpcs }
}

describe.skipIf(!import.meta.env.LIVE)("live", () => {
  it("proves the B1 Safe's storage root at block 26176126 with a two-operator anchor", async () => {
    const { reader, issues } = readerFor(only(1, ["https://eth.drpc.org", "https://eth-mainnet.public.blastapi.io"]))

    const anchor = await reader.anchor({ block: 26176126n })
    const read = await reader.proveAccount(B1, SLOTS)

    expect(anchor).toMatchObject({ number: 26176126n, pinnedBy: "user", header: "match" })
    expect(reader.pair().primary.operator).not.toBe(reader.pair().crossCheck?.operator)
    expect(read.account?.storageHash).toBe(B1_ROOT)
    expect(read.cross.storageRoot).toBe("match")
    console.log(issues)
  }, 120_000)

  it("anchors in tip mode on ethereum-rpc.publicnode.com, which proves only the newest block", async () => {
    const { reader, issues } = readerFor(only(1, ["https://ethereum-rpc.publicnode.com"]))

    const anchor = await reader.anchor({ block: null })
    const read = await reader.proveAccount(B1, SLOTS)

    expect(anchor.pinnedBy).toBe("tip")
    expect(read.anchor.pinnedBy).toBe("tip")
    expect(read.account?.codeHash).toBe("0xd7d408ebcd99b2b70be43e20253d6d92a8ea8fab29bd3be7f55b10032331fb4c" as Hex)
    console.log(anchor.note, read.anchor.number, issues)
  }, 120_000)

  it("pins latest - 3 on the Gnosis team RPC (16-block proof window)", async () => {
    const { reader } = readerFor(only(100, ["https://rpc.gnosischain.com", "https://gnosis-rpc.publicnode.com"]))

    const anchor = await reader.anchor({ block: null })
    const read = await reader.proveAccount(SAFEDAO_GNOSIS, [])

    expect(anchor).toMatchObject({ pinnedBy: "offset", header: "match", note: null })
    expect(reader.pair().primary.host).toBe("rpc.gnosischain.com")
    expect(read.account).not.toBeNull()
  }, 120_000)
})
