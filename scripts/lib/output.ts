// Writes generated JSON exactly as Prettier formats it, so `prettier --check .` passes and diffs stay line by line.
import { mkdirSync, writeFileSync } from "node:fs"
import { dirname } from "node:path"
import { format, resolveConfig } from "prettier"

export async function formatJson(path: string, value: unknown): Promise<string> {
  const options = (await resolveConfig(path)) ?? {}
  return format(JSON.stringify(value, null, 2), { ...options, filepath: path })
}

export async function writeJson(path: string, value: unknown): Promise<void> {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, await formatJson(path, value))
}
