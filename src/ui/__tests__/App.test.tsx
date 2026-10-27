import { cleanup, fireEvent, render, screen, within } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { SETTINGS_STORAGE_KEY } from "@/data/types"
import { fixtureDeps } from "@/ui/__fixtures__/player"
import { GREEN_SAFE, issue, RED_SAFE } from "@/ui/__fixtures__/reports"
import App from "@/ui/App"

function memoryStorage() {
  const items = new Map<string, string>()
  return {
    getItem: (key: string) => items.get(key) ?? null,
    setItem: (key: string, value: string) => items.set(key, value),
  }
}

let storage = memoryStorage()
const deps = (speed = 1000) => fixtureDeps({ storage, speed })

const address = () => screen.getByLabelText("Safe address")
const check = () => fireEvent.click(screen.getByRole("button", { name: "Check" }))
const verdict = (name: string) => screen.findByRole("heading", { level: 2, name }, { timeout: 5000 })

beforeEach(() => {
  storage = memoryStorage()
  window.history.replaceState(null, "", "/")
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe("App", () => {
  it("renders the title", () => {
    render(<App deps={deps()} />)

    screen.getByRole("heading", { level: 1, name: "Safe State Check" })
  })

  it("finds the chain from the address alone and runs the check", async () => {
    render(<App deps={deps()} />)
    fireEvent.change(address(), { target: { value: GREEN_SAFE } })
    check()

    await screen.findByRole("heading", { name: /Looking for this Safe/ })
    await verdict("Storage fully explained")
    expect(window.location.hash).toBe(`#/1/${GREEN_SAFE}`)
  })

  it("asks which chain when the address is a Safe on several", async () => {
    render(<App deps={deps()} />)
    fireEvent.change(address(), { target: { value: RED_SAFE } })
    check()

    fireEvent.click(await screen.findByRole("button", { name: "Gnosis (Safe 1.4.1)" }))
    await verdict("Could not verify")
  })

  it("offers to search every chain when no Safe is found", async () => {
    render(<App deps={deps()} />)
    fireEvent.change(address(), { target: { value: "0x0000000000000000000000000000000000000abc" } })
    check()

    await screen.findByText(/No Safe at this address on the 3 chains tried/)
    screen.getByText("This sends the address to the default RPC of all 3 chains that have one.")
    fireEvent.click(screen.getByRole("button", { name: "Search all chains" }))
    await screen.findByRole("heading", { name: /every chain with a default RPC/ })
  })

  it("explains an address with a bad checksum", () => {
    render(<App deps={deps()} />)
    fireEvent.change(address(), { target: { value: GREEN_SAFE.replace("Ad21", "aD21") } })
    check()

    expect(screen.getByRole("alert").textContent).toMatch(/^The capital letters do not match the address checksum/)
  })

  it("refuses an address whose chain differs from the picked one", () => {
    render(<App deps={deps()} />)
    pickChain("gno")
    fireEvent.change(address(), { target: { value: `eth:${GREEN_SAFE}` } })
    check()

    expect(screen.getByRole("alert").textContent).toBe(
      "The address names Ethereum Mainnet, but the chain picker says Gnosis. Clear one of them.",
    )
  })

  it("asks for an RPC on a chain without a working default one", () => {
    render(<App deps={deps()} />)
    pickChain("quiet")

    screen.getByText(/No public RPC that we tested works for Quiet Testnet/)
    fireEvent.change(address(), { target: { value: GREEN_SAFE } })
    check()
    expect(screen.getByRole("alert").textContent).toMatch(/Quiet Testnet has no working default RPC/)
    screen.getByRole("form", { name: "Settings" })
  })

  it("starts from a permalink without asking for the chain", async () => {
    window.history.replaceState(null, "", `/#/1/${RED_SAFE}`)
    render(<App deps={deps()} />)

    screen.getByRole("heading", { name: /Checking 0x5afE…0001 on/ })
    await verdict("Unexplained storage")
    expect(screen.queryByRole("heading", { name: /Looking for this Safe/ })).toBeNull()
  })

  it("stops a run on request", async () => {
    render(<App deps={deps(1)} />)
    fireEvent.change(address(), { target: { value: `eth:${GREEN_SAFE}` } })
    check()
    fireEvent.click(await screen.findByRole("button", { name: "Stop" }))

    screen.getByRole("heading", { name: "Check stopped" })
  })

  it("saves settings in the browser's storage", () => {
    render(<App deps={deps()} />)
    pickChain("eth")
    fireEvent.click(screen.getByRole("button", { name: "Settings" }))
    // Operators by name, not by id.
    screen.getByText(/^dRPC, serves storage proofs/)
    fireEvent.change(screen.getByLabelText("Your primary RPC (optional)"), {
      target: { value: "https://node.example.org/KEY" },
    })
    fireEvent.click(screen.getByRole("button", { name: "Save settings" }))

    expect(JSON.parse(storage.getItem(SETTINGS_STORAGE_KEY)!).rpcs["1"].primary).toBe("https://node.example.org/KEY")
  })

  it("copies the Markdown summary, or shows it when the browser refuses", async () => {
    const writeText = vi.fn().mockRejectedValueOnce(new Error("denied")).mockResolvedValue(undefined)
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true })
    render(<App deps={deps()} />)
    fireEvent.change(address(), { target: { value: `eth:${GREEN_SAFE}` } })
    check()
    await verdict("Storage fully explained")

    fireEvent.click(screen.getByRole("button", { name: "Copy Markdown summary" }))
    const fallback = (await screen.findByLabelText(/The browser did not allow copying/)) as HTMLTextAreaElement
    expect(fallback.value).toMatch(/^# Safe State Check: Storage fully explained/)

    fireEvent.click(screen.getByRole("button", { name: "Copy Markdown summary" }))
    await screen.findByRole("button", { name: "Markdown copied" })
    expect(writeText).toHaveBeenLastCalledWith(fallback.value)
  })

  it("downloads the JSON report", async () => {
    const createObjectURL = vi.fn().mockReturnValue("blob:report")
    Object.assign(URL, { createObjectURL, revokeObjectURL: vi.fn() })
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {})
    render(<App deps={deps()} />)
    fireEvent.change(address(), { target: { value: `eth:${GREEN_SAFE}` } })
    check()
    await verdict("Storage fully explained")

    fireEvent.click(screen.getByRole("button", { name: "Download JSON report" }))
    const blob = createObjectURL.mock.calls[0][0] as Blob
    expect(JSON.parse(await blob.text()).request.address).toBe(GREEN_SAFE)
    expect((click.mock.contexts[0] as HTMLAnchorElement).download).toBe(
      `safe-state-check-1-${GREEN_SAFE}-26176126.json`,
    )
  })
})

