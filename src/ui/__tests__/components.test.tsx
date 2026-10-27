import { cleanup, fireEvent, render, screen, within } from "@testing-library/react"
import type { ComponentProps, ReactElement } from "react"
import { afterEach, describe, expect, it, vi } from "vitest"
import { issueHeadline } from "@/core/markdown"
import type { IssueKind, Part, Report } from "@/core/report"
import type { Settings } from "@/data/types"
import { ETHEREUM, GNOSIS, NO_RPC_CHAIN } from "@/ui/__fixtures__/chains"
import { streamFor } from "@/ui/__fixtures__/events"
import { pipelineGreen } from "@/ui/__fixtures__/pipeline"
import {
  amberSingleOperatorReport,
  amberUnsupportedChainReport,
  greenReport,
  issue,
  issuesByKind,
  redShadowOwnerReport,
  selfTrustedReport,
  stoppedNotDeployed,
} from "@/ui/__fixtures__/reports"
import { TOOL } from "@/check/run"
import { AddressLink } from "@/ui/components/common"
import { IssueCard } from "@/ui/components/IssueCard"
import { ReportActions } from "@/ui/components/ReportActions"
import { RunView } from "@/ui/components/RunView"
import { SettingsPanel } from "@/ui/components/SettingsPanel"
import { type LiveRun, reduceRun, startRun } from "@/ui/run"
import { Creation, History, Pending } from "@/ui/sections/Activity"
import { Handlers, Identity, Modules, Owners } from "@/ui/sections/Config"
import { Storage } from "@/ui/sections/Storage"

afterEach(cleanup)

const ACTIONS = { onStop: vi.fn(), onRetry: vi.fn(), onOpenSettings: vi.fn(), onLatestBlock: vi.fn() }

function finished(report: Report): LiveRun {
  return reduceRun(startRun(report.request), { type: "finished", report })
}

describe("IssueCard", () => {
  for (const kind of Object.keys(issuesByKind) as IssueKind[]) {
    it(`renders a ${kind} issue in plain words with its technical details behind a toggle`, () => {
      const issue = issuesByKind[kind]
      render(<IssueCard issue={issue} />)

      screen.getByText(issueHeadline(issue))
      screen.getByText(issue.explanation)
      for (const action of issue.actions) screen.getByText(action)
      expect(screen.queryByText(issue.raw.url)).toBeNull()

      fireEvent.click(screen.getByRole("button", { name: "Technical details" }))
      screen.getByText(issue.raw.url)
      screen.getByText(issue.raw.method)
    })
  }

  it("says which RPC failed at what", () => {
    render(<IssueCard issue={amberSingleOperatorReport.issues[0]} />)

    screen.getByText(/^Cross-check RPC eth-mainnet\.public\.blastapi\.io could not read block 26176126: /)
  })

  it("offers the RPC settings for an RPC problem the run could not work around", () => {
    const onOpenSettings = vi.fn()
    render(<IssueCard issue={issuesByKind["proof-window"]} onOpenSettings={onOpenSettings} />)

    fireEvent.click(screen.getByRole("button", { name: "Open RPC settings" }))
    expect(onOpenSettings).toHaveBeenCalledOnce()
  })
})

