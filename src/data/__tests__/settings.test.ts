import { describe, expect, it } from "vitest"
import {
  checkApiKey,
  checkRpcUrl,
  defaultSettings,
  loadSettings,
  normalizeSettings,
  publicIndexersOn,
  SAFE_TX_SERVICE_DEFAULT_ON,
  saveSettings,
} from "@/data/settings"
import { SETTINGS_STORAGE_KEY } from "@/data/types"

function memory(initial: Record<string, string> = {}) {
  const store = new Map(Object.entries(initial))
  return {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => void store.set(key, value),
    store,
  }
}

describe("settings", () => {
  it("defaults to the keyless Transaction Service, public indexers on, and no keys", () => {
    expect(SAFE_TX_SERVICE_DEFAULT_ON).toBe(true)
    expect(defaultSettings()).toEqual({
      schema: 1,
      rpcs: {},
      safeTxService: { enabled: true, apiKey: null },
      etherscan: { apiKey: null },
      publicIndexers: true,
    })
  })

  it("keeps the public-indexer switch apart from the default RPCs", () => {
    const off = normalizeSettings({
      schema: 1,
      rpcs: { "1": { primary: null, crossCheck: null, useDefaults: true } },
      publicIndexers: false,
    })

    expect(publicIndexersOn(off)).toBe(false)
    expect(publicIndexersOn({ ...defaultSettings(), publicIndexers: undefined })).toBe(true)
    expect(normalizeSettings({ schema: 1, publicIndexers: "no" }).publicIndexers).toBe(true)
  })

  it("refuses a key with a character a request header cannot carry", () => {
    expect(checkApiKey(" abc123 ")).toEqual({ ok: true, key: "abc123" })
    expect(checkApiKey("")).toEqual({ ok: true, key: null })
    expect(checkApiKey("abc123\u200b")).toEqual({
      ok: false,
      message: "The key contains a character that cannot be sent; paste it again.",
    })
    expect(checkApiKey("abc\u2026")).toMatchObject({ ok: false })
    expect(
      normalizeSettings({ schema: 1, safeTxService: { enabled: true, apiKey: "abc\u200b" } }).safeTxService.apiKey,
    ).toBeNull()
  })

  it("accepts https and loopback http only", () => {
    expect(checkRpcUrl(" https://rpc.example.org/key ")).toEqual({ ok: true, url: "https://rpc.example.org/key" })
    expect(checkRpcUrl("http://127.0.0.1:8545").ok).toBe(true)
    expect(checkRpcUrl("http://localhost:8545").ok).toBe(true)
    expect(checkRpcUrl("http://rpc.example.org")).toMatchObject({
      ok: false,
      message: expect.stringContaining("https"),
    })
    expect(checkRpcUrl("wss://rpc.example.org").ok).toBe(false)
    expect(checkRpcUrl("https://user:pass@rpc.example.org").ok).toBe(false)
    expect(checkRpcUrl("not a url").ok).toBe(false)
  })

  it("drops what does not fit the schema, field by field", () => {
    const settings = normalizeSettings({
      schema: 1,
      rpcs: {
        "1": { primary: "https://ok.example", crossCheck: "http://bad.example", useDefaults: true },
        x: { primary: "https://ok.example" },
        "100": { primary: null, crossCheck: null, useDefaults: true },
      },
      safeTxService: { enabled: false, apiKey: "  " },
      etherscan: { apiKey: " KEY " },
    })

    expect(settings.rpcs).toEqual({ "1": { primary: "https://ok.example", crossCheck: null, useDefaults: true } })
    expect(settings.safeTxService).toEqual({ enabled: false, apiKey: null })
    expect(settings.etherscan.apiKey).toBe("KEY")
    expect(normalizeSettings({ schema: 2 })).toEqual(defaultSettings())
  })

  it("keeps own-node trust only with the user's own primary", () => {
    const withPrimary = normalizeSettings({
      schema: 1,
      rpcs: { "1": { primary: "https://node.example", crossCheck: null, useDefaults: false, ownNode: true } },
    })
    const without = normalizeSettings({
      schema: 1,
      rpcs: { "1": { primary: null, crossCheck: "https://node.example", useDefaults: true, ownNode: true } },
    })

    expect(withPrimary.rpcs["1"].ownNode).toBe(true)
    expect(without.rpcs["1"].ownNode).toBeUndefined()
  })

  it("round-trips through storage and survives corrupt or missing storage", () => {
    const storage = memory()
    const saved = saveSettings(
      {
        ...defaultSettings(),
        rpcs: { "1": { primary: "https://node.example", crossCheck: null, useDefaults: false } },
      },
      storage,
    )

    expect(storage.store.has(SETTINGS_STORAGE_KEY)).toBe(true)
    expect(loadSettings(storage)).toEqual(saved)
    expect(loadSettings(memory({ [SETTINGS_STORAGE_KEY]: "{not json" }))).toEqual(defaultSettings())
    expect(loadSettings(null)).toEqual(defaultSettings())
  })
})
