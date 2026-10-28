import { type FormEvent, useEffect, useId, useRef, useState } from "react"
import { chainSettings, checkApiKey, checkRpcUrl, publicIndexersOn } from "@/data/settings"
import type { ChainInfo, ChainRpcSettings, DefaultRpc, Settings } from "@/data/types"
import { BUTTON, INPUT } from "@/ui/components/common"

// Empty is fine: every RPC field is optional.
function urlProblem(text: string): string | null {
  if (text.trim() === "") return null
  const check = checkRpcUrl(text)
  return check.ok ? null : check.message
}

function Field({
  label,
  help,
  value,
  onChange,
  problem,
  type = "text",
  placeholder,
}: {
  label: string
  help?: string
  value: string
  onChange: (value: string) => void
  problem?: string | null
  type?: "text" | "password"
  placeholder?: string
}) {
  const id = useId()
  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={id} className="text-sm font-semibold">
        {label}
      </label>
      <input
        id={id}
        type={type}
        value={value}
        placeholder={placeholder}
        autoComplete="off"
        spellCheck={false}
        aria-invalid={problem ? true : undefined}
        aria-describedby={`${id}-help ${id}-problem`}
        onChange={(event) => onChange(event.target.value)}
        className={`${INPUT} h-10 font-mono`}
      />
      {help && (
        <p id={`${id}-help`} className="text-xs text-muted-foreground">
          {help}
        </p>
      )}
      {problem && (
        <p id={`${id}-problem`} className="text-xs text-bad">
          {problem}
        </p>
      )}
    </div>
  )
}

function DefaultRpcs({ chain, operatorName }: { chain: ChainInfo; operatorName: (rpc: DefaultRpc) => string }) {
  if (chain.rpcs.length === 0) {
    return (
      <p className="rounded-sm border border-warn-border bg-warn-surface px-3 py-2 text-sm text-warn">
        {chain.name} has no working default RPC: none passed our checks (chain id, browser access, recent blocks). Add
        your own RPC below to check a Safe on it.
      </p>
    )
  }
  return (
    <div className="flex flex-col gap-1 text-sm">
      <p>Default RPCs for {chain.name}, tried in this order:</p>
      <ol className="list-decimal pl-5">
        {chain.rpcs.map((rpc) => (
          <li key={rpc.url}>
            <span className="font-mono text-xs break-all">{rpc.url}</span>{" "}
            <span className="text-xs text-muted-foreground">
              {operatorName(rpc)}
              {rpc.proofs ? ", serves storage proofs" : ", block headers only (cross-check)"}
              {rpc.aggregator ? ", forwards to other nodes" : ""}
            </span>
          </li>
        ))}
      </ol>
      {!chain.rpcs.some((rpc) => rpc.proofs) && (
        <p className="text-warn">
          None of these serves storage proofs, so the storage root cannot be checked. Add an RPC that serves
          eth_getProof for recent blocks.
        </p>
      )}
    </div>
  )
}

type RpcDraft = { primary: string; crossCheck: string; useDefaults: boolean; ownNode: boolean }

function draftOf(saved: ChainRpcSettings): RpcDraft {
  return {
    primary: saved.primary ?? "",
    crossCheck: saved.crossCheck ?? "",
    useDefaults: saved.useDefaults,
    ownNode: saved.ownNode === true,
  }
}

function draftProblems(draft: RpcDraft) {
  return {
    primary: urlProblem(draft.primary),
    crossCheck: urlProblem(draft.crossCheck),
    noRpcLeft: !draft.useDefaults && draft.primary.trim() === "",
  }
}

function keyProblem(text: string): string | null {
  const check = checkApiKey(text)
  return check.ok ? null : check.message
}

