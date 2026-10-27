// Smoke test of the built app on the fixture player, served with the headers from public/_headers.
import { expect, type Page, test } from "@playwright/test"

const GREEN = "0xAd219b3c26fe42BF5FC66F67490745a4fa5dff59"
const RED = "0x5afE5aFE5Afe5afe5aFe5afE5afE5aFE5afe0001"

type Watch = { shifts: { value: number; sources: string[] }[]; csp: string[] }

// Records layout shifts and CSP violations from the first byte on.
async function watch(page: Page) {
  await page.addInitScript(() => {
    const w = window as unknown as { __watch: Watch }
    w.__watch = { shifts: [], csp: [] }
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries() as (PerformanceEntry & {
        value: number
        sources?: { node?: Node | null }[]
      })[]) {
        const sources = (entry.sources ?? []).map((s) => {
          const r = s as unknown as { previousRect: DOMRect; currentRect: DOMRect; node?: Node | null }
          const node = r.node as Element | null | undefined
          return `${node?.nodeName ?? "?"} ${node?.textContent?.slice(0, 40) ?? ""} ${JSON.stringify(r.previousRect)} -> ${JSON.stringify(r.currentRect)} t=${Math.round(entry.startTime)}`
        })
        w.__watch.shifts.push({ value: entry.value, sources })
      }
    }).observe({ type: "layout-shift", buffered: true })
    document.addEventListener("securitypolicyviolation", (e) =>
      w.__watch.csp.push(`${e.violatedDirective} ${e.blockedURI}`),
    )
  })
  const errors: string[] = []
  page.on("console", (m) => m.type() === "error" && errors.push(m.text()))
  page.on("pageerror", (e) => errors.push(e.message))
  return {
    errors,
    read: () => page.evaluate(() => (window as unknown as { __watch: Watch }).__watch),
  }
}

const verdict = (page: Page, name: string) => page.getByRole("heading", { level: 2, name, exact: true })

const SELF = "0x5afE5AFe5afE5AfE5afe5Afe5AfE5aFe5afE0002"
const ZK = "0x5Afe5aFe5afe5AFE5AFE5aFE5aFE5AFE5AFe0324"
const VERDICTS = /^(Storage fully explained|Unexplained storage|Could not verify)$/

const STREAMS = [
  {
    name: "a green run",
    hash: `#/1/${GREEN}`,
    checking: "0xAd21…ff59 on Ethereum Mainnet",
    verdict: "Storage fully explained",
  },
  // Restarts after a reorg: the partial report is cleared and streams in again.
  { name: "a restarted run", hash: `#/100/${RED}`, checking: "0x5afE…0001 on Gnosis", verdict: "Could not verify" },
]

for (const stream of STREAMS) {
  test(`${stream.name} streams in without moving anything on screen`, async ({ page }) => {
    // Tall enough that every part of the page is in view, so any shift would count.
    await page.setViewportSize({ width: 400, height: 6000 })
    const watched = await watch(page)
    await page.goto(`/e2e/fixture.html?speed=1${stream.hash}`)

    await expect(page.getByRole("heading", { name: `Checking ${stream.checking}` })).toBeVisible()
    await expect(verdict(page, stream.verdict)).toBeVisible({ timeout: 20_000 })
    await expect(page.getByRole("region", { name: "Storage slots" })).toContainText(/Owner list|owner list/)

    const { shifts, csp } = await watched.read()
    expect(shifts).toEqual([])
    expect(csp).toEqual([])
    expect(watched.errors).toEqual([])
  })
}

test("works at 400 px in the current color scheme", async ({ page }, info) => {
  const watched = await watch(page)
  await page.goto(`/e2e/fixture.html?speed=4#/1/${RED}`)
  await expect(verdict(page, "Unexplained storage")).toBeVisible({ timeout: 20_000 })

  // Wide tables scroll inside their own box; the page itself never scrolls sideways.
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(400)
  const storage = page.getByRole("region", { name: "Storage slots" })
  expect(await storage.evaluate((el) => el.scrollWidth > el.clientWidth)).toBe(true)

  const background = await page.evaluate(() => getComputedStyle(document.body).backgroundColor)
  if (info.project.name === "dark") expect(background).not.toBe("rgb(255, 255, 255)")
  else expect(background).toBe("rgb(255, 255, 255)")

  const { shifts, csp } = await watched.read()
  expect(shifts).toEqual([])
  expect(csp).toEqual([])
  expect(watched.errors).toEqual([])
})

