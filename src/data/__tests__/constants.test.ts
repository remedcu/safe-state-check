import { describe, expect, it } from "vitest"
import * as constants from "@/data/constants"
import { SOURCIFY_API } from "@/data/sourcify"
import { SETTINGS_STORAGE_KEY } from "@/data/types"

const sources = import.meta.glob("@/data/constants.ts", { query: "?raw", import: "default", eager: true })

describe("constants for the first chunk", () => {
  it("imports nothing, so the UI can use it without viem or the data layer", () => {
    const source = Object.values(sources)[0] as string

    expect(source).toContain("SOURCIFY_API")
    expect(source).not.toMatch(/^\s*import\b/m)
  })

  it("is what the old locations re-export", () => {
    expect(SOURCIFY_API).toBe(constants.SOURCIFY_API)
    expect(SETTINGS_STORAGE_KEY).toBe(constants.SETTINGS_STORAGE_KEY)
  })
})
