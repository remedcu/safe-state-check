// Strings an RPC or an API chooses (a VERSION() answer, a delegate label) go into the report shown and pasted by
// users. They are kept short and free of control characters and line breaks; the UI and the Markdown escape the rest.

// Control characters (C0, DEL, C1) and line or paragraph separators, replaced by a space.
const isControl = (code: number) => code < 0x20 || (code >= 0x7f && code <= 0x9f) || code === 0x2028 || code === 0x2029

export function cleanUntrusted(value: string, max = 64): string {
  const clean = Array.from(value, (char) => (isControl(char.codePointAt(0) ?? 0) ? " " : char))
    .join("")
    .trim()
  // Capped by code point, so a character outside the BMP is never cut in half.
  const chars = Array.from(clean)
  return chars.length > max ? `${chars.slice(0, max).join("")}...` : clean
}

// The same, in double quotes, for a value shown inside a sentence.
export function quoteUntrusted(value: string, max = 64): string {
  return JSON.stringify(cleanUntrusted(value, max))
}