describe("sections", () => {
  const chain = greenReport.chain
  const cases: [string, (part: Part<never> | undefined) => ReactElement, Part<unknown>][] = [
    ["Safe contract", (p) => <Identity part={p} chain={chain} />, greenReport.identity],
    ["Owners", (p) => <Owners part={p} chain={chain} />, greenReport.owners],
    ["Modules", (p) => <Modules part={p} chain={chain} />, greenReport.modules],
    ["Guard and fallback handler", (p) => <Handlers part={p} chain={chain} />, greenReport.handlers],
    ["Storage", (p) => <Storage part={p} />, greenReport.storage],
    ["Creation", (p) => <Creation part={p} chain={chain} />, greenReport.creation],
    ["History", (p) => <History part={p} />, greenReport.history],
    ["Pending actions", (p) => <Pending part={p} chain={chain} />, greenReport.pending],
  ]

  for (const [title, view, complete] of cases) {
    describe(title, () => {
      if (complete.state !== "complete") throw new Error("fixture section must be complete")

      it("renders complete data", () => {
        render(view(complete as Part<never>))
        screen.getByRole("heading", { level: 2, name: new RegExp(`^${title}`) })
        expect(screen.queryByText(/^Incomplete/)).toBeNull()
      })

      it("renders partial data with its gaps", () => {
        render(view({ state: "partial", data: complete.data, gaps: ["Blocks before 100 were not read."] } as never))
        screen.getByText("Incomplete:")
        screen.getByText("Blocks before 100 were not read.")
      })

      it("says why it is unavailable", () => {
        render(view({ state: "unavailable", reason: "The RPC timed out." }))
        screen.getByText("Not available: The RPC timed out.")
      })

      it("says why it was skipped", () => {
        render(view({ state: "skipped", reason: "Turned off in settings." }))
        screen.getByText("Skipped: Turned off in settings.")
      })
    })
  }

  it("shows the owners with their type and flags", () => {
    render(<Owners part={greenReport.owners} chain={chain} />)
    const row = screen.getByText("0x802cbafa6133c493A7c67f685f97AdA5918d1dF9").closest("tr")!

    within(row).getByText("Plain account with EIP-7702 delegation")
    within(row).getByText("Owner is an EIP-7702 delegated account")
  })

  it("shows the Reality module parameters in plain units", () => {
    render(<Modules part={greenReport.modules} chain={chain} />)

    screen.getByText("3 days (259200 s)")
    screen.getByText("5 days (432000 s)")
    screen.getByText("10000000000000000000000 (smallest units of the bond token)")
  })

  it("marks a shadow owner slot as suspicious", () => {
    render(<Storage part={redShadowOwnerReport.storage} />)
    const row = screen.getByText("Hidden owner entry for 0x…02").closest("tr")!

    within(row).getByText("suspicious")
    within(row).getByText("trace")
  })

  it("says when the root check could not run", () => {
    render(<Storage part={amberUnsupportedChainReport.storage} />)

    screen.getByText(/The storage root check did not run: ZK Stack/)
    expect(screen.getAllByText("not proven").length).toBe(10)
  })
})