// Block, RPCs and API keys. Everything here is optional; the defaults work without it. RPC edits are kept per chain,
// so switching the chain above never throws away what was typed.
export function SettingsPanel({
  id,
  chain,
  block,
  onBlockChange,
  settings,
  focusRequest,
  operatorName,
  onSave,
}: {
  id: string
  chain: ChainInfo | null
  block: string
  onBlockChange: (block: string) => void
  settings: Settings
  // Changes on every request to show the drawer: it then scrolls into view and takes focus.
  focusRequest: number
  operatorName: (rpc: DefaultRpc, chain: ChainInfo) => string
  onSave: (settings: Settings) => void
}) {
  const [drafts, setDrafts] = useState<Record<string, RpcDraft>>({})
  const [stsEnabled, setStsEnabled] = useState(settings.safeTxService.enabled)
  const [stsKey, setStsKey] = useState(settings.safeTxService.apiKey ?? "")
  const [etherscanKey, setEtherscanKey] = useState(settings.etherscan.apiKey ?? "")
  const [indexers, setIndexers] = useState(publicIndexersOn(settings))
  const [status, setStatus] = useState<string | null>(null)
  const form = useRef<HTMLFormElement>(null)

  useEffect(() => {
    if (focusRequest === 0) return
    form.current?.scrollIntoView?.({ block: "start" })
    form.current?.querySelector("input")?.focus()
  }, [focusRequest])

  const key = chain ? String(chain.chainId) : null
  const draft = chain ? (drafts[String(chain.chainId)] ?? draftOf(chainSettings(settings, chain.chainId))) : null
  const update = (change: Partial<RpcDraft>) => {
    if (key && draft) setDrafts({ ...drafts, [key]: { ...draft, ...change } })
  }
  const problems = draft ? draftProblems(draft) : null
  const blockProblem = /^\d*$/.test(block.trim()) ? null : "Enter a block number (digits only), or leave it empty."
  const stsKeyProblem = keyProblem(stsKey)
  const etherscanKeyProblem = keyProblem(etherscanKey)

  const save = (event: FormEvent) => {
    event.preventDefault()
    const broken = Object.entries(drafts).find(([, d]) => {
      const p = draftProblems(d)
      return p.primary || p.crossCheck || p.noRpcLeft
    })
    if (broken || stsKeyProblem || etherscanKeyProblem) {
      setStatus("Not saved: fix the fields marked above.")
      return
    }
    const next: Settings = {
      ...settings,
      rpcs: { ...settings.rpcs },
      safeTxService: { enabled: stsEnabled, apiKey: stsKey.trim() || null },
      etherscan: { apiKey: etherscanKey.trim() || null },
      publicIndexers: indexers,
    }
    for (const [chainKey, d] of Object.entries(drafts)) {
      const rpcs: ChainRpcSettings = {
        primary: d.primary.trim() || null,
        crossCheck: d.crossCheck.trim() || null,
        useDefaults: d.useDefaults,
      }
      // Trusting a node alone only ever applies to the user's own primary RPC.
      if (d.ownNode && rpcs.primary) rpcs.ownNode = true
      if (rpcs.primary || rpcs.crossCheck || !rpcs.useDefaults) next.rpcs[chainKey] = rpcs
      else delete next.rpcs[chainKey]
    }
    onSave(next)
    setDrafts({})
    setStatus("Saved in this browser.")
  }

  return (
    <form
      id={id}
      ref={form}
      onSubmit={save}
      aria-label="Settings"
      className="flex scroll-mt-4 flex-col gap-6 border border-border-subtle bg-surface p-4 sm:p-6"
    >
      <Field
        label="Block (optional)"
        help="Leave empty to use a recent block (latest minus 3). Many public RPCs serve storage proofs only for recent blocks."
        value={block}
        onChange={onBlockChange}
        problem={blockProblem}
        placeholder="latest - 3"
      />

      <fieldset className="flex flex-col gap-4 border-t border-border-subtle pt-5">
        <legend className="float-left mb-1 text-lg font-semibold">RPCs{chain ? ` for ${chain.name}` : ""}</legend>
        {chain && draft && problems ? (
          <>
            <DefaultRpcs chain={chain} operatorName={(rpc) => operatorName(rpc, chain)} />
            <Field
              label="Your primary RPC (optional)"
              help="Used first. It should serve eth_getProof for the block."
              value={draft.primary}
              onChange={(primary) => update({ primary })}
              problem={problems.primary}
              placeholder="https://"
            />
            <div className="flex flex-col gap-1">
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={draft.ownNode && draft.primary.trim() !== ""}
                  disabled={draft.primary.trim() === ""}
                  onChange={(event) => update({ ownNode: event.target.checked })}
                />
                This is my own node: trust it without a cross-check
              </label>
              <p className="text-xs text-muted-foreground">
                When no other operator can confirm the block, the check then accepts your RPC alone, and the verdict
                says so. Tick it only for a node you run yourself, never because a page or a person asked you to.
              </p>
            </div>
            <Field
              label="Your cross-check RPC (optional)"
              help="Run by a different operator than the primary, so one RPC alone cannot fake the block."
              value={draft.crossCheck}
              onChange={(crossCheck) => update({ crossCheck })}
              problem={problems.crossCheck}
              placeholder="https://"
            />
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={draft.useDefaults}
                onChange={(event) => update({ useDefaults: event.target.checked })}
              />
              Also use the default RPCs
            </label>
            {problems.noRpcLeft && (
              <p className="text-xs text-bad">Without the defaults, enter your own primary RPC.</p>
            )}
            {!draft.useDefaults && (
              <p className="text-xs text-muted-foreground">
                The default RPCs then get nothing. The Transaction Service and the public indexers follow their own
                switches below.
              </p>
            )}
          </>
        ) : (
          <p className="text-sm text-muted-foreground">Pick a chain above to see and change its RPCs.</p>
        )}
      </fieldset>

      <fieldset className="flex flex-col gap-4 border-t border-border-subtle pt-5">
        <legend className="float-left mb-1 text-lg font-semibold">Other services</legend>
        <label className="flex items-start gap-2 text-sm">
          <input
            type="checkbox"
            role="switch"
            checked={stsEnabled}
            onChange={(event) => setStsEnabled(event.target.checked)}
            className="mt-1"
          />
          <span>
            Use the Safe Transaction Service (api.safe.global) for the creation, queued transactions and messages. Turn
            it off to keep the address away from Safe's service.
          </span>
        </label>
        <Field
          label="Safe Transaction Service API key (optional)"
          help="Raises the rate limit. The service does not reject a wrong key; it then answers as if no key was given."
          value={stsKey}
          onChange={setStsKey}
          problem={stsKeyProblem}
          type="password"
        />
        <label className="flex items-start gap-2 text-sm">
          <input
            type="checkbox"
            role="switch"
            checked={indexers}
            onChange={(event) => setIndexers(event.target.checked)}
            className="mt-1"
          />
          <span>
            Use public indexers (Blockscout, Sourcify) for the event history, the creation and code no list knows. Turn
            it off to keep the address away from them; the history can then be incomplete.
          </span>
        </label>
        <Field
          label="Etherscan API key (optional)"
          help="Etherscan is called only with a key, as an extra source for the event history."
          value={etherscanKey}
          onChange={setEtherscanKey}
          problem={etherscanKeyProblem}
          type="password"
        />
      </fieldset>

      <p className="text-xs text-muted-foreground">
        Your RPC addresses and keys are saved in this browser (localStorage) and sent only to the service they belong
        to. They never go into the link, the report or the Markdown summary.
      </p>
      <div className="flex items-center gap-3">
        <button type="submit" className={BUTTON}>
          Save settings
        </button>
        <span role="status" className="text-sm">
          {status}
        </span>
      </div>
    </form>
  )
}
