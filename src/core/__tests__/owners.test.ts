import type { Address } from "viem"
import { describe, expect, it } from "vitest"
import { ADDRESS, HASH, REGISTRY } from "@/core/__tests__/fixtures/registry"
import { EMPTY_CODE_HASH } from "@/core/constants"
import { accountKind, checkOwners, isPrecompile, type OwnerFacts } from "@/core/owners"
import { identify } from "@/core/registry"

const OWNER: Address = "0x802cbafa6133c493A7c67f685f97AdA5918d1dF9"
const DELEGATION = "0xef01005a7fc11397e9a8ad41bf10bf13f22b0a63f96f6d"

describe("isPrecompile", () => {
  it("covers 0x01 to 0x11 and 0x100", () => {
    expect(isPrecompile("0x0000000000000000000000000000000000000001")).toBe(true)
    expect(isPrecompile("0x0000000000000000000000000000000000000002")).toBe(true)
    expect(isPrecompile("0x0000000000000000000000000000000000000011")).toBe(true)
    expect(isPrecompile("0x0000000000000000000000000000000000000100")).toBe(true)
    expect(isPrecompile("0x0000000000000000000000000000000000000000")).toBe(false)
    expect(isPrecompile("0x0000000000000000000000000000000000000012")).toBe(false)
    expect(isPrecompile(OWNER)).toBe(false)
  })
})

describe("accountKind", () => {
  const base = { address: OWNER, code: null, safe: false }

  it("tells the kinds apart", () => {
    expect(accountKind({ ...base, codeHash: null })).toEqual({ kind: "eoa", delegate: null })
    expect(accountKind({ ...base, codeHash: EMPTY_CODE_HASH })).toEqual({ kind: "eoa", delegate: null })
    expect(accountKind({ ...base, codeHash: HASH.compat141, code: DELEGATION })).toEqual({
      kind: "delegated-eoa",
      delegate: "0x5A7FC11397E9a8AD41BF10bf13F22B0a63f96f6d",
    })
    expect(accountKind({ ...base, codeHash: HASH.proxy141, safe: true })).toEqual({ kind: "safe", delegate: null })
    expect(accountKind({ ...base, codeHash: HASH.compat141 })).toEqual({ kind: "contract", delegate: null })
    expect(accountKind({ ...base, address: "0x0000000000000000000000000000000000000002", codeHash: null })).toEqual({
      kind: "precompile",
      delegate: null,
    })
  })
})

function owner(overrides: Partial<OwnerFacts>): OwnerFacts {
  return { address: OWNER, kind: "eoa", delegate: null, identification: null, safe: null, ...overrides }
}

describe("checkOwners", () => {
  const counts = { threshold: "1", ownerCount: "1" }

  it("passes plain accounts and Safes", () => {
    const safe = owner({
      kind: "safe",
      identification: identify(REGISTRY, 1, { address: OWNER, codeHash: HASH.proxy141 }),
      safe: { version: "1.4.1", owners: [ADDRESS.safe141], threshold: "1" },
    })
    const result = checkOwners([owner({}), safe], counts)

    expect(result.findings).toEqual([])
    expect(result.section).toMatchObject({ threshold: "1", ownerCount: "1", inertOnly: false })
    expect(result.section.owners[1].safe?.version).toBe("1.4.1")
  })

  it("flags delegated and contract owners", () => {
    const result = checkOwners(
      [
        owner({ kind: "delegated-eoa", delegate: "0x5A7FC11397E9a8AD41BF10bf13F22B0a63f96f6d" }),
        owner({
          kind: "contract",
          identification: identify(REGISTRY, 1, { address: OWNER, codeHash: HASH.compat141 }),
        }),
      ],
      counts,
    )

    expect(result.findings.map((f) => f.code)).toEqual(["delegated-owner", "contract-owner"])
    expect(result.section.owners.map((row) => row.flags)).toEqual([["delegated-owner"], ["contract-owner"]])
    expect(result.findings[0].technical).toContain("0x5A7FC11397E9a8AD41BF10bf13F22B0a63f96f6d")
  })

  it("explains a Safe whose only owners are precompiles", () => {
    const inert = owner({ address: "0x0000000000000000000000000000000000000002", kind: "precompile" })
    const result = checkOwners([inert], counts)

    expect(result.findings.map((f) => f.code)).toEqual(["inert-owners"])
    expect(result.section.inertOnly).toBe(true)
    expect(checkOwners([inert, owner({})], counts).section.inertOnly).toBe(false)
  })
})
