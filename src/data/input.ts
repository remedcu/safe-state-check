// parseInput: the one input field. Accepts a bare address, EIP-3770 `shortName:0x...` (with Safe{Wallet}'s own
// prefixes), a Safe{Wallet} URL with `safe=`, and the permalink `/#/<chainId>/<address>[@<block>]` alone or as a URL
// (docs/ARCHITECTURE.md section 8).
import { type Address, checksumAddress, getAddress } from "viem"
import { chainByPrefix, getChain } from "@/data/chains"
import type { InputErrorKind, InputResult, ParsedInput } from "@/data/types"

const ADDRESS = /^0x[0-9a-fA-F]{40}$/

function fail(error: InputErrorKind, message: string): InputResult {
  return { ok: false, error, message }
}

function ok(input: ParsedInput): InputResult {
  return { ok: true, input }
}

// Mixed case must pass EIP-55; all lower or all upper case carries no checksum and is accepted.
function parseAddress(text: string): Address | InputResult {
  if (!ADDRESS.test(text)) {
    return fail("not-an-address", "This is not an address. A Safe address is 0x followed by 40 hex characters.")
  }
  const body = text.slice(2)
  if (body !== body.toLowerCase() && body !== body.toUpperCase() && checksumAddress(text as Address) !== text) {
    return fail(
      "bad-checksum",
      "The capital letters do not match the address checksum; check for a typo, or paste the address in lower case.",
    )
  }
  return getAddress(text.toLowerCase())
}

function parseEip3770(text: string, form: ParsedInput["form"]): InputResult {
  const colon = text.indexOf(":")
  const prefix = text.slice(0, colon)
  const address = parseAddress(text.slice(colon + 1))
  if (typeof address !== "string") return address
  const chain = chainByPrefix(prefix)
  if (!chain) {
    return fail(
      "unknown-prefix",
      `"${prefix}" is not the short name of a chain Safe supports. Pick the chain from the list.`,
    )
  }
  return ok({ address, chainId: chain.chainId, block: null, form })
}

// "#/<chainId>/<address>[@<block>]", with or without the leading "#".
function parsePermalink(hash: string): InputResult | null {
  const match = /^#?\/(\d+)\/(0x[0-9a-fA-F]{40})(?:@(.*))?\/?$/.exec(hash)
  if (!match) return null
  const chainId = Number(match[1])
  if (!getChain(chainId)) return fail("unknown-chain", `Chain ${chainId} is not one of the chains Safe deploys on.`)
  const address = parseAddress(match[2])
  if (typeof address !== "string") return address
  const blockText = match[3]
  if (blockText !== undefined && !/^\d+$/.test(blockText)) {
    return fail("bad-block", `"${blockText}" is not a block number. Use digits only, or leave the block out.`)
  }
  return ok({ address, chainId, block: blockText === undefined ? null : BigInt(blockText), form: "permalink" })
}

export function parseInput(text: string): InputResult {
  const value = text.trim()
  if (!value) return fail("empty", "Enter a Safe address.")
  if (ADDRESS.test(value) || /^0x/i.test(value)) {
    const address = parseAddress(value)
    return typeof address === "string" ? ok({ address, chainId: null, block: null, form: "address" }) : address
  }
  if (value.startsWith("#") || value.startsWith("/#")) {
    return parsePermalink(value.replace(/^\//, "")) ?? fail("not-an-address", "This link does not hold a Safe address.")
  }
  if (/^https?:\/\//i.test(value)) {
    let url: URL
    try {
      url = new URL(value)
    } catch {
      return fail("unsupported-url", "This URL could not be read. Paste the Safe address instead.")
    }
    const permalink = url.hash ? parsePermalink(url.hash) : null
    if (permalink) return permalink
    const safe = url.searchParams.get("safe")
    if (safe) return /^[^:]+:/.test(safe) ? parseEip3770(safe, "safe-url") : parseInput(safe)
    return fail(
      "unsupported-url",
      "This URL has no Safe address in it. Paste the Safe address, or a Safe{Wallet} link.",
    )
  }
  if (/^[a-z0-9_-]+:/i.test(value)) return parseEip3770(value, "eip3770")
  return fail("not-an-address", "This is not an address. A Safe address is 0x followed by 40 hex characters.")
}

// The permalink of a run, written to location.hash by the UI.
export function permalink(chainId: number, address: Address, block: bigint | null = null): string {
  return `#/${chainId}/${getAddress(address)}${block === null ? "" : `@${block}`}`
}
