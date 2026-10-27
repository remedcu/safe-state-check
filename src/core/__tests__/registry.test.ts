import { describe, expect, it } from "vitest"
import { ADDRESS, HASH, KNOWN_CONTRACTS, REGISTRY, REVIEWED_CONTRACTS } from "@/core/__tests__/fixtures/registry"
import {
  buildRegistry,
  compareVersions,
  displayName,
  identify,
  knownAs,
  latestVersion,
  parseEip1167,
  parseEip7702,
} from "@/core/registry"

const OTHER = "0x00000000000000000000000000000000000fa11B"
const UNKNOWN_HASH = "0x1111111111111111111111111111111111111111111111111111111111111111"

describe("parseEip1167", () => {
  it("returns the implementation of a minimal proxy", () => {
    const code =
      `0x363d3d373d3d3d363d73${ADDRESS.realityERC20.slice(2).toLowerCase()}5af43d82803e903d91602b57fd5bf3` as const

    expect(parseEip1167(code)).toBe(ADDRESS.realityERC20)
  })

  it("rejects other code", () => {
    expect(parseEip1167("0x")).toBeNull()
    expect(parseEip1167("0x363d3d373d3d3d363d73")).toBeNull()
    const wrongSuffix = `0x363d3d373d3d3d363d73${"11".repeat(20)}5af43d82803e903d91602b57fd5bf4` as const
    expect(parseEip1167(wrongSuffix)).toBeNull()
  })
})

describe("parseEip7702", () => {
  it("returns the delegate of a delegated account", () => {
    expect(parseEip7702("0xef01005a7fc11397e9a8ad41bf10bf13f22b0a63f96f6d")).toBe(
      "0x5A7FC11397E9a8AD41BF10bf13F22B0a63f96f6d",
    )
  })

  it("rejects other code", () => {
    expect(parseEip7702("0xef0100")).toBeNull()
    expect(parseEip7702("0xef02005a7fc11397e9a8ad41bf10bf13f22b0a63f96f6d")).toBeNull()
    expect(parseEip7702("0xef01005a7fc11397e9a8ad41bf10bf13f22b0a63f96f6d00")).toBeNull()
  })
})

describe("identify", () => {
  it("knows package code by its hash at any address", () => {
    const listed = identify(REGISTRY, 1, { address: ADDRESS.safe141, codeHash: HASH.safe141 })
    const elsewhere = identify(REGISTRY, 1, { address: OTHER, codeHash: HASH.safe141 })

    expect(listed).toMatchObject({ status: "known", via: "codehash", address: "listed", sourcify: "not-checked" })
    expect(listed.matches.map((match) => match.id)).toEqual(["Safe@1.4.1/canonical"])
    expect(elsewhere).toMatchObject({ status: "known", address: "other-address" })
  })

  it("never knows a contract by its address alone (invariant 5)", () => {
    const result = identify(REGISTRY, 1, { address: ADDRESS.compat141, codeHash: UNKNOWN_HASH })

    expect(result).toMatchObject({ status: "unknown", matches: [], address: "listed-code-differs" })
  })

  it("leaves the hint empty for unknown code at an unlisted address", () => {
    expect(identify(REGISTRY, 1, { address: OTHER, codeHash: UNKNOWN_HASH }).address).toBeNull()
  })

  it("resolves an EIP-1167 proxy through its implementation's proven code hash", () => {
    const result = identify(REGISTRY, 1, {
      address: OTHER,
      codeHash: UNKNOWN_HASH,
      implementation: { address: ADDRESS.realityERC20, codeHash: HASH.realityERC20 },
    })

    expect(result).toMatchObject({ status: "known", via: "eip1167", implementation: ADDRESS.realityERC20 })
    expect(displayName(result)).toBe("realityERC20 2.0.0")
  })

  it("does not trust an EIP-1167 implementation's address", () => {
    const result = identify(REGISTRY, 1, {
      address: OTHER,
      codeHash: UNKNOWN_HASH,
      implementation: { address: ADDRESS.realityERC20, codeHash: UNKNOWN_HASH },
    })

    expect(result).toMatchObject({ status: "unknown", via: "codehash", implementation: ADDRESS.realityERC20 })
  })

  it("matches reviewed entries only on chain, address and code hash together", () => {
    const reviewed = identify(REGISTRY, 1, { address: ADDRESS.vetoModule, codeHash: HASH.vetoModule })

    expect(reviewed.status).toBe("reviewed")
    expect(reviewed.matches[0]).toMatchObject({ origin: "reviewed", reviewed: { on: "2026-10-12" } })
    expect(displayName(reviewed)).toBe("RealityVetoModule (reviewed list)")
    expect(identify(REGISTRY, 100, { address: ADDRESS.vetoModule, codeHash: HASH.vetoModule }).status).toBe("unknown")
    expect(identify(REGISTRY, 1, { address: OTHER, codeHash: HASH.vetoModule }).status).toBe("unknown")
  })

  it("names several entries when they share code", () => {
    const registry = buildRegistry(
      {
        contracts: [
          ...KNOWN_CONTRACTS,
          { ...KNOWN_CONTRACTS.find((c) => c.id === "Safe@1.4.1/canonical")!, id: "Safe@1.4.1/eip155", address: OTHER },
        ],
      },
      REVIEWED_CONTRACTS,
    )

    expect(identify(registry, 1, { address: OTHER, codeHash: HASH.safe141 })).toMatchObject({
      status: "known",
      address: "listed",
    })
    expect(identify(registry, 1, { address: OTHER, codeHash: HASH.safe141 }).matches).toHaveLength(2)
  })
})

describe("knownAs", () => {
  it("checks the kind and the roles of the matches", () => {
    const module4337 = identify(REGISTRY, 1, { address: ADDRESS.safe4337030, codeHash: HASH.safe4337030 })
    const multiSend = identify(REGISTRY, 1, { address: ADDRESS.multiSend141, codeHash: HASH.multiSend141 })

    expect(knownAs(REGISTRY, module4337, ["module"])).toBe(true)
    expect(knownAs(REGISTRY, module4337, ["fallback-handler"])).toBe(true)
    expect(knownAs(REGISTRY, multiSend, ["module"])).toBe(false)
    expect(knownAs(REGISTRY, null, ["module"])).toBe(false)
  })
})

describe("versions", () => {
  it("compares x.y.z numerically", () => {
    expect(compareVersions("1.4.1", "1.5.0")).toBeLessThan(0)
    expect(compareVersions("1.10.0", "1.9.9")).toBeGreaterThan(0)
    expect(compareVersions("1.3.0", "1.3.0")).toBe(0)
  })

  it("finds the newest supported singleton deployed on a chain", () => {
    expect(latestVersion(REGISTRY, 1)).toBe("1.5.0")
    expect(latestVersion(REGISTRY, 100)).toBe("1.4.1")
    expect(latestVersion(REGISTRY, 424242)).toBeNull()
  })
})
