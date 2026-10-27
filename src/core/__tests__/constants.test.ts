import { hexToBigInt, keccak256, stringToHex, toEventSelector } from "viem"
import { describe, expect, it } from "vitest"
import {
  EMPTY_CODE_HASH,
  EVENT_TOPICS,
  FALLBACK_HANDLER_SLOT,
  GUARD_SLOT,
  LEGACY_DOMAIN_SEPARATOR_TYPEHASH,
  MODULE_GUARD_SLOT,
  SHARED_SIGNER_MAPPING_SLOT,
  SLOTS,
} from "@/core/constants"

describe("SLOTS", () => {
  it("matches appendix A of docs/SPEC.md", () => {
    expect(SLOTS).toEqual({
      singleton: 0n,
      modules: 1n,
      owners: 2n,
      ownerCount: 3n,
      threshold: 4n,
      nonce: 5n,
      deprecatedDomainSeparator: 6n,
      signedMessages: 7n,
      approvedHashes: 8n,
    })
  })
})

describe("fixed slots", () => {
  it("are the hashes of their names", () => {
    expect(GUARD_SLOT).toBe(keccak256(stringToHex("guard_manager.guard.address")))
    expect(FALLBACK_HANDLER_SLOT).toBe(keccak256(stringToHex("fallback_manager.handler.address")))
    expect(MODULE_GUARD_SLOT).toBe(keccak256(stringToHex("module_manager.module_guard.address")))
  })
})

describe("other hashes", () => {
  it("are what their comments say", () => {
    expect(LEGACY_DOMAIN_SEPARATOR_TYPEHASH).toBe(keccak256(stringToHex("EIP712Domain(address verifyingContract)")))
    expect(hexToBigInt(SHARED_SIGNER_MAPPING_SLOT)).toBe(
      hexToBigInt(keccak256(stringToHex("SafeWebAuthnSharedSigner.signer"))) - 1n,
    )
    expect(EMPTY_CODE_HASH).toBe(keccak256("0x"))
  })
})

const SIGNATURES: Record<keyof typeof EVENT_TOPICS, string> = {
  SafeSetup: "SafeSetup(address,address[],uint256,address,address)",
  AddedOwner: "AddedOwner(address)",
  RemovedOwner: "RemovedOwner(address)",
  ChangedThreshold: "ChangedThreshold(uint256)",
  EnabledModule: "EnabledModule(address)",
  DisabledModule: "DisabledModule(address)",
  ChangedGuard: "ChangedGuard(address)",
  ChangedModuleGuard: "ChangedModuleGuard(address)",
  ChangedFallbackHandler: "ChangedFallbackHandler(address)",
  ChangedMasterCopy: "ChangedMasterCopy(address)",
  ApproveHash: "ApproveHash(bytes32,address)",
  SignMsg: "SignMsg(bytes32)",
  ExecutionSuccess: "ExecutionSuccess(bytes32,uint256)",
  ExecutionFromModuleSuccess: "ExecutionFromModuleSuccess(address)",
  ProxyCreation: "ProxyCreation(address,address)",
  ProxyCreationL2: "ProxyCreationL2(address,address,bytes,uint256)",
  ExecutionFailure: "ExecutionFailure(bytes32,uint256)",
  ExecutionFromModuleFailure: "ExecutionFromModuleFailure(address)",
  ChainSpecificProxyCreationL2: "ChainSpecificProxyCreationL2(address,address,bytes,uint256,uint256)",
  SafeWebAuthnSharedSignerConfigured: "SafeWebAuthnSharedSignerConfigured(bytes32,uint256,uint256,uint176)",
}

describe("EVENT_TOPICS", () => {
  it.each(Object.entries(SIGNATURES))("%s is the selector of %s", (name, signature) => {
    expect(EVENT_TOPICS[name as keyof typeof EVENT_TOPICS]).toBe(toEventSelector(signature))
  })
})
