// CLI: the same pipeline as the web app, for one Safe. Prints the Markdown summary to stdout, progress to stderr, and
// optionally writes the JSON report. Run with `npm run cli -- <safe> [options]`; `--help` lists the options.
import { writeFileSync } from "node:fs"
import { parseArgs } from "node:util"
import type { Address } from "viem"
import { issueHeadline, reportToMarkdown } from "@/core/markdown"
import type { CheckEvent, Report } from "@/core/report"
import { getChain } from "@/data/chains"
import { detectChains } from "@/data/detect"
import { parseInput } from "@/data/input"
import { open } from "@/data/session"
import { checkRpcUrl, defaultSettings } from "@/data/settings"
import type { CallLogEntry } from "@/data/transport"
import type { Settings } from "@/data/types"
import { defaultRegistry, exitCode, startWith } from "@/check/start"

const HELP = `Usage: npm run cli -- <safe> [options]

<safe> is a Safe address, eth:0x..., a Safe{Wallet} URL or a permalink (#/1/0x...@block).
Without a chain, the most used chains are asked whether the address is a Safe there.

Options:
  --chain <id>           Chain id, when <safe> does not name one (for example 1 or 100).
  --block <n>            Block to check; default: 3 blocks below the newest one.
  --rpc <url>            Your primary RPC.
  --cross-rpc <url>      Your cross-check RPC, run by another operator.
  --no-defaults          Use only the RPCs above, never the default ones.
  --own-node             Trust --rpc alone when nothing else can cross-check it (your own node).
  --sts-key <key>        Safe Transaction Service API key.
  --no-sts               Do not call the Safe Transaction Service.
  --no-indexers          Do not call the public indexers (Blockscout, Sourcify).
  --etherscan-key <key>  Etherscan API key (Etherscan is only called with a key).
  --history-budget <s>   Seconds the event history may take; default 90.
  --json <file>          Also write the full JSON report to <file>.
  --verbose              Print every issue as it happens and every request at the end.
  --help                 Show this text.

Exit code: 0 storage fully explained and no Critical or High finding, 1 unexplained storage or a Critical or
High finding, 2 could not verify, 3 the check stopped, 64 wrong arguments.`

class UsageError extends Error {}

// The data layer's texts point at the web app's settings; the CLI takes the same things as flags.
const forCli = (text: string) =>
  text.replace(/Add (your|your own) RPC in settings\./, "Pass your RPC with --rpc <url>.")

// Without a chain: the same detection as the web app's first phase. One Safe found is used; several need --chain.
async function detectChain(address: Address): Promise<string> {
  console.error("No chain given: asking the most used chains whether this address is a Safe.")
  const results = await detectChains(address, { scope: "popular" })
  const safes = results.filter((result) => result.status === "safe")
  const label = (chainId: number) => `${getChain(chainId)?.name ?? "Chain"} (${chainId})`
  if (safes.length === 1) {
    console.error(`Found a Safe on ${label(safes[0].chainId)}.`)
    return String(safes[0].chainId)
  }
  if (safes.length > 1) {
    throw new UsageError(
      `This address is a Safe on ${safes.map((r) => label(r.chainId)).join(", ")}. Pass --chain <id>.`,
    )
  }
  const failed = results.filter((result) => result.status === "error").length
  throw new UsageError(
    `No Safe found at this address on the most used chains${failed > 0 ? ` (${failed} could not be asked)` : ""}. Pass --chain <id> (for example --chain 1), or write the address as eth:0x...`,
  )
}

function rpcUrl(flag: string, text: string | undefined): string | null {
  if (text === undefined) return null
  const result = checkRpcUrl(text)
  if (!result.ok) throw new UsageError(`${flag}: ${result.message}`)
  return result.url
}

