import type { Address, Hex } from "viem"
import type { Evidence, Finding, FindingCode, SectionId, Severity, UnverifiedReason } from "@/core/report"

export type CatalogueEntry = { severity: Severity; title: string; explanation: string }

// Severity is a fixed function of the code (docs/ARCHITECTURE.md section 11). Titles are plain words; the technical
// detail goes in each finding's `technical`.
export const FINDINGS: Record<FindingCode, CatalogueEntry> = {
  "shadow-owner": {
    severity: "critical",
    title: "Hidden owner entry",
    explanation:
      "Storage holds an owner entry outside the owner list. getOwners does not show it, but the Safe accepts its signatures.",
  },
  "shadow-module": {
    severity: "critical",
    title: "Hidden module entry",
    explanation:
      "Storage holds a module entry outside the module list. The module getters do not show it, but the Safe lets it run transactions without any owner signature.",
  },
  "eoa-module": {
    severity: "critical",
    title: "Module is a plain account",
    explanation:
      "A module can run any transaction from the Safe without owner signatures. This module has no contract code (or is an EIP-7702 delegated account), so whoever holds its key controls the Safe.",
  },
  "module-public-forwarder": {
    severity: "critical",
    title: "Module anyone can call through",
    explanation:
      "This module is a public call forwarder (MultiSendCallOnly): anyone can ask it to make a call, and it will make that call from the Safe's module privilege. So any account can run transactions from the Safe without owner signatures.",
  },
  "approval-without-event": {
    severity: "critical",
    title: "Pre-approval nobody announced",
    explanation:
      "Storage holds an approval of a transaction for an owner, but no ApproveHash event from that owner announces it. Safe's approveHash always emits that event, so something wrote the approval directly. It counts as that owner's signature, so the transaction can run without the owner signing it.",
  },
  "signed-message-without-event": {
    severity: "critical",
    title: "Signed message nobody announced",
    explanation:
      "Storage marks a message as signed by the Safe, but no SignMsg event announces it. Contracts that check the Safe's signature (EIP-1271) accept that message, though no owner signed it.",
  },
  "singleton-not-canonical": {
    severity: "critical",
    title: "Unknown Safe logic contract",
    explanation:
      "The Safe runs logic (the singleton in slot 0) whose code is not a Safe release from safe-deployments. That code can do anything with the Safe's funds and storage.",
  },
  "proxy-not-canonical": {
    severity: "critical",
    title: "Unknown proxy code",
    explanation:
      "The code at the Safe's address is not a known SafeProxy. It may not forward calls to the singleton the way a Safe proxy does, so the rest of this check cannot be relied on.",
  },
  "unexplained-storage": {
    severity: "high",
    title: "Storage the configuration does not explain",
    explanation:
      "The Safe's storage holds at least one slot that its owners, modules and settings do not account for. It can be benign (an approved hash, a signed message) or a hidden owner or module.",
  },
  "unknown-module": {
    severity: "high",
    title: "Unknown module",
    explanation:
      "This module's code matches no known module deployment. A module can run any transaction from the Safe without owner signatures, so its code needs a review.",
  },
  "unknown-fallback-handler": {
    severity: "high",
    title: "Unknown fallback handler",
    explanation:
      "The fallback handler's code matches no known deployment. The handler answers calls the Safe does not know, including isValidSignature, so a malicious one can make the Safe appear to sign anything offchain.",
  },
  "setup-delegatecall-unknown": {
    severity: "high",
    title: "Setup ran unknown code",
    explanation:
      "The setup call delegatecalled a contract that is not a known setup helper. Code run by delegatecall during setup can write any storage slot of the Safe.",
  },
  "config-without-event": {
    severity: "high",
    title: "Setting changed without its event",
    explanation:
      "A module, guard, fallback handler or owner is set now, but no event in the Safe's history announced it. From Safe 1.3.0 on, the functions that change these settings always emit one, so something wrote this slot directly.",
  },
  "module-owner-not-safe": {
    severity: "high",
    title: "Module controlled by another account",
    explanation:
      "This Zodiac module's owner is not the Safe. The owner can change how the module behaves (oracle, delays, permissions) without the Safe's owners.",
  },
  "list-corrupt": {
    severity: "high",
    title: "Broken owner or module list",
    explanation:
      "The linked list in storage is broken: a pointer is zero or not an address, the list loops, or it is too long. The Safe's getters can then show a different set than the Safe honours.",
  },
  "getter-mismatch": {
    severity: "high",
    title: "Getter differs from storage",
    explanation:
      "A value returned by one of the Safe's own functions differs from what its storage holds. The storage is what the Safe acts on.",
  },
  "owner-count-mismatch": {
    severity: "high",
    title: "Owner count does not match the list",
    explanation:
      "The stored owner count differs from the number of owners in the list. Safe functions keep them equal, so a difference points at a direct storage write.",
  },
  "threshold-invalid": {
    severity: "high",
    title: "Threshold out of range",
    explanation:
      "The threshold must be at least 1 and at most the number of owners. Outside that range the Safe cannot work as intended.",
  },
  "slot6-unexpected": {
    severity: "high",
    title: "Unexpected value in an unused slot",
    explanation:
      "Slot 6 is unused from Safe 1.3.0 on. It holds a value that is not the domain separator an older Safe version leaves there.",
  },
  "codehash-mismatch": {
    severity: "high",
    title: "Known address with different code",
    explanation:
      "The address belongs to a known deployment, but the code there is different. On this chain the address does not hold the contract it is named after.",
  },
  "unknown-guard": {
    severity: "medium",
    title: "Unknown guard",
    explanation:
      "The transaction guard's code matches no known guard. A guard checks every Safe transaction and can block them, including the one that would remove it.",
  },
  "unknown-module-guard": {
    severity: "medium",
    title: "Unknown module guard",
    explanation:
      "The module guard's code matches no known deployment. It checks every module transaction and can block them.",
  },
  "delegated-owner": {
    severity: "medium",
    title: "Owner is an EIP-7702 delegated account",
    explanation:
      "This owner is a plain account that delegated its code to a contract (EIP-7702). The owner's security now also depends on that contract.",
  },
  "contract-owner": {
    severity: "medium",
    title: "Owner is a contract",
    explanation:
      "This owner is a contract, not a key. The contract's own logic decides whether it signs, and this tool did not inspect it.",
  },
  "pending-approved-hash": {
    severity: "medium",
    title: "Pre-approved transaction",
    explanation:
      "An owner approved a transaction hash onchain and that transaction has not run yet. The approval counts as the owner's signature when it runs.",
  },
  "queued-transaction": {
    severity: "medium",
    title: "Queued transaction",
    explanation:
      "The Safe Transaction Service holds a transaction for the current or a later nonce. It can run once it has enough signatures.",
  },
  "factory-not-canonical": {
    severity: "medium",
    title: "Created by an unknown factory",
    explanation:
      "The Safe was not created by a known Safe proxy factory, so its setup cannot be read and checked the usual way.",
  },
  "creation-callback-unknown": {
    severity: "medium",
    title: "Unknown creation callback",
    explanation:
      "The Safe was created with createProxyWithCallback, and the callback contract is not a known deployment. It ran right after the Safe was created.",
  },
  "config-without-event-unconfirmed": {
    severity: "medium",
    title: "No event found for this setting in the indexer's history",
    explanation:
      "A module, guard, fallback handler or owner is set now, and the indexer's copy of the Safe's history has no event that set it. Indexers can miss events and the RPC's own logs were not read over the full range, so this is not proven.",
  },
  "faulty-version": {
    severity: "medium",
    title: "Module version with a known bug",
    explanation: "Zodiac marks this module version as faulty. Replace it with the fixed version.",
  },
  "setup-payment": {
    severity: "info",
    title: "Payment at setup",
    explanation: "The setup call paid a fee from the Safe. Check that the receiver is the one you expect.",
  },
  "version-behind": {
    severity: "info",
    title: "Newer Safe version available",
    explanation: "A newer supported Safe version is deployed on this chain.",
  },
  "inert-owners": {
    severity: "info",
    title: "Only placeholder owners",
    explanation:
      "Every owner is a precompile address that cannot sign (for example 0x...02). Only the modules can act for this Safe.",
  },
  "legacy-domain-separator": {
    severity: "info",
    title: "Leftover from an older Safe version",
    explanation:
      "Slot 6 holds the domain separator that Safe 1.0.0 to 1.2.0 stored. The Safe was created at an old version and upgraded later; newer versions ignore this slot.",
  },
  "passkey-signer-slots": {
    severity: "info",
    title: "Passkey signer data",
    explanation:
      "An owner is the shared passkey signer (SafeWebAuthnSharedSigner). It keeps the passkey's public key in three slots of the Safe's own storage, which count as expected.",
  },
  "signed-message": {
    severity: "info",
    title: "Message signed onchain",
    explanation:
      "The Safe marked a message as signed (SignMessageLib). Contracts that check the Safe's signature (EIP-1271) accept that message.",
  },
  "handler-keeps-own-state": {
    severity: "info",
    title: "Fallback handler keeps its own settings",
    explanation:
      "The ExtensibleFallbackHandler keeps settings for this Safe in its own storage, outside the Safe's storage root. Those settings can make the Safe accept signatures for some domains.",
  },
  "history-incomplete": {
    severity: "info",
    title: "Event history incomplete",
    explanation:
      "Not every event since the Safe was created could be read, so a setting changed without its event cannot be ruled out.",
  },
  "same-address-other-chains": {
    severity: "info",
    title: "Same address on other chains",
    explanation: "This address also has code on other chains, where the owners may differ.",
  },
}

