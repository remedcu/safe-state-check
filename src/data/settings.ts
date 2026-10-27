// User settings in localStorage: own RPCs per chain, the Transaction Service and public-indexer switches and the optional
// API keys. Keys and RPC URLs leave this file only for request headers and query strings (docs/ARCHITECTURE.md
// section 7).
import { SETTINGS_STORAGE_KEY } from "@/data/constants"
import type { ChainRpcSettings, Settings } from "@/data/types"

// The Safe Transaction Service is called without a key by default: Safe documents a keyless tier, and it is the party
// the user already trusts with the Safe. The user can turn it off. Set to false to make it opt-in.
export const SAFE_TX_SERVICE_DEFAULT_ON = true

// Blockscout and Sourcify are keyless and fill history and source checks; the user can turn them off without turning
// off the default RPCs.
export const PUBLIC_INDEXERS_DEFAULT_ON = true

type StorageLike = Pick<Storage, "getItem" | "setItem">

export function defaultSettings(): Settings {
  return {
    schema: 1,
    rpcs: {},
    safeTxService: { enabled: SAFE_TX_SERVICE_DEFAULT_ON, apiKey: null },
    etherscan: { apiKey: null },
    publicIndexers: PUBLIC_INDEXERS_DEFAULT_ON,
  }
}

export function publicIndexersOn(settings: Settings): boolean {
  return settings.publicIndexers ?? PUBLIC_INDEXERS_DEFAULT_ON
}

export type KeyCheck = { ok: true; key: string | null } | { ok: false; message: string }

// A key goes into a request header or query string, which take printable ASCII only. A key copied from a web page can
// carry a zero-width space or an ellipsis; fetch would then fail before sending anything.
export function checkApiKey(text: string): KeyCheck {
  const value = text.trim()
  if (!value) return { ok: true, key: null }
  if (!/^[\x21-\x7e]+$/.test(value)) {
    return { ok: false, message: "The key contains a character that cannot be sent; paste it again." }
  }
  return { ok: true, key: value }
}

export type UrlCheck = { ok: true; url: string } | { ok: false; message: string }

// The CSP allows https everywhere and plain http only to this computer; the transport checks every request with this.
export function allowedRpcUrl(url: string): boolean {
  try {
    const parsed = new URL(url)
    if (parsed.protocol === "https:") return true
    return parsed.protocol === "http:" && (parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1")
  } catch {
    return false
  }
}

// The CSP allows https and loopback http only (docs/ARCHITECTURE.md section 14); fetch refuses URLs with credentials.
export function checkRpcUrl(text: string): UrlCheck {
  const value = text.trim()
  if (!value) return { ok: false, message: "Enter the RPC URL." }
  let url: URL
  try {
    url = new URL(value)
  } catch {
    return { ok: false, message: "This is not a URL. It should look like https://rpc.example.org." }
  }
  if (!allowedRpcUrl(value)) {
    return {
      ok: false,
      message: "Use an https:// URL. Plain http:// works only for a node on this computer (localhost or 127.0.0.1).",
    }
  }
  if (url.username || url.password) {
    return { ok: false, message: "Browsers do not send user names or passwords in a URL. Put the key in the path." }
  }
  return { ok: true, url: value }
}

function cleanKey(value: unknown): string | null {
  if (typeof value !== "string") return null
  const check = checkApiKey(value)
  return check.ok ? check.key : null
}

function cleanUrl(value: unknown): string | null {
  if (typeof value !== "string") return null
  const check = checkRpcUrl(value)
  return check.ok ? check.url : null
}

// Anything stored that does not fit the schema is dropped field by field, never thrown.
export function normalizeSettings(input: unknown): Settings {
  const settings = defaultSettings()
  if (typeof input !== "object" || input === null || (input as { schema?: unknown }).schema !== 1) return settings
  const raw = input as Record<string, unknown>

  if (typeof raw.rpcs === "object" && raw.rpcs !== null) {
    for (const [chainId, value] of Object.entries(raw.rpcs as Record<string, unknown>)) {
      if (!/^\d+$/.test(chainId) || typeof value !== "object" || value === null) continue
      const entry = value as Record<string, unknown>
      const chain: ChainRpcSettings = {
        primary: cleanUrl(entry.primary),
        crossCheck: cleanUrl(entry.crossCheck),
        useDefaults: entry.useDefaults !== false,
      }
      // Own-node trust applies to the user's own primary only; it is never stored without one.
      if (entry.ownNode === true && chain.primary) chain.ownNode = true
      if (chain.primary || chain.crossCheck || !chain.useDefaults) settings.rpcs[chainId] = chain
    }
  }
  const sts = raw.safeTxService as Record<string, unknown> | undefined
  if (typeof sts === "object" && sts !== null) {
    settings.safeTxService = {
      enabled: typeof sts.enabled === "boolean" ? sts.enabled : SAFE_TX_SERVICE_DEFAULT_ON,
      apiKey: cleanKey(sts.apiKey),
    }
  }
  const etherscan = raw.etherscan as Record<string, unknown> | undefined
  if (typeof etherscan === "object" && etherscan !== null) settings.etherscan = { apiKey: cleanKey(etherscan.apiKey) }
  if (typeof raw.publicIndexers === "boolean") settings.publicIndexers = raw.publicIndexers
  return settings
}

function browserStorage(): StorageLike | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage
  } catch {
    // Storage disabled by the browser (private mode, blocked cookies).
    return null
  }
}

export function loadSettings(storage: StorageLike | null = browserStorage()): Settings {
  try {
    const text = storage?.getItem(SETTINGS_STORAGE_KEY)
    return text ? normalizeSettings(JSON.parse(text)) : defaultSettings()
  } catch {
    return defaultSettings()
  }
}

// Returns what was stored: invalid URLs and keys are dropped. Check fields with `checkRpcUrl` and `checkApiKey` first.
export function saveSettings(settings: Settings, storage: StorageLike | null = browserStorage()): Settings {
  const clean = normalizeSettings(settings)
  storage?.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(clean))
  return clean
}

export function chainSettings(settings: Settings, chainId: number): ChainRpcSettings {
  return settings.rpcs[String(chainId)] ?? { primary: null, crossCheck: null, useDefaults: true }
}