describe("RunView", () => {
  it("puts the verdict first, then the cards, then the sections in order", () => {
    render(<RunView tool={TOOL} userRpcs={null} run={finished(greenReport)} actions={ACTIONS} />)
    const headings = screen.getAllByRole("heading", { level: 2 }).map((h) => h.textContent)

    expect(headings[0]).toBe("Storage fully explained")
    expect(headings.slice(1).map((h) => h?.split(" ")[0])).toEqual([
      "Safe",
      "Owners",
      "Modules",
      "Guard",
      "Storage",
      "Creation",
      "History",
      "Pending",
      "Verification",
      "What",
    ])
    screen.getByText("Findings: 0 critical · 0 high · 1 medium · 1 info")
    expect(screen.getByRole("list", { name: "Summary" }).children.length).toBe(8)
  })

  it("lists every finding on request", () => {
    render(<RunView tool={TOOL} userRpcs={null} run={finished(redShadowOwnerReport)} actions={ACTIONS} />)

    screen.getByRole("heading", { name: "Unexplained storage" })
    fireEvent.click(screen.getByRole("button", { name: "Show all 4 findings" }))
    const list = screen.getByRole("region", { name: "All findings" })
    within(list).getByText("Critical")
    within(list).getByText("Hidden owner entry")
    screen.getByRole("heading", { name: /^Diagnosis/ })
  })

  it("says why a run could not be verified and offers the RPC settings", () => {
    render(<RunView tool={TOOL} userRpcs={null} run={finished(amberSingleOperatorReport)} actions={ACTIONS} />)

    screen.getByRole("heading", { name: "Could not verify" })
    screen.getByText("Only one RPC operator confirmed this block.")
    fireEvent.click(screen.getByRole("button", { name: "RPC settings" }))
    expect(ACTIONS.onOpenSettings).toHaveBeenCalled()
  })

  it("never lets a self-trusted green read as two-operator verification", () => {
    render(<RunView tool={TOOL} userRpcs={null} run={finished(selfTrustedReport)} actions={ACTIONS} />)
    const banner = screen.getByRole("heading", { name: "Storage fully explained" }).closest("section")!

    within(banner).getByText("Verified against your own RPC only (no independent cross-check).")
    fireEvent.click(screen.getByRole("button", { name: "Show all 3 findings" }))
    screen.getByText("Setting without its event (indexer only)")
  })

  it("shows why a run stopped, with its problems and a retry", () => {
    let run = startRun(greenReport.request)
    run = reduceRun(run, { ...stoppedNotDeployed, issues: [issuesByKind.unreachable] })
    render(<RunView tool={TOOL} userRpcs={null} run={run} actions={ACTIONS} />)

    screen.getByRole("heading", { name: "No Safe at this address" })
    screen.getByText(stoppedNotDeployed.message)
    screen.getByText(issueHeadline(issuesByKind.unreachable))
    fireEvent.click(screen.getByRole("button", { name: "Try again" }))
    expect(ACTIONS.onRetry).toHaveBeenCalled()
  })

  it("keeps the same frame while the run streams", () => {
    const events = streamFor(greenReport).map((t) => t.event)
    let run = startRun(greenReport.request)
    const { container, rerender } = render(<RunView tool={TOOL} userRpcs={null} run={run} actions={ACTIONS} />)
    const banner = container.querySelector("section")!
    const frame = banner.className
    expect(screen.getByRole("list", { name: "Steps" }).children.length).toBe(14)

    for (const event of events.slice(0, -1)) {
      run = reduceRun(run, event)
      rerender(<RunView tool={TOOL} userRpcs={null} run={run} actions={ACTIONS} />)
      // One banner box of fixed height, 14 step slots and 8 card slots in every state.
      expect(container.querySelector("section")!.className).toBe(frame)
      expect(screen.getByRole("list", { name: "Steps" }).children.length).toBe(14)
      expect(screen.getByRole("list", { name: "Summary" }).children.length).toBe(8)
    }
    expect(frame.split(" ")).toContain("h-[28rem]")
    rerender(<RunView tool={TOOL} userRpcs={null} run={reduceRun(run, events.at(-1)!)} actions={ACTIONS} />)
    expect(container.querySelector("section")!.className.replace(TONE, "")).toBe(frame.replace(TONE, ""))
  })
})

const TONE = /border-\S+ bg-\S+ text-\S+$/

