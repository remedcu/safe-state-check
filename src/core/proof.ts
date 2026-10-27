import { verifyMerkleProof } from "@ethereumjs/mpt"
import {
  type Address,
  bytesToHex,
  fromRlp,
  type GetProofReturnType,
  type Hex,
  hexToBigInt,
  hexToBytes,
  isAddress,
  isAddressEqual,
  isHex,
  pad,
  size,
} from "viem"

export type ProvenAccount = { nonce: bigint; balance: bigint; storageHash: Hex; codeHash: Hex }

export type StorageProof = GetProofReturnType["storageProof"][number]

export class ProofError extends Error {
  override name = "ProofError"
}

// keccak256(rlp("")) = keccak256(0x80): the root of a trie with no entries. An account with empty storage has this
// storageHash, and every slot of it is proven zero.
export const EMPTY_TRIE_ROOT: Hex = "0x56e81f171bcc55a6ff8345e692c0f86e5b48e01b996cadc001622fb5e363b421"

// Value at `key` in the secure trie with root `root`, or null if the proof shows the key is absent. Throws if the
// proof does not lead from `root` to an answer for `key`.
async function provenValue(root: Hex, key: Hex, proof: readonly Hex[], what: string): Promise<Hex | null> {
  // The empty trie holds no key, so every key is proven absent. Clients send this as an empty proof or as the one
  // node 0x80 (rlp of ""); @ethereumjs/mpt rejects both against the empty root. Any other proof claims the empty root
  // has contents, which is a lie.
  if (root.toLowerCase() === EMPTY_TRIE_ROOT) {
    const nodes = proof.map((node) => node.toLowerCase())
    if (nodes.length === 0 || (nodes.length === 1 && nodes[0] === "0x80")) return null
    throw new ProofError(`The ${what} proof claims the empty storage root ${root} has contents`)
  }
  try {
    const nodes = proof.map((node) => hexToBytes(node))
    const value = await verifyMerkleProof(hexToBytes(key), nodes, { root: hexToBytes(root), useKeyHashing: true })
    return value === null ? null : bytesToHex(value)
  } catch {
    throw new ProofError(`The ${what} proof does not match the root ${root}`)
  }
}

// RLP integers drop leading zeros, so zero is the empty string.
function rlpQuantity(value: Hex): bigint {
  return value === "0x" ? 0n : hexToBigInt(value)
}

function compareClaim(what: string, claimed: unknown, proven: unknown) {
  if (claimed !== proven) {
    throw new ProofError(`The RPC's ${what} (${claimed}) differs from the proven ${what} (${proven})`)
  }
}

// Checks `proof` (as returned by viem's `getProof`) for `address` against a block's `stateRoot` and returns the proven
// account, or null if the proof shows there is no account. For an existing account the RPC's own fields must agree
// with the proof; for a missing one RPCs disagree on what to put there (zero or empty hashes), so they are ignored.
export async function verifyAccountProof(
  stateRoot: Hex,
  address: Address,
  proof: GetProofReturnType,
): Promise<ProvenAccount | null> {
  if (!isAddress(proof.address, { strict: false }) || !isAddressEqual(proof.address, address)) {
    throw new ProofError(`The RPC returned a proof for ${proof.address} instead of ${address}`)
  }
  const leaf = await provenValue(stateRoot, address, proof.accountProof, "account")
  if (leaf === null) return null

  const fields = fromRlp(leaf, "hex")
  if (!Array.isArray(fields) || fields.length !== 4 || !fields.every((field) => typeof field === "string")) {
    throw new ProofError(`The account leaf for ${address} is not [nonce, balance, storageHash, codeHash]`)
  }
  const [nonce, balance, storageHash, codeHash] = fields as Hex[]
  const account = { nonce: rlpQuantity(nonce), balance: rlpQuantity(balance), storageHash, codeHash }

  compareClaim("nonce", BigInt(proof.nonce), account.nonce)
  compareClaim("balance", proof.balance, account.balance)
  compareClaim("storage root", proof.storageHash.toLowerCase(), account.storageHash)
  compareClaim("code hash", proof.codeHash.toLowerCase(), account.codeHash)
  return account
}

// Checks one entry of `getProof`'s `storageProof` for `slot` against the account's proven `storageHash` and returns the
// proven value (0 for an absent slot).
export async function verifyStorageProof(storageHash: Hex, slot: Hex, proof: StorageProof): Promise<bigint> {
  if (!isHex(proof.key) || proof.key === "0x" || hexToBigInt(proof.key) !== hexToBigInt(slot)) {
    throw new ProofError(`The RPC returned a proof for slot ${proof.key} instead of ${slot}`)
  }
  const leaf = await provenValue(storageHash, pad(slot, { size: 32 }), proof.proof, `storage slot ${slot}`)

  let value = 0n
  if (leaf !== null) {
    const word = fromRlp(leaf, "hex")
    if (typeof word !== "string" || size(word) > 32) throw new ProofError(`The value of slot ${slot} is not one word`)
    value = rlpQuantity(word)
  }
  compareClaim(`value of slot ${slot}`, proof.value, value)
  return value
}
