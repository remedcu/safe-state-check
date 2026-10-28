import type { Address } from "viem"
import { issueHeadline } from "@/core/markdown"
import type { ChainRef, ReportIssue, Severity, StepStatus, Tone } from "@/core/report"
import { SOURCIFY_API } from "@/data/constants"

export const TONE_CLASSES: Record<Tone, string> = {
  ok: "bg-ok-surface text-ok",
  warn: "bg-warn-surface text-warn",
  bad: "bg-bad-surface text-bad",
  neutral: "bg-subtle text-muted-foreground",
  unknown: "border border-dashed border-border text-muted-foreground",
}

export const SEVERITY_TONE: Record<Severity, Tone> = { critical: "bad", high: "bad", medium: "warn", info: "neutral" }

export const STEP_STATUS_LABEL: Record<StepStatus, string> = {
  pending: "waiting",
  running: "running",
  done: "done",
  degraded: "done with gaps",
  skipped: "skipped",
  failed: "failed",
}

export function shorten(value: string): string {
  return value.length > 14 ? `${value.slice(0, 6)}…${value.slice(-4)}` : value
}

// `explorerAddressUrl` is a template with `{address}`. Only https: a plain http link would send the address in clear
// and open a page anyone on the path can swap.
export function explorerUrl(chain: ChainRef, address: Address): string | null {
  const template = chain.explorerAddressUrl
  return template?.startsWith("https://") ? template.replace("{address}", address) : null
}

export function sourcifyUrl(chainId: number, address: Address): string {
  return `${SOURCIFY_API}/${chainId}/${address}`
}

export function duration(seconds: string): string {
  const s = Number(seconds)
  if (!Number.isFinite(s)) return `${seconds} s`
  if (s >= 86400 && s % 86400 === 0) return `${s / 86400} days (${seconds} s)`
  if (s >= 3600 && s % 3600 === 0) return `${s / 3600} hours (${seconds} s)`
  return `${seconds} s`
}

// A 32-byte word without its leading zeros, for reading; the full word stays in the report and the title.
export function compactWord(word: string): string {
  const digits = word.replace(/^0x/, "").replace(/^0+/, "")
  return `0x${digits === "" ? "0" : digits}`
}

// An error in words: an I/O failure carries its issue, which names the service, host and call.
export function failureText(error: unknown): string {
  const issue = (error as { issue?: ReportIssue } | null)?.issue
  if (issue) return `${issueHeadline(issue)}. ${issue.explanation}`
  return `It failed: ${error instanceof Error ? error.message : String(error)}`
}
