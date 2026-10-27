import { createMPT } from "@ethereumjs/mpt"
import { bytesToHex, type Hex, hexToBytes, maxUint256, numberToBytes, pad, toRlp } from "viem"

export type StorageEntry = { slot: Hex; value: bigint }

// Storage root of an account holding exactly `entries`: a secure trie keyed by `keccak256(slot)`, each value stored as
// the RLP of its big-endian bytes without leading zeros. A zero value is no entry at all, so zeros are skipped.
export async function storageRoot(entries: readonly StorageEntry[]): Promise<Hex> {
  const values = new Map<Hex, bigint>()
  for (const { slot, value } of entries) {
    if (value < 0n || value > maxUint256) throw new Error(`Storage value ${value} of slot ${slot} is not a uint256`)
    const key = pad(slot, { size: 32 }).toLowerCase() as Hex
    const known = values.get(key)
    if (known !== undefined && known !== value) throw new Error(`Slot ${key} is listed twice with different values`)
    values.set(key, value)
  }

  const trie = await createMPT({ useKeyHashing: true })
  for (const [key, value] of values) {
    if (value !== 0n) await trie.put(hexToBytes(key), toRlp(numberToBytes(value), "bytes"))
  }
  return bytesToHex(trie.root())
}
