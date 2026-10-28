// The start page around the input: what the check asks, how it answers, and where it stops. A run replaces it.
import { NOT_CHECKED } from "@/core/scope"

export function Hero() {
  return (
    <div className="flex flex-col gap-4 pt-6 pb-4 sm:gap-5 sm:pt-16 sm:pb-6">
      <h2 className="max-w-[16ch] text-[40px] leading-[46px] font-semibold tracking-[-0.01em] sm:max-w-none sm:text-[52px] sm:leading-[60px]">
        Is anything hidden in this Safe?
      </h2>
      <p className="max-w-[42rem] text-[17px] leading-7 sm:text-[19px] sm:leading-[30px]">
        Paste a Safe address. The check rebuilds its storage root from the owners, modules and settings you can see, and
        compares it with the root the chain proves. If they match, the Safe stores nothing else.
      </p>
      <p className="text-sm text-muted-foreground">
        Runs in your browser against public RPCs or your own. No backend, no wallet connection.
      </p>
    </div>
  )
}

const STEPS = [
  "Read the owners, modules and settings",
  "Rebuild the storage root from them",
  "Prove the real root with eth_getProof",
]

// Same form as NOT_CHECKED: a short lead sentence, then the detail.
const CHECKS = [
  "Storage root. Rebuilt from the configuration, proven with eth_getProof.",
  "Code. The proxy and singleton are known Safe releases, 1.3.0 to 1.5.0.",
  "Owners. Plain account, EIP-7702 delegated account, Safe or other contract.",
  "Modules, guards, fallback handler. Named by their proven code hash.",
  "Creation. The factory, the setup call and any setup delegatecall.",
  "Event history. Every setting has the event that set it.",
  "Pending actions. Approved hashes, signed messages, queued transactions.",
]

function Arrow() {
  return (
    <svg
      viewBox="0 0 36 12"
      aria-hidden="true"
      className="absolute top-full left-1/2 mt-2 h-3 w-9 -translate-x-1/2 translate-y-3 rotate-90 sm:top-1/2 sm:left-full sm:mt-0 sm:ml-1.5 sm:translate-x-0 sm:-translate-y-1/2 sm:rotate-0"
    >
      <path d="M0 6H30" className="stroke-foreground" strokeWidth="1.5" />
      <path d="M29 1L35 6L29 11Z" className="fill-foreground" />
    </svg>
  )
}

const NODE =
  "relative flex min-h-16 items-center justify-center rounded-[18px] px-4 py-3 text-center text-[15px] leading-[21px] sm:min-h-28"

function RuledList({ title, id, items }: { title: string; id: string; items: readonly string[] }) {
  return (
    <section aria-labelledby={id} className="flex flex-col gap-4">
      <h2 id={id} className="text-xl font-semibold">
        {title}
      </h2>
      <ul className="border-b border-border-subtle text-[15px] leading-[22px]">
        {items.map((item) => {
          const end = item.indexOf(". ") + 1
          return (
            <li
              key={item}
              className="relative border-t border-border-subtle py-3 pl-6 before:absolute before:left-0 before:text-border before:content-['-']"
            >
              <span className="font-semibold">{end > 0 ? item.slice(0, end) : item}</span>
              {end > 0 && item.slice(end)}
            </li>
          )
        })}
      </ul>
    </section>
  )
}

export function About() {
  return (
    <div className="mt-16 flex flex-col gap-20 sm:mt-24 sm:gap-24">
      <section aria-labelledby="how-title" className="flex flex-col gap-7">
        <h2 id="how-title" className="text-2xl font-semibold sm:text-[26px]">
          How the check works
        </h2>
        <ol className="grid grid-cols-1 gap-12 sm:grid-cols-4">
          {STEPS.map((step) => (
            <li key={step} className={`${NODE} bg-node text-primary-foreground`}>
              {step}
              <Arrow />
            </li>
          ))}
          <li className={`${NODE} bg-brand font-semibold text-primary-foreground`}>Roots match: no hidden storage</li>
        </ol>
        <div className="flex max-w-3xl flex-col gap-1.5 text-[15px] leading-[22px] text-muted-foreground">
          <p>
            If the roots differ, the check looks for the extra slots and names them where it can, for example a hidden
            owner entry.
          </p>
          <p>
            Each state read is proven against one block that two RPCs run by different operators agree on. When a run
            cannot do that, the result says so.
          </p>
        </div>
      </section>
      <div className="grid grid-cols-1 gap-14 sm:grid-cols-2">
        <RuledList id="checks-title" title="What it checks" items={CHECKS} />
        <RuledList id="not-checks-title" title="What it does not check" items={NOT_CHECKED} />
      </div>
    </div>
  )
}
