import { type Address, encodeAbiParameters, getAddress, type Hex, keccak256, toHex } from "viem"
import { SHARED_SIGNER_MAPPING_SLOT, SLOTS } from "@/core/constants"

// 32-byte storage key of a plain slot, the form `eth_getProof` and the trie take.
export function slotKey(slot: bigint): Hex {
  return toHex(slot, { size: 32 })
}

// Entry of a Solidity mapping declared at `slot`: `keccak256(abi.encode(key, slot))`. A `uint256` slot number encodes
// the same as its 32-byte key, so a nested mapping passes the outer entry's key as `slot`.
function addressMappingSlot(key: Address, slot: Hex): Hex {
  return keccak256(encodeAbiParameters([{ type: "address" }, { type: "bytes32" }], [key, slot]))
}

function bytes32MappingSlot(key: Hex, slot: Hex): Hex {
  return keccak256(encodeAbiParameters([{ type: "bytes32" }, { type: "bytes32" }], [key, slot]))
}

export function ownerSlot(owner: Address): Hex {
  return addressMappingSlot(owner, slotKey(SLOTS.owners))
}

export function moduleSlot(module: Address): Hex {
  return addressMappingSlot(module, slotKey(SLOTS.modules))
}

export function signedMessageSlot(messageHash: Hex): Hex {
  return bytes32MappingSlot(messageHash, slotKey(SLOTS.signedMessages))
}

// `approvedHashes[owner][hash]`.
export function approvedHashSlot(owner: Address, hash: Hex): Hex {
  return bytes32MappingSlot(hash, addressMappingSlot(owner, slotKey(SLOTS.approvedHashes)))
}

// First of the three words (x, y, verifiers) the shared passkey signer at `signer` writes into a Safe it is an owner of.
export function sharedSignerSlot(signer: Address): Hex {
  return addressMappingSlot(signer, SHARED_SIGNER_MAPPING_SLOT)
}

// The address in the low 160 bits of a storage word (the Safe reads its address slots this way).
export function wordAddress(value: bigint): Address {
  return getAddress(toHex(value & ((1n << 160n) - 1n), { size: 20 }))
}
