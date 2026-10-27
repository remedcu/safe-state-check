// The docs/SPEC.md 11.3 cases: how each Safe is built on anvil, and what the check must say about it.
import {
  type Address,
  encodeFunctionData,
  encodePacked,
  type Hex,
  keccak256,
  size,
  toFunctionSelector,
  toHex,
} from "viem"
import type { FindingCode, RootMatch, UnverifiedReason, VerdictKind } from "@/core/report"
import { moduleSlot, ownerSlot } from "@/core/slots"
import {
  ABI,
  account,
  type Chain,
  deployment,
  MODULE_SUCCESS,
  SCOPE_GUARD,
  SUCCESS,
  type Version,
  VERSIONS,
} from "./safes"

const owner = account(1)
// The attacker: a shadow owner or module, or a stranger.
const x = account(2)
const eoaModule = account(3)
const owner7702 = account(4)

const call = (functionName: "writeOwner" | "writeModule" | "writeGuard" | "enableModule" | "setupToL2", arg: Address) =>
  encodeFunctionData({ abi: ABI, functionName, args: [arg] })

export type Built = { safe: Address; proof?: Hex[] }
export type Case = {
  name: string
  chain: "l1" | "l2"
  versions: readonly Version[]
  build: (chain: Chain, v: Version) => Promise<Built>
  verdict: VerdictKind
  // Why an amber verdict is amber.
  unverified?: UnverifiedReason[]
  // Besides `version-behind`, which every Safe below 1.5.0 gets.
  codes: FindingCode[]
  matchedBy?: RootMatch
  ownNode?: false
  // The slot a shadow entry wrote, and the finding's subject.
  shadow?: { key: Hex; subject: Address }
  // The Safe event the case's own transaction must emit (what a shadow entry or a forwarder module can do).
  proof?: Hex
  // The configuration events the history must hold (log order differs by version).
  events?: string[]
}

