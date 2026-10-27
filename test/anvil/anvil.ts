// Starts and stops a fresh anvil (no fork: a fork's eth_getProof after a local write can return a wrong root) on a free
// port, with Prague for EIP-7702.
import { type ChildProcess, execFileSync, spawn } from "node:child_process"
import { readFileSync, writeFileSync } from "node:fs"
import { createServer } from "node:net"
import path from "node:path"

export type Anvil = { url: string; chainId: number; stop: () => Promise<void> }

const ROOT = path.resolve(import.meta.dirname, "../..")
export const CACHE = path.join(ROOT, "node_modules/.cache/anvil-suite")
export const ARTIFACTS = path.join(CACHE, "out/Helpers.sol")

// Compiles test/anvil/contracts into the cache (foundry.toml there says where).
export function buildHelpers(): void {
  execFileSync("forge", ["build", "--root", path.join(ROOT, "test/anvil/contracts")], { stdio: "pipe" })
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer()
    server.unref()
    server.on("error", reject)
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as { port: number }
      server.close(() => resolve(port))
    })
  })
}

async function ready(url: string, child: ChildProcess): Promise<void> {
  for (let i = 0; i < 100; i++) {
    if (child.exitCode !== null) throw new Error(`anvil exited with ${child.exitCode}`)
    try {
      const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] })
      if ((await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body })).ok) return
    } catch {
      // not listening yet
    }
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error(`anvil did not answer on ${url}`)
}

// `dump`: write the state with every block's state to this file on stop. `load`: start from such a file.
export async function startAnvil(chainId: number, files: { dump?: string; load?: string } = {}): Promise<Anvil> {
  const port = await freePort()
  const args = ["--port", `${port}`, "--chain-id", `${chainId}`, "--hardfork", "prague", "--silent"]
  if (files.dump) args.push("--dump-state", files.dump, "--preserve-historical-states")
  if (files.load) args.push("--load-state", files.load)
  const child = spawn("anvil", args, { stdio: "ignore" })
  // Never leave anvil behind, even when the runner dies.
  const kill = () => child.kill("SIGINT")
  process.once("exit", kill)
  const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()))
  const stop = async () => {
    process.off("exit", kill)
    if (child.exitCode === null) kill()
    await exited
  }
  const url = `http://127.0.0.1:${port}`
  await ready(url, child).catch(async (error) => {
    await stop()
    throw error
  })
  return { url, chainId, stop }
}

// anvil 1.5.1 keeps a slot that a transaction read as zero in the account's storage and hashes it into the storage
// root as a zero-valued leaf, so after any execTransaction (it reads the guard slot) eth_getProof's storageHash is not
// the Ethereum root of the Safe's storage. Dropping those entries from the dumped state and loading it into a fresh
// anvil gives the Ethereum root for new blocks; blocks, receipts and the older states (traces, old code) carry over.
export function dropZeroSlots(file: string): number {
  const state = JSON.parse(readFileSync(file, "utf8")) as {
    accounts: Record<string, { storage?: Record<string, string> }>
  }
  let dropped = 0
  for (const account of Object.values(state.accounts)) {
    for (const [slot, value] of Object.entries(account.storage ?? {})) {
      if (BigInt(value) === 0n) {
        delete account.storage![slot]
        dropped++
      }
    }
  }
  writeFileSync(file, JSON.stringify(state))
  return dropped
}