async function main(): Promise<number> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      chain: { type: "string" },
      block: { type: "string" },
      rpc: { type: "string" },
      "cross-rpc": { type: "string" },
      "no-defaults": { type: "boolean", default: false },
      "own-node": { type: "boolean", default: false },
      "sts-key": { type: "string" },
      "no-sts": { type: "boolean", default: false },
      "no-indexers": { type: "boolean", default: false },
      "etherscan-key": { type: "string" },
      "history-budget": { type: "string" },
      json: { type: "string" },
      verbose: { type: "boolean", default: false },
      help: { type: "boolean", default: false },
    },
  })
  if (values.help) {
    console.log(HELP)
    return 0
  }
  if (positionals.length !== 1) throw new UsageError("Give exactly one Safe address.")

  const input = parseInput(positionals[0])
  if (!input.ok) throw new UsageError(input.message)
  const named = input.input.chainId
  if (values.chain !== undefined && named !== null && values.chain !== String(named)) {
    throw new UsageError(
      `--chain ${values.chain} conflicts with "${positionals[0]}", which names chain ${named}. Give the chain once.`,
    )
  }
  if (values.block !== undefined && !/^\d+$/.test(values.block)) {
    throw new UsageError(`--block: "${values.block}" is not a block number. Use digits only.`)
  }
  const budget = values["history-budget"]
  if (budget !== undefined && !/^[1-9]\d*$/.test(budget)) {
    throw new UsageError(`--history-budget: "${budget}" is not a number of seconds. Use digits, for example 600.`)
  }
  if (values.chain !== undefined && !/^\d+$/.test(values.chain)) {
    throw new UsageError(`--chain: "${values.chain}" is not a chain id. Use digits, for example --chain 1.`)
  }
  const block = values.block ?? (input.input.block === null ? null : input.input.block.toString())
  const primary = rpcUrl("--rpc", values.rpc)
  const crossCheck = rpcUrl("--cross-rpc", values["cross-rpc"])
  if (values["own-node"] && primary === null) throw new UsageError("--own-node needs --rpc.")
  if (values["no-defaults"] && primary === null) throw new UsageError("--no-defaults needs --rpc.")
  const chainText = values.chain ?? (named === null ? await detectChain(input.input.address) : String(named))
  const chainId = Number(chainText)

  const settings: Settings = defaultSettings()
  if (values["no-sts"]) settings.safeTxService.enabled = false
  if (values["no-indexers"]) settings.publicIndexers = false
  if (values["sts-key"] !== undefined) settings.safeTxService.apiKey = values["sts-key"]
  if (values["etherscan-key"] !== undefined) settings.etherscan.apiKey = values["etherscan-key"]
  if (primary !== null || crossCheck !== null || values["no-defaults"]) {
    settings.rpcs[String(chainId)] = {
      primary,
      crossCheck,
      useDefaults: !values["no-defaults"],
      ...(values["own-node"] ? { ownNode: true } : {}),
    }
  }

  let calls: readonly CallLogEntry[] = []
  const emit = (event: CheckEvent) => {
    if (event.type === "step" && event.step.status !== "running" && event.step.status !== "pending") {
      const note = event.step.note === null ? "" : `: ${event.step.note}`
      console.error(`${event.step.status.padEnd(9)}${event.step.label}${note}`)
    } else if (event.type === "issue" && values.verbose) {
      console.error(`issue    ${issueHeadline(event.issue)}${event.issue.recovered ? " (worked around)" : ""}`)
    } else if (event.type === "restarted") {
      console.error(`restart  ${event.reason}`)
    } else if (event.type === "stopped") {
      console.error(`\nThe check stopped: ${forCli(event.message)}`)
      const lines = event.issues.map((issue) => `  ${issueHeadline(issue)}. ${forCli(issue.explanation)}`)
      for (const line of new Set(lines)) console.error(line)
    }
  }

  const report: Report | null = await startWith(
    {
      // startCheck's session, plus the request log for --verbose.
      openSession: (id, chosen, options) =>
        open(
          id,
          chosen,
          { ...options, ...(budget === undefined ? {} : { historyBudgetMs: Number(budget) * 1000 }) },
          { onCallLog: (log) => (calls = log) },
        ),
      registry: defaultRegistry,
    },
    { address: input.input.address, chainId, block },
    settings,
    emit,
  )
  if (values.verbose) {
    console.error(`\n${calls.length} requests:`)
    for (const call of calls) {
      console.error(`  ${call.at} ${call.role} ${call.host} ${call.method} ${call.outcome} ${call.elapsedMs} ms`)
    }
  }
  if (report === null) return 3

  console.log(reportToMarkdown(report))
  if (values.json !== undefined) {
    writeFileSync(values.json, `${JSON.stringify(report, null, 2)}\n`)
    console.error(`\nJSON report written to ${values.json}`)
  }
  return exitCode(report.verdict)
}

main().then(
  (code) => process.exit(code),
  (error: unknown) => {
    if (error instanceof UsageError || (error as { code?: string }).code?.startsWith("ERR_PARSE_ARGS")) {
      // A value starting with "-" (--block -5) reads to Node as a missing value.
      const message = (error as Error).message
      const text = /'--block\b/.test(message) ? "--block: use digits only, for example --block 20000000." : message
      console.error(`${text}\n\n${HELP}`)
      process.exit(64)
    }
    console.error(error)
    process.exit(3)
  },
)