export const CASES: Case[] = [
  {
    name: "clean",
    chain: "l1",
    versions: VERSIONS,
    build: async (c, v) => ({ safe: await c.createSafe(v, { owners: [owner.address] }) }),
    verdict: "explained",
    codes: [],
    matchedBy: "config",
  },
  {
    name: "shadow owner",
    chain: "l1",
    versions: VERSIONS,
    build: async (c, v) => {
      const safe = await c.createSafe(v, {
        owners: [owner.address],
        to: c.helpers!.ShadowWriter,
        data: call("writeOwner", x.address),
      })
      // x is not in getOwners, yet its signature alone executes a transaction.
      return { safe, proof: await c.exec(safe, x, { to: x.address, value: 1n }) }
    },
    verdict: "unexplained",
    codes: ["setup-delegatecall-unknown", "shadow-owner"],
    shadow: { key: ownerSlot(x.address), subject: x.address },
    proof: SUCCESS,
  },
  {
    name: "shadow module",
    chain: "l1",
    versions: VERSIONS,
    build: async (c, v) => {
      const safe = await c.createSafe(v, {
        owners: [owner.address],
        to: c.helpers!.ShadowWriter,
        data: call("writeModule", x.address),
      })
      const hash = await c.client.writeContract({
        account: x,
        address: safe,
        abi: ABI,
        functionName: "execTransactionFromModule",
        args: [x.address, 1n, "0x", 0],
      })
      return { safe, proof: await c.topics(safe, hash) }
    },
    verdict: "unexplained",
    codes: ["setup-delegatecall-unknown", "shadow-module"],
    shadow: { key: moduleSlot(x.address), subject: x.address },
    proof: MODULE_SUCCESS,
  },
  {
    name: "silent guard",
    chain: "l1",
    versions: VERSIONS,
    build: async (c, v) => ({
      safe: await c.createSafe(v, {
        owners: [owner.address],
        to: c.helpers!.ShadowWriter,
        data: call("writeGuard", SCOPE_GUARD),
      }),
    }),
    verdict: "explained",
    codes: ["config-without-event", "setup-delegatecall-unknown"],
    matchedBy: "config",
    events: ["SafeSetup"],
  },
  {
    name: "approved hash",
    chain: "l1",
    versions: VERSIONS,
    build: async (c, v) => {
      const safe = await c.createSafe(v, { owners: [owner.address] })
      const hash = keccak256(toHex(`next transaction of ${safe}`))
      await c.receipt(
        await c.client.writeContract({
          account: owner,
          address: safe,
          abi: ABI,
          functionName: "approveHash",
          args: [hash],
        }),
      )
      return { safe }
    },
    verdict: "explained",
    codes: ["pending-approved-hash"],
    matchedBy: "events",
  },
  {
    name: "signed message",
    chain: "l1",
    versions: VERSIONS,
    build: async (c, v) => {
      const safe = await c.createSafe(v, { owners: [owner.address] })
      const data = encodeFunctionData({ abi: ABI, functionName: "signMessage", args: [toHex("anvil suite")] })
      return { safe, proof: await c.exec(safe, owner, { to: deployment(v).signMessageLib, data, operation: 1 }) }
    },
    verdict: "explained",
    codes: ["signed-message"],
    proof: SUCCESS,
    matchedBy: "events",
  },
  {
    name: "EOA module",
    chain: "l1",
    versions: VERSIONS,
    build: async (c, v) => {
      const safe = await c.createSafe(v, { owners: [owner.address] })
      return { safe, proof: await c.exec(safe, owner, { to: safe, data: call("enableModule", eoaModule.address) }) }
    },
    verdict: "explained",
    codes: ["eoa-module"],
    proof: SUCCESS,
    matchedBy: "config",
  },
  {
    name: "unknown fallback handler",
    chain: "l1",
    versions: VERSIONS,
    build: async (c, v) => ({
      safe: await c.createSafe(v, { owners: [owner.address], fallbackHandler: c.helpers!.AnyHandler }),
    }),
    verdict: "explained",
    codes: ["unknown-fallback-handler"],
    matchedBy: "config",
  },
  {
    name: "7702 owner",
    chain: "l1",
    versions: VERSIONS,
    build: async (c, v) => {
      const authorization = await c.client.signAuthorization({
        account: owner7702,
        contractAddress: c.helpers!.Delegate,
      })
      await c.receipt(
        await c.client.sendTransaction({
          account: account(0),
          to: owner7702.address,
          data: toFunctionSelector("ping()"),
          authorizationList: [authorization],
        }),
      )
      return { safe: await c.createSafe(v, { owners: [owner7702.address] }) }
    },
    verdict: "explained",
    codes: ["delegated-owner"],
    matchedBy: "config",
  },
  {
    name: "non-canonical singleton",
    chain: "l1",
    versions: VERSIONS,
    build: async (c, v) => ({
      safe: await c.createSafe(v, { owners: [owner.address], singleton: await c.singletonCopy(v) }),
    }),
    verdict: "unverified",
    unverified: ["code-not-canonical"],
    codes: ["singleton-not-canonical"],
  },
  {
    name: "L2 setup on chain 8453",
    chain: "l2",
    versions: ["1.4.1", "1.5.0"],
    build: async (c, v) => {
      const { safeL2, toL2Setup } = deployment(v)
      return {
        safe: await c.createSafe(v, { owners: [owner.address], to: toL2Setup!, data: call("setupToL2", safeL2) }),
      }
    },
    verdict: "explained",
    codes: [],
    matchedBy: "config",
    events: ["SafeSetup", "ChangedMasterCopy"],
  },
  {
    // Anyone can make MultiSendCallOnly call execTransactionFromModule.
    name: "MultiSendCallOnly as module",
    chain: "l1",
    versions: VERSIONS,
    build: async (c, v) => {
      const safe = await c.createSafe(v, { owners: [owner.address] })
      const forwarder = deployment(v).multiSendCallOnly
      await c.exec(safe, owner, { to: safe, data: call("enableModule", forwarder) })
      const inner = encodeFunctionData({
        abi: ABI,
        functionName: "execTransactionFromModule",
        args: [x.address, 1n, "0x", 0],
      })
      const packed = encodePacked(
        ["uint8", "address", "uint256", "uint256", "bytes"],
        [0, safe, 0n, BigInt(size(inner)), inner],
      )
      const hash = await c.client.writeContract({
        account: x,
        address: forwarder,
        abi: ABI,
        functionName: "multiSend",
        args: [packed],
        gas: 500_000n,
      })
      return { safe, proof: await c.topics(safe, hash) }
    },
    verdict: "explained",
    codes: ["module-public-forwarder"],
    proof: MODULE_SUCCESS,
    matchedBy: "config",
  },
  {
    name: "single operator without own-node trust",
    chain: "l1",
    versions: VERSIONS,
    build: async (c, v) => ({ safe: await c.createSafe(v, { owners: [owner.address] }) }),
    verdict: "unverified",
    unverified: ["single-operator"],
    codes: [],
    ownNode: false,
  },
]
