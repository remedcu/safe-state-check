import { type Address, type Hex, toHex } from "viem"
import { finding } from "@/core/findings"
import {
  compareVersions,
  displayName,
  entriesOf,
  hasFlag,
  identify,
  knownAs,
  latestVersion,
  type Registry,
  SUPPORTED_VERSIONS,
} from "@/core/registry"
import type { Finding, IdentitySection } from "@/core/report"
import { wordAddress } from "@/core/slots"
import { cleanUntrusted, quoteUntrusted } from "@/core/text"
import { SUPPORTED_TEXT, type UnverifiedItem } from "@/core/verdict"

export type IdentityInput = {
  chainId: number
  safe: Address
  // Proven code hash of the Safe's account.
  proxyCodeHash: Hex
  // Slot 0, as proven.
  singletonSlot: bigint
  // Proven code hash of the singleton; null when it has no account.
  singletonCodeHash: Hex | null
  // VERSION() through the proxy; null when the call failed.
  versionCall: string | null
}

export type IdentityResult = { section: IdentitySection; findings: Finding[]; unverified: UnverifiedItem[] }

// Proxy: any known SafeProxy runtime (a Safe keeps the proxy of the factory that created it, whatever its singleton).
// Singleton: slot 0, identified by code hash; supported are Safe and SafeL2 at 1.3.0, 1.4.1 and 1.5.0.
export function checkIdentity(registry: Registry, input: IdentityInput): IdentityResult {
  const findings: Finding[] = []
  const unverified: UnverifiedItem[] = []

  const proxy = identify(registry, input.chainId, { address: input.safe, codeHash: input.proxyCodeHash })
  if (!knownAs(registry, proxy, ["proxy"])) {
    findings.push(
      finding("proxy-not-canonical", "identity", {
        subject: input.safe,
        technical: `Code hash ${input.proxyCodeHash} is not a known SafeProxy runtime`,
        evidence: [{ kind: "code", address: input.safe, codeHash: input.proxyCodeHash }],
      }),
    )
    unverified.push({
      reason: "code-not-canonical",
      detail: "The code at the Safe's address is not a known SafeProxy.",
    })
  }

  const singleton = wordAddress(input.singletonSlot)
  const identification =
    input.singletonCodeHash === null
      ? null
      : identify(registry, input.chainId, { address: singleton, codeHash: input.singletonCodeHash })
  const singletonEntry = entriesOf(registry, identification).find((entry) => entry.kind === "singleton")
  const version = singletonEntry?.ref.version ?? null
  const extraBits = input.singletonSlot >> 160n !== 0n

  if (singletonEntry === undefined || extraBits) {
    const why =
      input.singletonCodeHash === null
        ? `there is no contract at ${singleton}`
        : extraBits
          ? `slot 0 holds ${toHex(input.singletonSlot, { size: 32 })}, which has bits set above the address`
          : `its code hash ${input.singletonCodeHash} is not a Safe release`
    findings.push(
      finding("singleton-not-canonical", "identity", {
        subject: singleton,
        technical: `Singleton (slot 0) ${singleton}: ${why}`,
        evidence: [{ kind: "slot", key: toHex(0n, { size: 32 }), value: toHex(input.singletonSlot, { size: 32 }) }],
      }),
    )
    unverified.push({
      reason: "code-not-canonical",
      detail: `The Safe's logic contract ${singleton} is not a Safe release.`,
    })
  }

  const supported = version !== null && SUPPORTED_VERSIONS.includes(version) && !extraBits
  if (version !== null && !SUPPORTED_VERSIONS.includes(version)) {
    unverified.push({
      reason: "version-unsupported",
      detail: `This Safe runs version ${version}. ${SUPPORTED_TEXT}`,
    })
  }

  // VERSION() is an eth_call answer, not provable, and the proxy's code decides it: keep it short and plain.
  const versionCall = input.versionCall === null ? null : cleanUntrusted(input.versionCall)
  if (version !== null && input.versionCall !== null && input.versionCall !== version) {
    findings.push(
      finding("getter-mismatch", "identity", {
        subject: input.safe,
        technical: `VERSION() returned ${quoteUntrusted(input.versionCall)}, but the singleton's code is ${displayName(identification)}`,
        evidence: [{ kind: "call", to: input.safe, fn: "VERSION()", result: versionCall ?? "" }],
      }),
    )
  }

  const latest = latestVersion(registry, input.chainId)
  if (supported && latest !== null && compareVersions(version, latest) < 0) {
    findings.push(
      finding("version-behind", "identity", {
        subject: singleton,
        technical: `The Safe runs ${version}; ${latest} is deployed on chain ${input.chainId}`,
      }),
    )
  }

  return {
    section: {
      proxy: { codeHash: proxy.codeHash, identification: proxy },
      singleton: { address: singleton, codeHash: input.singletonCodeHash, identification },
      version,
      l2: singletonEntry === undefined ? null : hasFlag(registry, identification, "l2"),
      versionCall,
      supported,
      latestVersion: latest ?? version ?? "",
    },
    findings,
    unverified,
  }
}
