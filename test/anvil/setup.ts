// Global setup of `npm run test:anvil`: builds every case's Safe on a fresh anvil per chain id, moves the state to a
// second anvil without anvil's zero-valued slots (see dropZeroSlots), and serves that one to the tests.
import { mkdirSync } from "node:fs"
import path from "node:path"
import type { TestProject } from "vitest/node"
import { type Anvil, buildHelpers, CACHE, dropZeroSlots, startAnvil } from "./anvil"
import { type Built, CASES } from "./cases"
import { Chain, CHAIN_IDS } from "./safes"

declare module "vitest" {
  export interface ProvidedContext {
    anvil: { urls: Record<keyof typeof CHAIN_IDS, string>; built: Record<string, Built> }
  }
}

// Fills `built` with the group's Safes ("<case> <version>") and returns the anvil that serves them.
export async function prepare(group: keyof typeof CHAIN_IDS, built: Record<string, Built>): Promise<Anvil> {
  mkdirSync(CACHE, { recursive: true })
  buildHelpers()
  const file = path.join(CACHE, `state-${CHAIN_IDS[group]}.json`)
  const build = await startAnvil(CHAIN_IDS[group], { dump: file })
  try {
    const chain = new Chain(build.url, CHAIN_IDS[group])
    await chain.init()
    for (const c of CASES.filter((c) => c.chain === group)) {
      for (const v of c.versions) built[`${c.name} ${v}`] = await c.build(chain, v)
    }
  } finally {
    await build.stop()
  }
  dropZeroSlots(file)
  const served = await startAnvil(CHAIN_IDS[group], { load: file })
  // The check pins latest - 3, so these blocks carry the cleaned state.
  await new Chain(served.url, CHAIN_IDS[group]).mine(5)
  return served
}

export default async function setup(project: TestProject) {
  const built: Record<string, Built> = {}
  const l1 = await prepare("l1", built)
  const l2 = await prepare("l2", built).catch(async (error) => {
    await l1.stop()
    throw error
  })
  project.provide("anvil", { urls: { l1: l1.url, l2: l2.url }, built })
  return async () => {
    await Promise.all([l1.stop(), l2.stop()])
  }
}