describe("RunView, stopped runs", () => {
  // A green run stopped by the user once owners and modules were done.
  async function stoppedMidway(): Promise<LiveRun> {
    const { events } = await pipelineGreen()
    const cut = events.findIndex((e) => e.type === "step" && e.step.id === "modules" && e.step.status === "done")
    let run = startRun(greenReport.request)
    for (const event of events.slice(0, cut + 1)) run = reduceRun(run, event)
    return reduceRun(run, { type: "stopped", reason: "cancelled", message: "You stopped it.", issues: [] })
  }

  it("keeps what a stopped run proved, labelled as a partial result, with both downloads", async () => {
    render(<RunView tool={TOOL} userRpcs={null} run={await stoppedMidway()} actions={ACTIONS} />)

    screen.getByRole("heading", { level: 2, name: "Stopped: partial result" })
    screen.getByRole("heading", { level: 2, name: /^Owners/ })
    expect(screen.getAllByText("Skipped: Not read: the check was stopped first.").length).toBeGreaterThan(0)
    expect((screen.getByRole("button", { name: "Download JSON report" }) as HTMLButtonElement).disabled).toBe(false)
    expect((screen.getByRole("button", { name: "Copy Markdown summary" }) as HTMLButtonElement).disabled).toBe(false)
  })

  it("has nothing to keep when the run stopped before a block was pinned", () => {
    const run = reduceRun(startRun(greenReport.request), {
      type: "stopped",
      reason: "cancelled",
      message: "You stopped it.",
      issues: [],
    })
    render(<RunView tool={TOOL} userRpcs={null} run={run} actions={ACTIONS} />)

    screen.getByRole("heading", { level: 2, name: "Check stopped" })
    expect((screen.getByRole("button", { name: "Download JSON report" }) as HTMLButtonElement).disabled).toBe(true)
  })

  it("names an address that is not a Safe plainly, and lets a long message wrap", () => {
    const run = reduceRun(startRun(greenReport.request), {
      type: "stopped",
      reason: "not-a-safe",
      message: `${greenReport.request.address} has code, but it is not a Safe.`,
      issues: [],
    })
    render(<RunView tool={TOOL} userRpcs={null} run={run} actions={ACTIONS} />)

    screen.getByRole("heading", { level: 2, name: "This address is not a Safe" })
    const banner = screen.getByRole("heading", { level: 2, name: "This address is not a Safe" }).closest("section")!
    expect(
      within(banner)
        .getByText(/has code, but it is not a Safe/)
        .className.split(" "),
    ).toContain("wrap-anywhere")
  })

  it("says in the banner when the user's own RPC was not used", () => {
    const report: Report = {
      ...greenReport,
      issues: [issue("wrong-chain", { host: "rpc.gnosischain.com", recovered: true })],
    }
    const userRpcs = { primary: "https://rpc.gnosischain.com", crossCheck: null, useDefaults: true }
    render(<RunView tool={TOOL} userRpcs={userRpcs} run={finished(report)} actions={ACTIONS} />)

    within(screen.getByRole("list", { name: "Reasons" })).getByText(/^Your RPC rpc\.gnosischain\.com was not used: /)
  })
})

describe("ReportActions", () => {
  it("labels a partial result and carries the page's notes into the Markdown and the file name", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true })
    const createObjectURL = vi.fn().mockReturnValue("blob:report")
    Object.assign(URL, { createObjectURL, revokeObjectURL: vi.fn() })
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {})
    render(<ReportActions report={greenReport} partial notes={["Your RPC rpc.example.org was not used."]} />)

    fireEvent.click(screen.getByRole("button", { name: "Copy Markdown summary" }))
    await screen.findByRole("button", { name: "Markdown copied" })
    const markdown = writeText.mock.calls[0][0] as string
    expect(markdown.split("\n")[0]).toBe("# Safe State Check: Stopped: partial result")
    expect(markdown).toContain("- Your RPC rpc.example.org was not used.")

    fireEvent.click(screen.getByRole("button", { name: "Download JSON report" }))
    expect((click.mock.contexts[0] as HTMLAnchorElement).download).toMatch(/-partial\.json$/)
    click.mockRestore()
  })
})