// The banner keeps one height; nothing in it may be cut off without a way to see it.
for (const hash of [
  `#/1/${GREEN}`,
  `#/1/${RED}`,
  `#/1/${SELF}`,
  `#/100/${RED}`,
  `#/324/${ZK}`,
  `#/1/${GREEN}@26000000`,
]) {
  test(`the banner hides nothing at 400 px for ${hash}`, async ({ page }) => {
    await page.goto(`/e2e/fixture.html?speed=8${hash}`)
    await expect(page.getByRole("heading", { level: 2, name: VERDICTS })).toBeVisible({ timeout: 20_000 })
    const r = await page.evaluate(() => {
      const banner = document.getElementById("verdict-title")!.closest("section")!
      const box = banner.getBoundingClientRect()
      const clipped = Array.from(banner.querySelectorAll("*"))
        .filter((e) => e.scrollHeight > e.clientHeight + 1 && getComputedStyle(e).overflowY === "hidden")
        .map((e) => e.tagName)
      const outside = Array.from(banner.querySelectorAll("h2, p, button"))
        .filter((e) => e.getBoundingClientRect().bottom > box.bottom + 1)
        .map((e) => e.textContent)
      const list = banner.querySelector('ul[aria-label="Reasons"]')
      const overflows = list ? list.scrollHeight > list.clientHeight + 1 : false
      const hint = Array.from(banner.querySelectorAll("p")).some((p) => p.textContent?.startsWith("More below"))
      return { clipped, outside, overflows, hint, listFocusable: list?.getAttribute("tabindex") === "0" }
    })
    expect(r.clipped).toEqual([])
    expect(r.outside).toEqual([])
    if (r.overflows) expect(r).toMatchObject({ hint: true, listFocusable: true })
  })
}

test("reasons that do not fit the banner scroll, with a hint and keyboard access", async ({ page }) => {
  await page.goto(`/e2e/fixture.html?speed=8#/1/${SELF}`)
  await expect(verdict(page, "Storage fully explained")).toBeVisible({ timeout: 20_000 })
  const list = page.getByRole("list", { name: "Reasons" })
  await expect(page.getByText("More below; scroll the list.")).toBeVisible()

  await list.focus()
  for (let i = 0; i < 10; i++) await page.keyboard.press("ArrowDown")
  await expect(page.getByText("More below; scroll the list.")).toHaveCount(0)
  await expect(list.getByText(/^No event for the fallback handler/)).toBeInViewport()
})

test("Stop keeps what was proven as a partial result, with both downloads", async ({ page }) => {
  await page.goto(`/e2e/fixture.html?speed=0.5#/1/${GREEN}`)
  await expect(page.getByRole("heading", { level: 2, name: /^Owners/ })).toBeVisible({ timeout: 20_000 })
  await page.getByRole("button", { name: "Stop" }).click()

  await expect(page.getByRole("heading", { level: 2, name: "Stopped: partial result" })).toBeVisible()
  await expect(page.getByRole("button", { name: "Download JSON report" })).toBeEnabled()
  await expect(page.getByRole("button", { name: "Copy Markdown summary" })).toBeEnabled()
  await expect(page.getByRole("heading", { level: 2, name: /^Owners/ })).toBeVisible()
})

test("a stop message with a long address wraps inside the banner at 400 px", async ({ page }) => {
  await page.goto("/e2e/fixture.html?speed=8#/1/0x1111111111111111111111111111111111111111")
  const banner = page
    .getByRole("heading", { level: 2, name: "No Safe at this address" })
    .locator("xpath=ancestor::section")
  await expect(banner).toBeVisible({ timeout: 20_000 })
  const message = banner.getByText(/There is no account at/)
  const fits = await message.evaluate((el) => {
    const box = el.closest("section")!.getBoundingClientRect()
    const text = el.getBoundingClientRect()
    return el.scrollWidth <= el.clientWidth && text.right <= box.right && text.left >= box.left
  })
  expect(fits).toBe(true)
})

test("a past-block link says so and checks the latest block on request", async ({ page }) => {
  await page.goto(`/e2e/fixture.html?speed=8#/1/${GREEN}@26000000`)
  await expect(page.getByText(/This is the state at block 26000000, not the current state\./)).toBeVisible({
    timeout: 20_000,
  })
  await page.getByRole("button", { name: "Check the latest block" }).click()
  await expect(verdict(page, "Storage fully explained")).toBeVisible({ timeout: 20_000 })
  await expect(page.getByText(/not the current state/)).toHaveCount(0)
})

