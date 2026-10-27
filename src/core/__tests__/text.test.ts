import { describe, expect, it } from "vitest"
import { cleanUntrusted, quoteUntrusted } from "@/core/text"

describe("cleanUntrusted", () => {
  it("turns control characters and line separators into spaces", () => {
    expect(cleanUntrusted("1.4.1\n# Fully explained\u0000\u0085\u2028end")).toBe("1.4.1 # Fully explained   end")
  })

  it("caps the text by code point and marks the cut", () => {
    expect(cleanUntrusted("abcdef", 3)).toBe("abc...")
    expect(cleanUntrusted("abc", 3)).toBe("abc")
    // Two characters outside the BMP: the cap never leaves half a surrogate pair.
    expect(cleanUntrusted("\u{1F600}\u{1F600}", 1)).toBe("\u{1F600}...")
  })
})

describe("quoteUntrusted", () => {
  it("quotes the cleaned text and escapes its quotes", () => {
    expect(quoteUntrusted('say "hi"\n')).toBe('"say \\"hi\\""')
  })
})
