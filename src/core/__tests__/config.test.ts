import { type Address, type Hex, toHex } from "viem"
import { describe, expect, it } from "vitest"
import { B1 } from "@/core/__tests__/fixtures/appendixB"
import { checkConfig, classifySlot6, type ConfigInput, legacyDomainSeparator, nextModulesStart } from "@/core/config"
import { SENTINEL } from "@/core/constants"
import { walkList } from "@/core/linkedList"
import { moduleSlot, ownerSlot, slotKey } from "@/core/slots"

const SAFE = "0xAd219b3c26fe42BF5FC66F67490745a4fa5dff59"
const OWNER = "0x802cbafa6133c493A7c67f685f97AdA5918d1dF9"
const MODULES: Address[] = ["0x4210382652A5e3C9aF7e1D3c88085818A465449b", "0x8DFc5Db2C83200Cf0cC84d7e3C441d7721ef83dC"]

function b1Values(change: (values: Map<Hex, bigint>) => void = () => {}): Map<Hex, bigint> {
  const values = new Map(B1.map(({ slot, value }) => [slot, value]))
  values.set(slotKey(6n), 0n)
  change(values)
  return values
}

function input(values: Map<Hex, bigint>, getters: Partial<ConfigInput["getters"]> = {}): ConfigInput {
  return {
    safe: SAFE,
    values,
    owners: walkList("owners", values),
    modules: walkList("modules", values),
    getters: { owners: [OWNER], threshold: 1n, nonce: 3n, modules: MODULES, ...getters },
  }
}

const codes = (values: Map<Hex, bigint>, getters?: Partial<ConfigInput["getters"]>) =>
  checkConfig(input(values, getters)).findings.map((f) => f.code)

describe("checkConfig", () => {
  it("accepts the fixture Safe", () => {
    const result = checkConfig(input(b1Values()))

    expect(result).toEqual({
      owners: [OWNER],
      modules: MODULES,
      ownerCount: 1n,
      threshold: 1n,
      nonce: 3n,
      slot6: "zero",
      findings: [],
    })
  })

  it("flags getters that differ from storage", () => {
    expect(codes(b1Values(), { owners: [] })).toEqual(["getter-mismatch"])
    expect(codes(b1Values(), { modules: [MODULES[0]] })).toEqual(["getter-mismatch"])
    expect(codes(b1Values(), { modules: [MODULES[1], MODULES[0]] })).toEqual(["getter-mismatch"])
    expect(codes(b1Values(), { threshold: 2n })).toEqual(["getter-mismatch"])
    expect(codes(b1Values(), { nonce: 4n })).toEqual(["getter-mismatch"])
  })

  it("skips getters that could not be called", () => {
    expect(codes(b1Values(), { owners: null, threshold: null, nonce: null, modules: null })).toEqual([])
  })

  it("flags an owner count that differs from the list", () => {
    expect(
      codes(
        b1Values((v) => v.set(slotKey(3n), 2n)),
        { owners: null },
      ),
    ).toEqual(["owner-count-mismatch"])
  })

  it("flags a threshold outside 1 to the owner count", () => {
    expect(
      codes(
        b1Values((v) => v.set(slotKey(4n), 0n)),
        { threshold: null },
      ),
    ).toEqual(["threshold-invalid"])
    expect(
      codes(
        b1Values((v) => v.set(slotKey(4n), 2n)),
        { threshold: null },
      ),
    ).toEqual(["threshold-invalid"])
  })

  it("flags a broken, looping or overlong list", () => {
    const broken = b1Values((v) => v.set(ownerSlot(OWNER), 0n))
    const loop = b1Values((v) => v.set(moduleSlot(MODULES[1]), BigInt(MODULES[0])))

    expect(codes(broken, { owners: null })).toEqual(["list-corrupt"])
    expect(codes(loop, { modules: null })).toEqual(["list-corrupt"])
    const tooLong = input(b1Values())
    tooLong.modules = walkList("modules", tooLong.values, { maxLength: 1 })
    expect(checkConfig({ ...tooLong, getters: { ...tooLong.getters, modules: null } }).findings[0].technical).toContain(
      "more than 1 entries",
    )
  })

  it("explains a legacy domain separator in slot 6 and flags anything else", () => {
    // Slot 6 of 0x584ab1ea...c37e at block 26176126, a 1.5.0 Safe created at 1.1.1 (eth_getStorageAt on Blast).
    const legacySafe = "0x584ab1eabb9b70d7a9b38a658a7f97646cc4c37e"
    const legacyValue = 0x82fb8cfeaad20fdde6896b5b8feea30168d234647817a74914a4e0e3beb8b0e3n

    expect(classifySlot6(legacyValue, legacySafe)).toBe("legacy")
    expect(classifySlot6(legacyValue, SAFE)).toBe("unexpected")
    expect(classifySlot6(0n, SAFE)).toBe("zero")
    expect(codes(b1Values((v) => v.set(slotKey(6n), BigInt(legacyDomainSeparator(SAFE)))))).toEqual([
      "legacy-domain-separator",
    ])
    expect(codes(b1Values((v) => v.set(slotKey(6n), 1n)))).toEqual(["slot6-unexpected"])
  })
})

describe("nextModulesStart", () => {
  const [A, B, C] = [
    "0x000000000000000000000000000000000000000A",
    "0x000000000000000000000000000000000000000b",
    "0x000000000000000000000000000000000000000C",
  ] as const

  it("continues after the last module returned, whatever `next` is", () => {
    // 1.3.0 returns the first module not on the page as `next`; 1.4.1 and later return the last one on the page.
    expect(nextModulesStart([A, B], C)).toBe(B)
    expect(nextModulesStart([A, B], B)).toBe(B)
  })

  it("stops on the sentinel or an empty page", () => {
    expect(nextModulesStart([A], SENTINEL)).toBeNull()
    expect(nextModulesStart([], toHex(0n, { size: 20 }))).toBeNull()
  })
})
