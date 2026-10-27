import { beforeAll, describe, expect, it } from "vitest"
import { inline, issueHeadline, reportToMarkdown, visibleIssues } from "@/core/markdown"
import type { PendingSection, Report } from "@/core/report"
import { pipelineB3, pipelineGreen, pipelineShadowOwner } from "@/ui/__fixtures__/pipeline"
import { FIXTURE_REPORTS, greenReport, issue, issuesByKind } from "@/ui/__fixtures__/reports"

const sectionOf = (markdown: string, title: string) => markdown.split(`## ${title}`)[1]?.split("\n## ")[0] ?? ""

describe("reportToMarkdown over real pipeline runs", () => {
  const runs: Record<string, Report> = {}
  beforeAll(async () => {
    runs.green = (await pipelineGreen()).report
    runs.b3 = (await pipelineB3()).report
    runs.shadowOwner = (await pipelineShadowOwner()).report
  })

  for (const name of ["green", "b3", "shadowOwner"]) {
    it(`matches the snapshot for the pipeline's ${name} report`, () => {
      expect(reportToMarkdown(runs[name])).toMatchSnapshot()
    })
  }
})

describe("reportToMarkdown", () => {
  for (const [name, report] of Object.entries(FIXTURE_REPORTS)) {
    it(`matches the snapshot for the ${name} report`, () => {
      expect(reportToMarkdown(report)).toMatchSnapshot()
    })
  }

  it("leads with the verdict, the Safe and the block with its time", () => {
    const lines = reportToMarkdown(greenReport).split("\n")

    expect(lines[0]).toBe("# Safe State Check: Storage fully explained")
    expect(lines).toContain("- Safe: `0xAd219b3c26fe42BF5FC66F67490745a4fa5dff59` on Ethereum Mainnet (chain 1)")
    expect(lines).toContain(
      "- Block: 26176126, 2026-10-12 11:34:47 UTC, hash `0xbca7f5c0cd31c75f3e3221c076713002cf9952022b18060c16f4eeedf35ea119`",
    )
    expect(lines).toContain("- Findings: 0 critical, 0 high, 1 medium, 1 info")
  })

  it("says plainly when the block is not the current state", () => {
    const anchor = { ...greenReport.verification.anchor, pinnedBy: "user" as const }
    const old: Report = { ...greenReport, verification: { ...greenReport.verification, anchor } }

    expect(reportToMarkdown(old)).toContain(
      "- This is the state at block 26176126 (2026-10-12 11:34:47 UTC), not the current state.",
    )
    expect(reportToMarkdown(greenReport)).not.toContain("not the current state")
  })

  it("says when the block was checked against the user's own RPC only", () => {
    const markdown = reportToMarkdown(FIXTURE_REPORTS.selfTrusted)

    expect(markdown).toContain("- Trust: Verified against your own RPC only (no independent cross-check).")
    expect(reportToMarkdown(greenReport)).not.toContain("- Trust:")
  })

  it("says when both RPCs are ones the user entered", () => {
    const user = { origin: "user" as const }
    const verification = {
      ...greenReport.verification,
      primary: { ...greenReport.verification.primary, ...user, host: "a.example.org" },
      crossCheck: { ...greenReport.verification.crossCheck!, ...user, host: "b.example.org" },
    }

    expect(reportToMarkdown({ ...greenReport, verification })).toContain(
      "- RPCs: Both RPCs are ones you entered (a.example.org and b.example.org); no default RPC confirmed this block.",
    )
  })

  it("lists unrecovered problems with the RPC role and host, and leaves out recovered ones", () => {
    const report: Report = {
      ...greenReport,
      issues: [
        issue("timeout", { role: "cross-check", host: "rpc.example.org", operation: "read block 26176126" }),
        issue("rate-limited", { recovered: true }),
      ],
    }
    const problems = sectionOf(reportToMarkdown(report), "Problems during the run")

    expect(problems).toContain("- Cross-check RPC rpc.example.org could not read block 26176126:")
    expect(problems).not.toContain("eth.drpc.org")
    expect(problems.split("\n").filter((line) => line.startsWith("- "))).toHaveLength(1)
  })

  it("prints identity, pin mode and Zodiac details a reviewer pastes for", () => {
    const markdown = reportToMarkdown(greenReport)

    expect(sectionOf(markdown, "Safe contract")).toContain("VERSION() returns `1.4.1`")
    expect(markdown).toContain("- Pinned to a recent block (latest minus 3).")
    expect(sectionOf(markdown, "Modules")).toContain("template 5, timeout 259200 s")
  })

  it("agrees with the page on pending actions, offchain messages and delegates included", () => {
    const base = (greenReport.pending as { data: PendingSection }).data
    const pending: Report["pending"] = {
      state: "complete",
      data: {
        ...base,
        messages: [{ hash: `0x${"ab".repeat(32)}`, confirmations: 2, created: "2026-10-01T00:00:00Z" }],
        delegates: [
          {
            delegate: "0x1111111111111111111111111111111111111111",
            delegator: "0x2222222222222222222222222222222222222222",
            label: "proposer",
          },
        ],
      },
    }
    const section = sectionOf(reportToMarkdown({ ...greenReport, pending }), "Pending actions")

    expect(section).not.toContain("None found.")
    expect(section).toContain(`- Offchain message \`0x${"ab".repeat(32)}\`, 2 signatures`)
    expect(section).toContain("(proposer)")
  })

  it("escapes table cells", () => {
    const report: Report = {
      ...greenReport,
      cards: [{ id: "version", label: "Version", value: "a|b", detail: "line one\nline two", tone: "ok" }],
    }

    expect(reportToMarkdown(report)).toContain("| Version | a\\|b | line one line two |")
  })

  // Text from an RPC answer or a contract's return value must not add headings, links, HTML, comments or escapes.
  it("cannot be steered by text from an RPC or a contract", () => {
    const hostile = "x\n# Fake\n[a](https://evil.example)\n<!-- <img src=x> `tick` \u001b[31m"
    const withText = (text: string): Report => ({
      ...greenReport,
      verdict: { ...greenReport.verdict, headline: text, reasons: [text] },
      findings: greenReport.findings.map((f) => ({ ...f, technical: text })),
      issues: [issue("unknown", { explanation: text, operation: text })],
      notChecked: [text],
    })
    const plain = reportToMarkdown(withText("plain"))
    const markdown = reportToMarkdown(withText(hostile))
    // Code spans are literal in Markdown, so only text outside them can act.
    const outsideCode = markdown.replace(/(`+)[^`]*?\1/g, "")

    const headings = (text: string) => text.split("\n").filter((line) => /^#{1,6} /.test(line))
    expect(headings(markdown)).toEqual(headings(plain))
    expect(markdown.split("\n").length).toBe(plain.split("\n").length)
    expect(outsideCode).not.toMatch(/(?<!\\)[[\]<>!`]/)
    expect(markdown).not.toMatch(/\p{Cc}(?<!\n)/u)
  })
})

describe("inline", () => {
  it("turns line breaks and control characters into spaces and escapes Markdown and HTML", () => {
    expect(inline("a\nb\u2028c\u0007d")).toBe("a b c d")
    expect(inline("[x](y) <b> *e* `c` #h !i ~t |p _u \\")).toBe(
      "\\[x\\](y) \\<b\\> \\*e\\* \\`c\\` \\#h \\!i \\~t \\|p \\_u \\\\",
    )
  })
})

describe("issueHeadline", () => {
  it("names the RPC role and host", () => {
    expect(issueHeadline(issuesByKind.unreachable)).toMatch(
      /^Primary RPC eth\.drpc\.org could not read the storage proof of the Safe: /,
    )
  })

  it("names an API service by name", () => {
    expect(issueHeadline(issuesByKind["key-required"])).toMatch(
      /^Etherscan API api\.etherscan\.io could not read the storage proof of the Safe: /,
    )
  })

  it("hides cancelled runs", () => {
    expect(visibleIssues([issuesByKind.cancelled, issuesByKind.timeout])).toEqual([issuesByKind.timeout])
  })
})