describe("RunView, block and trust", () => {
  const atUserBlock: Report = {
    ...greenReport,
    verification: {
      ...greenReport.verification,
      anchor: { ...greenReport.verification.anchor, pinnedBy: "user" },
    },
  }

  it("shows the block and its time in the banner", () => {
    render(<RunView tool={TOOL} userRpcs={null} run={finished(greenReport)} actions={ACTIONS} />)
    const banner = screen.getByRole("heading", { name: "Storage fully explained" }).closest("section")!

    within(banner).getByText("Block 26176126, 2026-10-12 11:34:47 UTC")
    expect(within(banner).queryByText(/not the current state/)).toBeNull()
  })

  it("says a past block is not the current state and offers the latest one", () => {
    const onLatestBlock = vi.fn()
    render(<RunView tool={TOOL} userRpcs={null} run={finished(atUserBlock)} actions={{ ...ACTIONS, onLatestBlock }} />)
    const banner = screen.getByRole("heading", { name: "Storage fully explained" }).closest("section")!

    within(banner).getByText("This is the state at block 26176126, not the current state.")
    fireEvent.click(within(banner).getByRole("button", { name: "Check the latest block" }))
    expect(onLatestBlock).toHaveBeenCalledOnce()
  })

  it("says so when the RPCs are ones the user entered", () => {
    const verification = {
      ...greenReport.verification,
      primary: { ...greenReport.verification.primary, origin: "user" as const, host: "a.example.org" },
      crossCheck: { ...greenReport.verification.crossCheck!, origin: "user" as const, host: "b.example.org" },
    }
    render(<RunView tool={TOOL} userRpcs={null} run={finished({ ...greenReport, verification })} actions={ACTIONS} />)

    screen.getByText(
      "Both RPCs are ones you entered (a.example.org and b.example.org); no default RPC confirmed this block.",
    )
  })

  it("announces the verdict and moves focus to it when the run ends", () => {
    const run = startRun(greenReport.request)
    const { rerender } = render(<RunView tool={TOOL} userRpcs={null} run={run} actions={ACTIONS} />)
    expect(screen.getByRole("status").textContent).toBe("")

    rerender(
      <RunView
        tool={TOOL}
        userRpcs={null}
        run={reduceRun(run, { type: "finished", report: greenReport })}
        actions={ACTIONS}
      />,
    )
    expect(screen.getByRole("status").textContent).toBe(
      "Check finished: Storage fully explained. Findings: 0 critical, 0 high, 1 medium, 1 info.",
    )
    expect(document.activeElement).toBe(screen.getByRole("heading", { name: "Storage fully explained" }))
  })

  it("looks for the address on other chains only on a click, and says why it failed", async () => {
    const onCheckOtherChains = vi.fn().mockRejectedValue(new Error("no answer"))
    render(
      <RunView tool={TOOL} userRpcs={null} run={finished(greenReport)} actions={{ ...ACTIONS, onCheckOtherChains }} />,
    )

    expect(onCheckOtherChains).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole("button", { name: "Check other chains" }))
    expect((await screen.findByRole("alert")).textContent).toBe("It failed: no answer")
  })

  it("links an address only to an https explorer", () => {
    const plain = { ...greenReport.chain, explorerAddressUrl: "http://mantrascan.io/address/{address}" }
    render(<AddressLink address={greenReport.request.address} chain={plain} />)

    expect(screen.queryByRole("link")).toBeNull()
    screen.getByText(greenReport.request.address)
  })
})