describe("App, after review", () => {
  it("says when testing candidates fails, naming the RPC", async () => {
    window.history.replaceState(null, "", `/#/1/${RED_SAFE}`)
    const failure = Object.assign(new Error("boom"), { issue: issue("timeout", { operation: "read the candidates" }) })
    render(<App deps={{ ...deps(), testCandidates: () => Promise.reject(failure) }} />)
    await verdict("Unexplained storage")

    fireEvent.change(screen.getByLabelText(/Test your own guesses/), {
      target: { value: "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC" },
    })
    fireEvent.click(screen.getByRole("button", { name: "Test candidates" }))

    expect((await screen.findByRole("alert")).textContent).toMatch(
      /^Testing the candidates failed\. Primary RPC eth\.drpc\.org could not read the candidates: /,
    )
  })

  it("keeps the chain search results when one chain fails, says why, and offers the Safes found", async () => {
    const base = deps()
    const detectChains: typeof base.detectChains = async (_address, options) => {
      options.onResult?.({ chainId: 1, status: "safe", singleton: null, version: "1.4.1", issue: null })
      throw new Error('InvalidAddressError: Address "0x0x" is invalid.')
    }
    render(<App deps={{ ...base, detectChains }} />)
    fireEvent.change(address(), { target: { value: GREEN_SAFE } })
    check()

    expect((await screen.findByRole("alert")).textContent).toMatch(/^The search ended before every chain answered\./)
    screen.getByRole("button", { name: "Ethereum Mainnet (Safe 1.4.1)" })
  })

  it("stops a chain search on request", async () => {
    render(<App deps={deps(1)} />)
    fireEvent.change(address(), { target: { value: GREEN_SAFE } })
    check()
    fireEvent.click(await screen.findByRole("button", { name: "Stop" }))

    screen.getByText(/You stopped the search\./)
    screen.getByRole("heading", { name: "Chain search finished" })
  })

  it("opens the settings from a problem and moves focus into them", async () => {
    window.history.replaceState(null, "", `/#/100/${RED_SAFE}`)
    render(<App deps={deps()} />)
    await verdict("Could not verify")

    fireEvent.click(screen.getAllByRole("button", { name: "Open RPC settings" }).at(-1)!)
    const form = screen.getByRole("form", { name: "Settings" })
    expect(form.contains(document.activeElement)).toBe(true)
  })

  it("checks the latest block from a past-block link", async () => {
    window.history.replaceState(null, "", `/#/1/${GREEN_SAFE}@26000000`)
    render(<App deps={deps()} />)
    await verdict("Storage fully explained")
    screen.getByText(/This is the state at block 26000000, not the current state\./)

    fireEvent.click(screen.getByRole("button", { name: "Check the latest block" }))
    await verdict("Storage fully explained")
    expect(screen.queryByText(/not the current state/)).toBeNull()
    expect(window.location.hash).toBe(`#/1/${GREEN_SAFE}`)
  })

  it("names where the address goes for the current settings", () => {
    render(<App deps={deps()} />)
    const note = () => screen.getByText(/^Privacy:/).textContent

    expect(note()).toMatch(/the default RPCs of the 3 most used chains, to find the chain/)
    pickChain("eth")
    expect(note()).toMatch(
      /the default RPCs for Ethereum Mainnet; the Safe Transaction Service \(api\.safe\.global\); Blockscout \(eth\.blockscout\.com\) and Sourcify/,
    )

    fireEvent.click(screen.getByRole("button", { name: "Settings" }))
    fireEvent.click(screen.getByRole("switch", { name: /Use public indexers/ }))
    fireEvent.click(screen.getByRole("switch", { name: /Use the Safe Transaction Service/ }))
    fireEvent.click(screen.getByRole("button", { name: "Save settings" }))
    expect(note()).not.toMatch(/Blockscout|Transaction Service \(/)
  })

  it("keeps an unsaved API key in the open settings when the address names a chain", () => {
    render(<App deps={deps()} />)
    fireEvent.click(screen.getByRole("button", { name: "Settings" }))
    fireEvent.change(screen.getByLabelText("Etherscan API key (optional)"), { target: { value: "MYKEY" } })
    fireEvent.change(address(), { target: { value: `eth:${GREEN_SAFE}` } })

    expect((screen.getByLabelText("Etherscan API key (optional)") as HTMLInputElement).value).toBe("MYKEY")
  })

  it("does not call a newer report copied", async () => {
    Object.defineProperty(navigator, "clipboard", { value: { writeText: vi.fn() }, configurable: true })
    window.history.replaceState(null, "", `/#/1/${RED_SAFE}`)
    render(<App deps={deps()} />)
    await verdict("Unexplained storage")

    fireEvent.click(screen.getByRole("button", { name: "Copy Markdown summary" }))
    await screen.findByRole("button", { name: "Markdown copied" })
    fireEvent.change(screen.getByLabelText(/Test your own guesses/), {
      target: { value: "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC" },
    })
    fireEvent.click(screen.getByRole("button", { name: "Test candidates" }))
    await screen.findByText(/Tried so far: 0x3C44/)
    screen.getByRole("button", { name: "Copy Markdown summary" })
  })

  it("gives a candidate test a signal that a new check aborts", async () => {
    window.history.replaceState(null, "", `/#/1/${RED_SAFE}`)
    const signals: (AbortSignal | undefined)[] = []
    const base = deps()
    const testCandidates: typeof base.testCandidates = (...args) => {
      const signal = args[4]
      signals.push(signal)
      return new Promise(() => {})
    }
    render(<App deps={{ ...base, testCandidates }} />)
    await verdict("Unexplained storage")
    fireEvent.change(screen.getByLabelText(/Test your own guesses/), {
      target: { value: "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC" },
    })
    fireEvent.click(screen.getByRole("button", { name: "Test candidates" }))
    expect(signals[0]?.aborted).toBe(false)

    fireEvent.change(address(), { target: { value: `eth:${GREEN_SAFE}` } })
    check()
    expect(signals[0]?.aborted).toBe(true)
  })

  it("shows the other-chains result in the report", async () => {
    window.history.replaceState(null, "", `/#/1/${RED_SAFE}`)
    render(<App deps={deps()} />)
    await verdict("Unexplained storage")

    fireEvent.click(screen.getByRole("button", { name: "Check other chains" }))
    const table = await screen.findByRole("region", { name: "Other chains" })
    within(table).getByText("Gnosis (100)")
  })
})

function pickChain(query: string) {
  const picker = screen.getByRole("combobox")
  fireEvent.change(picker, { target: { value: query } })
  fireEvent.keyDown(picker, { key: "Enter" })
}

describe("ChainPicker", () => {
  it("keeps the picked chain when Enter is pressed on a search that matches nothing", () => {
    render(<App deps={deps()} />)
    pickChain("gno")
    const picker = screen.getByRole("combobox")

    fireEvent.change(picker, { target: { value: "zzz" } })
    expect(picker.getAttribute("aria-activedescendant")).toBeNull()
    fireEvent.keyDown(picker, { key: "Enter" })
    screen.getByRole("listbox")
    fireEvent.keyDown(picker, { key: "Escape" })
    expect((picker as HTMLInputElement).value).toBe("Gnosis (100)")
  })

  it("filters by name, short name or id and is driven by the keyboard", () => {
    render(<App deps={deps()} />)
    const picker = screen.getByRole("combobox")

    fireEvent.change(picker, { target: { value: "100" } })
    const list = screen.getByRole("listbox")
    expect(
      within(list)
        .getAllByRole("option")
        .map((o) => o.textContent),
    ).toEqual(["Find automatically", "Gnosis 100"])
    expect(picker.getAttribute("aria-activedescendant")).toBe(within(list).getAllByRole("option")[1].id)

    fireEvent.keyDown(picker, { key: "ArrowUp" })
    fireEvent.keyDown(picker, { key: "ArrowUp" })
    fireEvent.keyDown(picker, { key: "Enter" })
    expect((picker as HTMLInputElement).value).toBe("Gnosis (100)")

    fireEvent.keyDown(picker, { key: "ArrowDown" })
    fireEvent.keyDown(picker, { key: "Escape" })
    expect(screen.queryByRole("listbox")).toBeNull()
    expect((picker as HTMLInputElement).value).toBe("Gnosis (100)")
  })

  it("marks chains where the storage check cannot run", () => {
    render(<App deps={deps()} />)
    fireEvent.change(screen.getByRole("combobox"), { target: { value: "zk" } })

    within(screen.getByRole("option", { name: /zkSync/ })).getByText("storage check not supported")
  })
})
