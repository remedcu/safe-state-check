// Fetches a generator input once and records where it came from (URL, time, ETag, sha256), or reads the snapshot of
// an earlier fetch with --offline.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import type { SourceMeta } from "@/data/types"
import { sha256, USER_AGENT } from "./http"

export async function loadSource(
  name: string,
  url: string,
  dir: string,
  offline: boolean,
  metas: Record<string, SourceMeta>,
): Promise<unknown> {
  mkdirSync(dir, { recursive: true })
  const file = join(dir, `${name}.json`)
  const metaFile = join(dir, "meta.json")
  if (offline) {
    const all = existsSync(metaFile) ? (JSON.parse(readFileSync(metaFile, "utf8")) as Record<string, SourceMeta>) : {}
    if (!all[name]) throw new Error(`No snapshot of ${name} in ${dir}; run once without --offline`)
    metas[name] = all[name]
    return JSON.parse(readFileSync(file, "utf8"))
  }
  const fetchedAt = new Date().toISOString()
  const res = await fetch(url, { headers: { "user-agent": USER_AGENT }, signal: AbortSignal.timeout(60_000) })
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`)
  const text = await res.text()
  const data: unknown = JSON.parse(text)
  writeFileSync(file, text)
  metas[name] = { url, fetchedAt, etag: res.headers.get("etag"), sha256: sha256(text), bytes: Buffer.byteLength(text) }
  const all = existsSync(metaFile) ? (JSON.parse(readFileSync(metaFile, "utf8")) as Record<string, SourceMeta>) : {}
  writeFileSync(metaFile, `${JSON.stringify({ ...all, [name]: metas[name] }, null, 2)}\n`)
  return data
}
