// Where the check stops, in plain words. No imports, so the start page can list these without loading the checks.

// The one wording of this caveat, for "what this does not check" and the pending section alike.
export const SIGNATURE_CAVEAT =
  "Signatures kept offchain. Signatures that were never shared with the Safe Transaction Service or any other service cannot be seen."

// "What this does not check", the fixed part. Steps add run-specific lines.
export const NOT_CHECKED: readonly string[] = [
  "What the code does. The Safe's logic, modules, guard and fallback handler are named by their code hash, not audited.",
  "Owner keys. How owners keep their keys, and whether one is compromised.",
  SIGNATURE_CAVEAT,
  "Storage of other contracts. A module's or guard's own settings sit in its own storage, outside this Safe's storage root.",
  "Owners of owners. An owner that is a Safe is shown one level deep; its own setup is not checked.",
  "Token balances and approvals.",
]
