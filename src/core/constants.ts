import type { Address, Hex } from "viem"

// Storage layout shared by Safe 1.3.0, 1.4.1 and 1.5.0, as slot numbers (`slotKey` gives the 32-byte key).
export const SLOTS = {
  singleton: 0n,
  modules: 1n,
  owners: 2n,
  ownerCount: 3n,
  threshold: 4n,
  nonce: 5n,
  // 0 on a Safe created at 1.3.0 or later; a Safe upgraded from 1.0.0 to 1.2.0 keeps its old domain separator.
  deprecatedDomainSeparator: 6n,
  signedMessages: 7n,
  // Nested: owner, then hash.
  approvedHashes: 8n,
} as const

// keccak256("guard_manager.guard.address")
export const GUARD_SLOT: Hex = "0x4a204f620c8c5ccdca3fd54d003badd85ba500436a431f0cbda4f558c93c34c8"
// keccak256("fallback_manager.handler.address")
export const FALLBACK_HANDLER_SLOT: Hex = "0x6c9a6c4a39284e37ed1cf53d337577d14212a4870fb976a4366c693b939918d5"
// keccak256("module_manager.module_guard.address"), 1.5.0 only.
export const MODULE_GUARD_SLOT: Hex = "0xb104e0b93118902c651344349b610029d694cfdec91c589c91ebafbcd0289947"

// Head and tail of both the owners and the modules linked list.
export const SENTINEL: Address = "0x0000000000000000000000000000000000000001"

// keccak256("EIP712Domain(address verifyingContract)"): Safe 1.0.0 to 1.2.0 stored
// `keccak256(abi.encode(typehash, safe))` in slot 6, and upgraded Safes keep it.
export const LEGACY_DOMAIN_SEPARATOR_TYPEHASH: Hex =
  "0x035aff83d86937d35b32e04f0ddc6ff469290eef2f1b692d8a815c89404d4749"

// keccak256("SafeWebAuthnSharedSigner.signer") - 1. The shared passkey signer keeps its data in the Safe's storage at
// `keccak256(abi.encode(signer, slot))` and the two words after it.
export const SHARED_SIGNER_MAPPING_SLOT: Hex = "0x2e0aed53485dc2290ceb5ce14725558ad3e3a09d38c69042410ad15c2b4ea4e8"

// keccak256 of empty code: the code hash of an account without code.
export const EMPTY_CODE_HASH: Hex = "0xc5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470"

// topic0 per event. Indexing differs between versions, the topic does not.
export const EVENT_TOPICS = {
  SafeSetup: "0x141df868a6331af528e38c83b7aa03edc19be66e37ae67f9285bf4f8e3c6a1a8",
  AddedOwner: "0x9465fa0c962cc76958e6373a993326400c1c94f8be2fe3a952adfa7f60b2ea26",
  RemovedOwner: "0xf8d49fc529812e9a7c5c50e69c20f0dccc0db8fa95c98bc58cc9a4f1c1299eaf",
  ChangedThreshold: "0x610f7ff2b304ae8903c3de74c60c6ab1f7d6226b3f52c5161905bb5ad4039c93",
  EnabledModule: "0xecdf3a3effea5783a3c4c2140e677577666428d44ed9d474a0b3a4c9943f8440",
  DisabledModule: "0xaab4fa2b463f581b2b32cb3b7e3b704b9ce37cc209b5fb4d77e593ace4054276",
  ChangedGuard: "0x1151116914515bc0891ff9047a6cb32cf902546f83066499bcf8ba33d2353fa2",
  ChangedModuleGuard: "0xcd1966d6be16bc0c030cc741a06c6e0efaf8d00de2c8b6a9e11827e125de8bb8",
  ChangedFallbackHandler: "0x5ac6c46c93c8d0e53714ba3b53db3e7c046da994313d7ed0d192028bc7c228b0",
  ChangedMasterCopy: "0x75e41bc35ff1bf14d81d1d2f649c0084a0f974f9289c803ec9898eeec4c8d0b8",
  ApproveHash: "0xf2a0eb156472d1440255b0d7c1e19cc07115d1051fe605b0dce69acfec884d9c",
  SignMsg: "0xe7f4675038f4f6034dfcbbb24c4dc08e4ebf10eb9d257d3d02c0f38d122ac6e4",
  ExecutionSuccess: "0x442e715f626346e8c54381002da614f62bee8d27386535b2521ec8540898556e",
  ExecutionFromModuleSuccess: "0x6895c13664aa4f67288b25d7a21d7aaa34916e355fb9b6fae0a139a9085becb8",
  ProxyCreation: "0x4f51faf6c4561ff95f067657e43439f0f856d97c04d9ec9070a6199ad418e235",
  ProxyCreationL2: "0x6e78ae8c51534f0b801d7aa7cce5a2113f3c3368c61b06fa61415f361d400431",
  // Not in docs/SPEC.md appendix A.
  ExecutionFailure: "0x23428b18acfb3ea64b08dc0c1d296ea9c09702c09083ca5272e64d115b687d23",
  ExecutionFromModuleFailure: "0xacd2c8702804128fdb0db2bb49f6d127dd0181c13fd45dbfe16de0930e2bd375",
  ChainSpecificProxyCreationL2: "0x7a1c96f74273709828c0e67ab96189772005d3b4948bc6902693eb21e4e2cc6a",
  SafeWebAuthnSharedSignerConfigured: "0xc0837d132123aef2fbdb575477d981ca21e6f5b42a4f1c08edf5ba0bc96edcc2",
} as const satisfies Record<string, Hex>
