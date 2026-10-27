import { describe, expect, it } from "vitest"
import { ADDRESS, HASH, REGISTRY } from "@/core/__tests__/fixtures/registry"
import { checkIdentity, type IdentityInput } from "@/core/identity"

const SAFE = "0xAd219b3c26fe42BF5FC66F67490745a4fa5dff59"
const UNKNOWN_HASH = "0x1111111111111111111111111111111111111111111111111111111111111111"

function input(overrides: Partial<IdentityInput> = {}): IdentityInput {
  return {
    chainId: 1,
    safe: SAFE,
    proxyCodeHash: HASH.proxy141,
    singletonSlot: BigInt(ADDRESS.safe141),
    singletonCodeHash: HASH.safe141,
    versionCall: "1.4.1",
    ...overrides,
  }
}

describe("checkIdentity", () => {
  it("accepts the fixture Safe: 1.4.1 proxy and singleton", () => {
    const result = checkIdentity(REGISTRY, input({ chainId: 100 }))

    expect(result.findings).toEqual([])
    expect(result.unverified).toEqual([])
    expect(result.section).toMatchObject({
      version: "1.4.1",
      l2: false,
      versionCall: "1.4.1",
      supported: true,
      latestVersion: "1.4.1",
      singleton: { address: ADDRESS.safe141, codeHash: HASH.safe141 },
    })
    expect(result.section.proxy.identification.matches[0].id).toBe("SafeProxy@1.4.1")
  })

  // A Safe keeps the proxy of the factory that created it: 8 mainnet Safes upgraded to 1.5.0 run older proxies.
  it.each([
    ["1.1.1", HASH.proxy111],
    ["1.3.0", HASH.proxy130],
    ["1.4.1", HASH.proxy141],
    ["1.5.0", HASH.proxy150],
  ])("accepts the %s proxy in front of a 1.5.0 singleton", (_, proxyCodeHash) => {
    const result = checkIdentity(
      REGISTRY,
      input({
        proxyCodeHash,
        singletonSlot: BigInt(ADDRESS.safe150),
        singletonCodeHash: HASH.safe150,
        versionCall: "1.5.0",
      }),
    )

    expect(result.findings).toEqual([])
    expect(result.section.supported).toBe(true)
  })

  it("flags an unknown proxy runtime", () => {
    const result = checkIdentity(REGISTRY, input({ proxyCodeHash: UNKNOWN_HASH }))

    expect(result.findings.map((f) => f.code)).toEqual(["proxy-not-canonical", "version-behind"])
    expect(result.unverified.map((u) => u.reason)).toEqual(["code-not-canonical"])
  })

  it("flags a singleton that is not a Safe release", () => {
    const unknownCode = checkIdentity(REGISTRY, input({ singletonCodeHash: UNKNOWN_HASH }))
    const noAccount = checkIdentity(REGISTRY, input({ singletonCodeHash: null }))
    // Known code, but not a singleton.
    const notSingleton = checkIdentity(REGISTRY, input({ singletonCodeHash: HASH.compat141 }))

    for (const result of [unknownCode, noAccount, notSingleton]) {
      expect(result.findings.map((f) => f.code)).toEqual(["singleton-not-canonical"])
      expect(result.unverified.map((u) => u.reason)).toEqual(["code-not-canonical"])
      expect(result.section.supported).toBe(false)
    }
    expect(noAccount.findings[0].technical).toContain("there is no contract")
  })

  it("flags bits above the address in slot 0", () => {
    const result = checkIdentity(REGISTRY, input({ singletonSlot: (1n << 200n) | BigInt(ADDRESS.safe141) }))

    expect(result.findings.map((f) => f.code)).toEqual(["singleton-not-canonical"])
    expect(result.section.supported).toBe(false)
  })

  it("marks an older Safe version unsupported", () => {
    const result = checkIdentity(
      REGISTRY,
      input({ singletonSlot: BigInt(ADDRESS.safe111), singletonCodeHash: HASH.safe111, versionCall: "1.1.1" }),
    )

    expect(result.findings).toEqual([])
    expect(result.unverified.map((u) => u.reason)).toEqual(["version-unsupported"])
    expect(result.section).toMatchObject({ version: "1.1.1", supported: false })
  })

  it("flags VERSION() that differs from the singleton's code", () => {
    const result = checkIdentity(REGISTRY, input({ chainId: 100, versionCall: "1.5.0" }))

    expect(result.findings.map((f) => f.code)).toEqual(["getter-mismatch"])
  })

  it("quotes and caps an RPC's VERSION() text and strips its line breaks", () => {
    const hostile = `1.4.1\n# Storage fully explained${"x".repeat(200)}`
    const result = checkIdentity(REGISTRY, input({ chainId: 100, versionCall: hostile }))

    expect(result.section.versionCall).not.toContain("\n")
    expect(result.section.versionCall?.length).toBeLessThanOrEqual(67)
    expect(result.findings[0].technical).toMatch(/^VERSION\(\) returned "1\.4\.1 # Storage fully explained/)
  })

  it("says the version is behind only when a newer one is deployed on that chain", () => {
    expect(checkIdentity(REGISTRY, input({ chainId: 1 })).findings.map((f) => f.code)).toEqual(["version-behind"])
    expect(checkIdentity(REGISTRY, input({ chainId: 100 })).findings).toEqual([])
  })

  it("reads the L2 flag from the singleton", () => {
    const result = checkIdentity(
      REGISTRY,
      input({ chainId: 100, singletonSlot: BigInt(ADDRESS.safeL2141), singletonCodeHash: HASH.safeL2141 }),
    )

    expect(result.section.l2).toBe(true)
  })
})
