// Sourcify v2, keyless, asked only about code the registry does not know. A match never makes a contract "known". With
// public indexers turned off it answers "not-checked" and sends nothing.
import { type Address, getAddress } from "viem"
import type { SourcifyStatus } from "@/core/report"
import { SOURCIFY_API } from "@/data/constants"
import { issueOf } from "@/data/errors"
import type { Transport } from "@/data/transport"
import type { ApiResult, Sourcify } from "@/data/types"

export { SOURCIFY_API }

export class SourcifyClient implements Sourcify {
  private readonly transport: Transport
  private readonly enabled: boolean

  constructor(transport: Transport, enabled = true) {
    this.transport = transport
    this.enabled = enabled
  }

  async match(chainId: number, address: Address): Promise<ApiResult<SourcifyStatus>> {
    const source = { service: "sourcify" as const, host: new URL(SOURCIFY_API).host }
    if (!this.enabled) return { ok: true, data: "not-checked", source }
    try {
      // 404 is Sourcify's answer for "not verified", with all match fields null.
      const res = await this.transport.api(`${SOURCIFY_API}/${chainId}/${getAddress(address)}`, {
        service: "sourcify",
        operation: "look up verified source code",
        accept: [404],
      })
      const match = (res.body as { match?: unknown } | null)?.match
      const status: SourcifyStatus = match === "exact_match" || match === "match" ? match : "not-verified"
      return { ok: true, data: status, source }
    } catch (error) {
      return { ok: false, issue: issueOf(error) }
    }
  }
}