describe("SettingsPanel", () => {
  const settings: Settings = {
    schema: 1,
    rpcs: {},
    safeTxService: { enabled: true, apiKey: null },
    etherscan: { apiKey: null },
    publicIndexers: true,
  }

  function Panel(props: Partial<ComponentProps<typeof SettingsPanel>>) {
    return (
      <SettingsPanel
        id="s"
        chain={ETHEREUM}
        block=""
        onBlockChange={() => {}}
        settings={settings}
        focusRequest={0}
        operatorName={(rpc) => `name of ${rpc.operator}`}
        onSave={vi.fn()}
        {...props}
      />
    )
  }

  it("lists the chain's default RPCs and saves the user's own", () => {
    const onSave = vi.fn()
    render(<Panel onSave={onSave} />)

    screen.getByText("https://eth.drpc.org")
    screen.getByText(/^name of drpc, serves storage proofs/)
    screen.getByText(/saved in this browser \(localStorage\)/)
    const own = screen.getByRole("checkbox", { name: "This is my own node: trust it without a cross-check" })
    expect((own as HTMLInputElement).disabled).toBe(true)

    fireEvent.change(screen.getByLabelText("Your primary RPC (optional)"), {
      target: { value: "http://127.0.0.1:8545" },
    })
    fireEvent.click(own)
    fireEvent.click(screen.getByRole("button", { name: "Save settings" }))

    expect(onSave).toHaveBeenCalledWith({
      ...settings,
      rpcs: { "1": { primary: "http://127.0.0.1:8545", crossCheck: null, useDefaults: true, ownNode: true } },
    })
    screen.getByText("Saved in this browser.")
  })

  it("never keeps own-node trust without the user's own primary RPC", () => {
    const onSave = vi.fn()
    const saved: Settings = {
      ...settings,
      rpcs: {
        "1": {
          primary: "https://a.example.org",
          crossCheck: "https://b.example.org",
          useDefaults: true,
          ownNode: true,
        },
      },
    }
    render(<Panel settings={saved} onSave={onSave} />)

    fireEvent.change(screen.getByLabelText("Your primary RPC (optional)"), { target: { value: "" } })
    fireEvent.click(screen.getByRole("button", { name: "Save settings" }))

    expect(onSave.mock.calls[0][0].rpcs["1"]).toEqual({
      primary: null,
      crossCheck: "https://b.example.org",
      useDefaults: true,
    })
  })

  it("keeps what was typed for one chain while another is shown", () => {
    const onSave = vi.fn()
    const { rerender } = render(<Panel onSave={onSave} />)
    fireEvent.change(screen.getByLabelText("Your primary RPC (optional)"), {
      target: { value: "https://a.example.org" },
    })
    fireEvent.change(screen.getByLabelText("Etherscan API key (optional)"), { target: { value: "KEY1" } })

    rerender(<Panel chain={GNOSIS} onSave={onSave} />)
    expect((screen.getByLabelText("Your primary RPC (optional)") as HTMLInputElement).value).toBe("")
    expect((screen.getByLabelText("Etherscan API key (optional)") as HTMLInputElement).value).toBe("KEY1")
    rerender(<Panel chain={ETHEREUM} onSave={onSave} />)
    expect((screen.getByLabelText("Your primary RPC (optional)") as HTMLInputElement).value).toBe(
      "https://a.example.org",
    )

    fireEvent.click(screen.getByRole("button", { name: "Save settings" }))
    expect(onSave.mock.calls[0][0]).toMatchObject({
      rpcs: { "1": { primary: "https://a.example.org" } },
      etherscan: { apiKey: "KEY1" },
    })
  })

  it("refuses an address the browser would block", () => {
    const onSave = vi.fn()
    render(<Panel onSave={onSave} />)

    fireEvent.change(screen.getByLabelText("Your primary RPC (optional)"), {
      target: { value: "http://rpc.example.org" },
    })
    fireEvent.click(screen.getByRole("button", { name: "Save settings" }))

    screen.getByText(/Plain http:\/\/ works only for a node on this computer/)
    expect(onSave).not.toHaveBeenCalled()
  })

  it("says when a key holds a character that cannot be sent", () => {
    const onSave = vi.fn()
    render(<Panel onSave={onSave} />)

    fireEvent.change(screen.getByLabelText("Safe Transaction Service API key (optional)"), {
      target: { value: "abc123\u200b" },
    })
    screen.getByText("The key contains a character that cannot be sent; paste it again.")
    fireEvent.click(screen.getByRole("button", { name: "Save settings" }))
    expect(onSave).not.toHaveBeenCalled()
  })

  it("saves the public indexers switch on its own", () => {
    const onSave = vi.fn()
    render(<Panel onSave={onSave} />)

    fireEvent.click(screen.getByRole("switch", { name: /Use public indexers \(Blockscout, Sourcify\)/ }))
    fireEvent.click(screen.getByRole("button", { name: "Save settings" }))

    expect(onSave.mock.calls[0][0]).toMatchObject({ publicIndexers: false, rpcs: {} })
  })

  it("says what turning the default RPCs off does, and what it does not", () => {
    render(<Panel />)
    fireEvent.click(screen.getByRole("checkbox", { name: "Also use the default RPCs" }))

    screen.getByText(/The Transaction Service and the public indexers follow their own switches below/)
    expect(screen.queryByText(/goes only to your RPCs/)).toBeNull()
  })

  it("takes focus when asked to show itself", () => {
    const { rerender } = render(<Panel />)
    expect(document.activeElement).toBe(document.body)

    rerender(<Panel focusRequest={1} />)
    expect(document.activeElement).toBe(screen.getByLabelText("Block (optional)"))
  })

  it("says plainly when a chain has no working default RPC", () => {
    render(<Panel chain={NO_RPC_CHAIN} />)

    screen.getByText(/Quiet Testnet has no working default RPC/)
  })
})
