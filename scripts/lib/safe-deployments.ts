// Reads @safe-global/safe-deployments from its `src/assets` (two 1.1.1 files are not wired into `dist`).
import { readdirSync, readFileSync } from "node:fs"
import { createRequire } from "node:module"
import { dirname, join, relative } from "node:path"
import type { Address, Hex } from "viem"
import { SUPPORTED_VERSIONS } from "@/core/registry"

const require = createRequire(import.meta.url)

export function packageDir(name: string): string {
  return dirname(require.resolve(`${name}/package.json`))
}

export function packageVersion(name: string): string {
  return (JSON.parse(readFileSync(join(packageDir(name), "package.json"), "utf8")) as { version: string }).version
}

export function jsonFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true })
    .flatMap((d) =>
      d.isDirectory() ? jsonFiles(join(dir, d.name)) : d.name.endsWith(".json") ? [join(dir, d.name)] : [],
    )
    .sort()
}

export const SAFE_DEPLOYMENTS = "@safe-global/safe-deployments"

export type DeploymentType = "canonical" | "eip155" | "zksync"

export type SafeDeploymentAsset = {
  path: string
  file: string
  contractName: string
  version: string
  released: boolean
  deployments: Partial<Record<DeploymentType, { address: Address; codeHash: Hex }>>
  networkAddresses: Record<string, DeploymentType | DeploymentType[]>
  abi: unknown[]
}

export function safeDeploymentAssets(): SafeDeploymentAsset[] {
  const root = packageDir(SAFE_DEPLOYMENTS)
  return jsonFiles(join(root, "src", "assets")).map((path) => ({
    ...(JSON.parse(readFileSync(path, "utf8")) as Omit<SafeDeploymentAsset, "path" | "file">),
    path: relative(root, path),
    file: path
      .split("/")
      .pop()!
      .replace(/\.json$/, ""),
  }))
}

export const typesOf = (value: DeploymentType | DeploymentType[]): DeploymentType[] =>
  Array.isArray(value) ? value : [value]

// Singletons tried in order to find a contract with storage on each chain: slot 4 (threshold) is 1 on every singleton
// from 1.3.0 on, so the probe's storage proof is an inclusion proof.
const PROBE_SINGLETONS = ["gnosis_safe_l2", "safe_l2", "gnosis_safe", "safe"]

export function safeDeploymentChains(assets: readonly SafeDeploymentAsset[]): {
  ids: number[]
  singleton: Map<number, Address>
  zkStack: Set<number>
} {
  const ids = new Set<number>()
  const zkStack = new Set<number>()
  const singleton = new Map<number, Address>()
  for (const asset of assets) {
    for (const [id, types] of Object.entries(asset.networkAddresses)) {
      ids.add(Number(id))
      if (typesOf(types).includes("zksync")) zkStack.add(Number(id))
    }
  }
  const ordered = [...assets]
    .filter((a) => PROBE_SINGLETONS.includes(a.file) && SUPPORTED_VERSIONS.includes(a.version))
    .sort(
      (a, b) =>
        PROBE_SINGLETONS.indexOf(a.file) - PROBE_SINGLETONS.indexOf(b.file) || a.version.localeCompare(b.version),
    )
  for (const asset of ordered) {
    for (const [id, types] of Object.entries(asset.networkAddresses)) {
      const deployment = asset.deployments[typesOf(types)[0]]
      if (!singleton.has(Number(id)) && deployment) singleton.set(Number(id), deployment.address)
    }
  }
  return { ids: [...ids].sort((a, b) => a - b), singleton, zkStack }
}
