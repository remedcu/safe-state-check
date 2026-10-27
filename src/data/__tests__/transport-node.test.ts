// @vitest-environment node
import { describe, expect, it } from "vitest"
import { NODE_USER_AGENT } from "@/data/constants"
import { Transport } from "@/data/transport"
import type { Endpoint } from "@/data/types"

const ENDPOINT: Endpoint = {
  url: "https://rpc.example.org/",
  host: "rpc.example.org",
  operator: "user:example.org",
  operatorName: "example.org",
  aggregator: false,
  origin: "default",
}

describe("transport in Node", () => {
  it("sends the generic browser-shaped User-Agent on API calls, which Node's own one would get refused for", async () => {
    const sent: Headers[] = []
    const transport = new Transport({
      fetch: async (_, init) => {
        sent.push(new Headers(init?.headers))
        return Response.json({ jsonrpc: "2.0", id: 1, result: "0x1" })
      },
    })

    await transport.api("https://polygon.blockscout.com/api/v2/stats", {
      service: "blockscout",
      operation: "read stats",
    })
    await transport.rpc(ENDPOINT, "eth_chainId", [], { role: "primary", operation: "check the chain" })

    expect(sent[0].get("user-agent")).toBe(NODE_USER_AGENT)
    expect(sent[1].get("user-agent")).toBeNull()
  })
})