export const SEVERITIES: readonly Severity[] = ["critical", "high", "medium", "info"]

export function severityRank(severity: Severity): number {
  return SEVERITIES.indexOf(severity)
}

export function finding(
  code: FindingCode,
  section: SectionId,
  {
    subject = null,
    technical,
    evidence = [],
  }: { subject?: Address | Hex | null; technical: string; evidence?: Evidence[] },
): Finding {
  const { severity, title, explanation } = FINDINGS[code]
  return { code, severity, title, technical, explanation, subject, section, evidence }
}

// Most severe first; the sort is stable, so findings of one severity keep the order they were found in.
export function sortFindings(findings: readonly Finding[]): Finding[] {
  return [...findings].sort((a, b) => severityRank(a.severity) - severityRank(b.severity))
}

// Default text per reason; steps pass a more specific detail when they have one.
export const UNVERIFIED_REASONS: Record<UnverifiedReason, string> = {
  "root-check-unsupported":
    "This chain's storage proofs are not standard Ethereum proofs, so the storage root cannot be rebuilt.",
  "no-proof-rpc": "No RPC served storage proofs for this block, so the storage could not be proven.",
  "single-operator": "Only one RPC operator confirmed the block. Add a cross-check RPC run by someone else.",
  "rpc-disagreement": "The two RPCs returned different data for the same block.",
  "proof-invalid": "An RPC sent a proof that did not match the block's state root.",
  "version-unsupported": "This Safe version is not supported. The check covers Safe 1.3.0, 1.4.1 and 1.5.0.",
  "code-not-canonical": "The Safe's proxy or logic contract is not a known Safe release.",
  reorg: "The chain reorganised twice during the check, so the block could not be pinned.",
  "read-failed": "A read the verdict needs failed.",
  "inspection-incomplete":
    "A module, guard, fallback handler or owner could not be inspected, so the findings may be incomplete.",
  "unproven-read": "Some state was read without a proof on a chain whose proofs work, so it rests on one RPC's word.",
  "history-incomplete":
    "An approval or signed message explains a slot, but its event may lie outside the part of the history that was read.",
}
