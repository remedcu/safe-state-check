import { describe, expect, it } from "vitest"
import { parseInput, permalink } from "@/data/input"

const SAFE = "0xAd219b3c26fe42BF5FC66F67490745a4fa5dff59"
const LOWER = SAFE.toLowerCase()
const UPPER = `0x${SAFE.slice(2).toUpperCase()}`
// One letter's case flipped.
const BAD_CHECKSUM = "0xad219b3c26fe42BF5FC66F67490745a4fa5dff59"

describe("parseInput", () => {
  it.each([
    ["bare checksummed", SAFE, { chainId: null, block: null, form: "address" }],
    ["bare lower case", LOWER, { chainId: null, form: "address" }],
    ["bare upper case", UPPER, { chainId: null, form: "address" }],
    ["padded with spaces", `  ${SAFE}\n`, { form: "address" }],
    ["EIP-3770", `eth:${SAFE}`, { chainId: 1, form: "eip3770" }],
    ["EIP-3770 short name of Gnosis", `gno:${SAFE}`, { chainId: 100, form: "eip3770" }],
    ["Safe{Wallet} alias matic", `matic:${SAFE}`, { chainId: 137, form: "eip3770" }],
    ["EIP-3770 name pol", `pol:${SAFE}`, { chainId: 137, form: "eip3770" }],
    ["prefix in capitals", `ETH:${SAFE}`, { chainId: 1 }],
    ["Safe{Wallet} URL", `https://app.safe.global/home?safe=eth:${SAFE}`, { chainId: 1, form: "safe-url" }],
    ["Safe{Wallet} URL, other path", `https://app.safe.global/transactions/queue?safe=base:${SAFE}`, { chainId: 8453 }],
    ["permalink", `#/100/${SAFE}`, { chainId: 100, block: null, form: "permalink" }],
    ["permalink with block", `/#/1/${SAFE}@26176126`, { chainId: 1, block: 26176126n, form: "permalink" }],
    ["permalink URL", `https://safe.example/#/1/${SAFE}@26176126`, { chainId: 1, block: 26176126n }],
  ])("accepts %s", (_, text, expected) => {
    const result = parseInput(text)

    expect(result.ok).toBe(true)
    if (result.ok) expect(result.input).toMatchObject({ address: SAFE, ...expected })
  })

  it.each([
    ["empty", "  ", "empty"],
    ["bad checksum", BAD_CHECKSUM, "bad-checksum"],
    ["short address", "0x1234", "not-an-address"],
    ["garbage", "hello safe", "not-an-address"],
    ["unknown prefix", `nope:${SAFE}`, "unknown-prefix"],
    ["unknown chain in a permalink", `#/999999999999/${SAFE}`, "unknown-chain"],
    ["bad block", `#/1/${SAFE}@latest`, "bad-block"],
    ["URL without a Safe", "https://app.safe.global/welcome", "unsupported-url"],
    ["bad checksum inside EIP-3770", `eth:${BAD_CHECKSUM}`, "bad-checksum"],
  ])("rejects %s", (_, text, error) => {
    const result = parseInput(text)

    expect(result).toMatchObject({ ok: false, error })
    if (!result.ok) expect(result.message).toMatch(/\.$/)
  })

  it("explains a checksum failure in plain words", () => {
    const result = parseInput(BAD_CHECKSUM)

    expect(!result.ok && result.message).toContain("capital letters do not match")
  })

  it("round-trips its own permalink", () => {
    const link = permalink(1, LOWER as `0x${string}`, 26176126n)

    expect(link).toBe(`#/1/${SAFE}@26176126`)
    expect(parseInput(link)).toMatchObject({ ok: true, input: { address: SAFE, chainId: 1, block: 26176126n } })
  })
})
