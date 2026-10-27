// Network helpers for the generators: a generic User-Agent, a timeout, and global and per-key concurrency limits.
import { createHash } from "node:crypto"
import { NODE_USER_AGENT } from "@/data/constants"

// Browser-shaped but generic, the same the CLI sends: Blockscout on Base, Arbitrum and Polygon answers 403 to
// non-browser User-Agents, while a real browser gets 200 with CORS.
export const USER_AGENT = NODE_USER_AGENT

export class Limiter {
  private active = 0
  private readonly queue: (() => void)[] = []
  private readonly max: number

  constructor(max: number) {
    this.max = max
  }

  async run<T>(work: () => Promise<T>): Promise<T> {
    if (this.active >= this.max) await new Promise<void>((resolve) => this.queue.push(resolve))
    this.active++
    try {
      return await work()
    } finally {
      this.active--
      this.queue.shift()?.()
    }
  }
}

// One limiter per key (an operator), taken before the global one so queued requests for a busy operator do not hold
// global slots.
export class KeyedLimiter {
  private readonly limiters = new Map<string, Limiter>()
  private readonly global: Limiter
  private readonly perKey: number

  constructor(global: number, perKey: number) {
    this.global = new Limiter(global)
    this.perKey = perKey
  }

  run<T>(key: string, work: () => Promise<T>): Promise<T> {
    let limiter = this.limiters.get(key)
    if (!limiter) this.limiters.set(key, (limiter = new Limiter(this.perKey)))
    return limiter.run(() => this.global.run(work))
  }
}

export function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex")
}

export const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
