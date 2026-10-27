// The hand-reviewed contract list. An entry counts only once a maintainer signed it off: `reviewedBy` names them and
// `reviewedOn` is the date (YYYY-MM-DD). Entries waiting for review keep both empty and are left out, so their
// contracts show as unknown until then.
import type { ReviewedContract } from "@/data/types"

export function isSignedOff(entry: Pick<ReviewedContract, "reviewedBy" | "reviewedOn">): boolean {
  return (
    entry.reviewedBy.trim() !== "" &&
    /^\d{4}-\d{2}-\d{2}$/.test(entry.reviewedOn) &&
    !Number.isNaN(Date.parse(entry.reviewedOn))
  )
}

export function signedOff(entries: readonly ReviewedContract[]): ReviewedContract[] {
  return entries.filter(isSignedOff)
}

// Loaded lazily with the registry.
export async function reviewedContracts(): Promise<ReviewedContract[]> {
  const { default: entries } = await import("@/data/reviewed-contracts.json")
  return signedOff(entries as ReviewedContract[])
}