test("the verdict is announced and takes focus when the run ends", async ({ page }) => {
  await page.goto("/e2e/fixture.html?speed=8")
  await page.getByLabel("Safe address").fill(GREEN)
  await page.getByRole("combobox").fill("Ethereum")
  await page.keyboard.press("Enter")
  await page.getByRole("button", { name: "Check" }).click()

  await expect(verdict(page, "Storage fully explained")).toBeFocused({ timeout: 20_000 })
  await expect(page.getByRole("status").filter({ hasText: /^Check finished: Storage fully explained\./ })).toHaveCount(
    1,
  )
})

test("Open RPC settings from a problem shows the settings and moves focus there", async ({ page }) => {
  await page.goto(`/e2e/fixture.html?speed=8#/100/${RED}`)
  await expect(verdict(page, "Could not verify")).toBeVisible({ timeout: 20_000 })
  const open = page.getByRole("button", { name: "Open RPC settings" }).last()
  await open.scrollIntoViewIfNeeded()
  await open.click()

  const form = page.getByRole("form", { name: "Settings" })
  await expect(form).toBeInViewport()
  expect(await form.evaluate((f) => f.contains(document.activeElement))).toBe(true)
})

test("the chain picker keeps the active option in view", async ({ page }) => {
  await page.goto("/e2e/fixture.html")
  const box = page.getByRole("combobox")
  await box.focus()
  for (let i = 0; i < 17; i++) await page.keyboard.press("ArrowDown")
  const id = await box.getAttribute("aria-activedescendant")
  await expect(page.locator(`[id="${id}"]`)).toBeInViewport()
  const inList = await page.evaluate((id) => {
    const option = document.getElementById(id!)!.getBoundingClientRect()
    const list = document.querySelector('[role="listbox"]')!.getBoundingClientRect()
    return option.top >= list.top - 1 && option.bottom <= list.bottom + 1
  }, id)
  expect(inList).toBe(true)
})

test("the whole check works from the keyboard", async ({ page }) => {
  await page.goto("/e2e/fixture.html?speed=4")

  await page.keyboard.press("Tab")
  await expect(page.getByLabel("Safe address")).toBeFocused()
  await page.keyboard.type(RED)
  await page.keyboard.press("Tab")
  await expect(page.getByRole("combobox")).toBeFocused()
  await page.keyboard.type("Ethereum")
  await page.keyboard.press("Enter")
  await expect(page.getByRole("combobox")).toHaveValue("Ethereum Mainnet (1)")
  await page.keyboard.press("Tab")
  await expect(page.getByRole("button", { name: "Check" })).toBeFocused()
  await page.keyboard.press("Enter")

  await expect(verdict(page, "Unexplained storage")).toBeFocused({ timeout: 20_000 })
  const findings = page.getByRole("button", { name: /^Show all \d+ findings$/ })
  for (let i = 0; i < 10 && !(await findings.evaluate((el) => el === document.activeElement)); i++) {
    await page.keyboard.press("Tab")
  }
  await expect(findings).toBeFocused()
  expect(await findings.evaluate((el) => getComputedStyle(el).outlineStyle)).not.toBe("none")
  await page.keyboard.press("Enter")
  await expect(page.getByRole("region", { name: "All findings" })).toContainText(
    "Storage the configuration does not explain",
  )

  // A wide table is reachable and scrollable from the keyboard.
  const storage = page.getByRole("region", { name: "Storage slots" })
  await storage.focus()
  await page.keyboard.press("ArrowRight")
  await expect.poll(() => storage.evaluate((el) => el.scrollLeft)).toBeGreaterThan(0)
})

test("copies the Markdown summary under the site's permissions policy", async ({ page, context }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"])
  await page.goto(`/e2e/fixture.html?speed=4#/1/${GREEN}`)
  await expect(verdict(page, "Storage fully explained")).toBeVisible({ timeout: 20_000 })

  await page.getByRole("button", { name: "Copy Markdown summary" }).click()
  // With clipboard-write blocked the app would show the text to copy by hand instead.
  await expect(page.getByRole("button", { name: "Markdown copied" })).toBeVisible()
  await expect(page.getByText("The browser did not allow copying.", { exact: false })).toHaveCount(0)
})
