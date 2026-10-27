// Plain values the UI needs on first paint. No imports: anything here must not pull viem or the data layer into the
// first chunk.

export const SETTINGS_STORAGE_KEY = "safe-state-check:settings:v1"

export const SOURCIFY_API = "https://sourcify.dev/server/v2/contract"

// Browser-shaped but generic: Blockscout on Base, Arbitrum and Polygon answers 403 to non-browser User-Agents. Sent
// only from Node (the CLI and the generators); a browser sends its own.
export const NODE_USER_AGENT = "Mozilla/5.0 (compatible; safe-state-check-generator)"
