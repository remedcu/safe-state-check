import { describe, expect, it } from "vitest"
import { SENTINEL } from "@/core/constants"
import { approvedHashSlot, moduleSlot, ownerSlot, sharedSignerSlot, signedMessageSlot, slotKey } from "@/core/slots"

const OWNER = "0x802cbafa6133c493A7c67f685f97AdA5918d1dF9"
const HASH = "0x9b8d6c1a8f5dfcb5d6b5c1f0a9e0c8f6f2a4d3e1b7c9a5f3e2d1c0b9a8f7e6d5"

describe("slotKey", () => {
  it("pads a slot number to 32 bytes", () => {
    expect(slotKey(3n)).toBe("0x0000000000000000000000000000000000000000000000000000000000000003")
  })
})

// Keys from appendix B of docs/SPEC.md, which match `cast index address <addr> <slot>`.
describe("ownerSlot", () => {
  it("matches the owner keys in appendix B", () => {
    expect(ownerSlot(SENTINEL)).toBe("0xe90b7bceb6e7df5418fb78d8ee546e97c83a08bbccc01a0644d599ccd2a7c2e0")
    expect(ownerSlot(OWNER)).toBe("0x987836d13f39f6cc07c34830a39d9f3a4645b530338199ebb6048d69d0146f2b")
    expect(ownerSlot("0x0000000000000000000000000000000000000002")).toBe(
      "0x679795a0195a1b76cdebb7c51d74e058aee92919b8c3389af86ef24535e8a28c",
    )
  })
})

describe("moduleSlot", () => {
  it("matches the module keys in appendix B", () => {
    expect(moduleSlot(SENTINEL)).toBe("0xcc69885fda6bcc1a4ace058b4a62bf5e179ea78fd58a1ccd71c22cc9b688792f")
    expect(moduleSlot("0x4210382652A5e3C9aF7e1D3c88085818A465449b")).toBe(
      "0xe3ebe3cb924116f2e42323265a69b434816a67760d5bb395a26b66f97c0cded5",
    )
  })
})

// No Safe in appendix B has these entries; the expected keys come from `cast index`.
describe("signedMessageSlot", () => {
  it("matches cast index bytes32 <hash> 7", () => {
    expect(signedMessageSlot(HASH)).toBe("0x0f1888c2f5dc8ec47d0b320ee219e031864570b462276531c445b465043abc79")
  })
})

describe("approvedHashSlot", () => {
  it("matches cast index bytes32 <hash> $(cast index address <owner> 8)", () => {
    expect(approvedHashSlot(OWNER, HASH)).toBe("0x51b766f8701e960dd77c0ecd8a105e473fbf53ea78d3dcde7fc35936426fbb7d")
  })
})

describe("sharedSignerSlot", () => {
  it("matches SIGNER_SLOT() of the shared signer on chain 1", () => {
    // `cast call 0x94a4F6affBd8975951142c3999aEAB7ecee555c2 "SIGNER_SLOT()(uint256)"` (packages research, 2026-10-12).
    expect(sharedSignerSlot("0x94a4F6affBd8975951142c3999aEAB7ecee555c2")).toBe(
      "0x3c9ab54c8206ca6607ebbca0f460c0f0737444317c875e27707106028cfb3f8d",
    )
  })
})
