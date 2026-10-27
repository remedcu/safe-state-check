// Real runs of src/check over the pipeline's fake data layer (appendix B slot maps and a fixture registry), so UI tests,
// Markdown snapshots and the end-to-end page show exactly what the pipeline produces.
import { FIXTURES } from "@/core/__tests__/fixtures/appendixB"
import { REGISTRY } from "@/core/__tests__/fixtures/registry"
import type { CheckEvent, CheckRequest, Report } from "@/core/report"
import { B1_SAFE, B3_SAFE, b1World, b3World, fakeDeps, type FakeWorld, withStorage } from "@/check/__tests__/fakeDeps"
import { runCheck } from "@/check/run"

export type PipelineRun = { report: Report; events: CheckEvent[] }

// Ten seconds after the fake anchor block, as a check at latest minus 3 would be.
const NOW = () => new Date("2026-10-12T00:00:10.000Z")

export async function pipelineRun(world: FakeWorld, request: CheckRequest): Promise<PipelineRun> {
  const { deps } = fakeDeps(world)
  const events: CheckEvent[] = []
  const report = await runCheck(request, deps, (event) => events.push(event), { registry: REGISTRY, now: NOW })
  if (report === null) throw new Error("the fixture run stopped")
  return { report, events }
}

// Appendix B1: the Reward Distribution Safe, green.
export const pipelineGreen = () => pipelineRun(b1World(), { address: B1_SAFE, chainId: 1, block: null })

// Appendix B3: the SEF Safe on 1.5.0, green.
export const pipelineB3 = () => pipelineRun(b3World(), { address: B3_SAFE, chainId: 1, block: null })

// Appendix B1-neg: B1 plus a shadow owner nobody can name, red.
export const pipelineShadowOwner = () =>
  pipelineRun(
    withStorage(b1World(), B1_SAFE, (entries) => [...entries, ...FIXTURES[1].entries.slice(-1)]),
    { address: B1_SAFE, chainId: 1, block: null },
  )
