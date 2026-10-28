import type { ReactNode } from "react"
import { ACCOUNT_KIND_LABEL, COMPARISON_LABEL, handlerSlots } from "@/core/markdown"
import type {
  ChainRef,
  HandlersSection,
  IdentitySection,
  ModuleRow,
  ModulesSection,
  OwnerRow,
  OwnersSection,
  Part,
  ZodiacDetails,
} from "@/core/report"
import {
  AddressLink,
  Badge,
  Flags,
  HexText,
  IdentificationText,
  Section,
  TableScroll,
  TD,
  TH,
} from "@/ui/components/common"
import { duration } from "@/ui/format"

export function Identity({ part, chain }: { part: Part<IdentitySection> | undefined; chain: ChainRef | null }) {
  return (
    <Section id="identity" title="Safe contract" technical="proxy and singleton" part={part}>
      {(identity) => (
        <dl className="grid grid-cols-1 gap-x-6 gap-y-1 border-t border-border-subtle pt-4 text-sm sm:grid-cols-[16rem_minmax(0,1fr)] sm:gap-y-4">
          <dt className="text-muted-foreground">Version</dt>
          <dd>
            {identity.version ?? "unknown"}
            {identity.l2 !== null && (identity.l2 ? " (L2 version)" : " (not the L2 version)")}
            {!identity.supported && (
              <>
                {" "}
                <Badge tone="warn">not supported</Badge>
              </>
            )}
            <span className="block text-xs text-muted-foreground">
              VERSION() returns {identity.versionCall ?? "nothing"}. Latest supported version: {identity.latestVersion}.
            </span>
          </dd>
          <dt className="text-muted-foreground">Logic contract (singleton, slot 0)</dt>
          <dd className="flex flex-col gap-1">
            <AddressLink address={identity.singleton.address} chain={chain} />
            <IdentificationText
              identification={identity.singleton.identification}
              chain={chain}
              address={identity.singleton.address}
            />
          </dd>
          <dt className="text-muted-foreground">Proxy code at the Safe address</dt>
          <dd className="flex flex-col gap-1">
            <HexText value={identity.proxy.codeHash} />
            <IdentificationText identification={identity.proxy.identification} chain={chain} address={null} />
          </dd>
        </dl>
      )}
    </Section>
  )
}

function OwnerType({ row, chain }: { row: OwnerRow; chain: ChainRef | null }) {
  return (
    <div className="flex flex-col gap-1">
      <span>{ACCOUNT_KIND_LABEL[row.kind]}</span>
      {row.delegate && (
        <span className="text-xs text-muted-foreground">
          delegates to <AddressLink address={row.delegate} chain={chain} short />
        </span>
      )}
      {row.kind === "contract" && !row.identification && (
        <span className="text-xs text-muted-foreground">contract owner, not inspected</span>
      )}
      {row.identification && row.kind !== "delegated-eoa" && (
        <IdentificationText identification={row.identification} chain={chain} address={row.address} />
      )}
      {row.safe && (
        <span className="text-xs text-muted-foreground">
          Safe {row.safe.version ?? "of unknown version"}, {row.safe.threshold} of {row.safe.owners.length}:{" "}
          {row.safe.owners.map((owner, index) => (
            <span key={owner}>
              {index > 0 && ", "}
              <AddressLink address={owner} chain={chain} short />
            </span>
          ))}
        </span>
      )}
    </div>
  )
}

export function Owners({ part, chain }: { part: Part<OwnersSection> | undefined; chain: ChainRef | null }) {
  return (
    <Section id="owners" title="Owners" technical="getOwners, walked from storage" part={part}>
      {(owners) => (
        <>
          <p className="text-sm">
            {owners.threshold} of {owners.ownerCount} owners must sign a transaction.
          </p>
          {owners.inertOnly && (
            <p className="rounded-sm border border-info-border bg-info-surface px-3 py-2 text-sm text-info">
              Every owner is a placeholder address that cannot sign. Only the modules can act for this Safe.
            </p>
          )}
          <TableScroll label="Owners">
            <thead>
              <tr>
                <th className={TH}>Owner</th>
                <th className={TH}>Type</th>
                <th className={TH}>Flags</th>
              </tr>
            </thead>
            <tbody>
              {owners.owners.map((row) => (
                <tr key={row.address}>
                  <td className={TD}>
                    <AddressLink address={row.address} chain={chain} />
                  </td>
                  <td className={TD}>
                    <OwnerType row={row} chain={chain} />
                  </td>
                  <td className={TD}>
                    <Flags flags={row.flags} />
                  </td>
                </tr>
              ))}
            </tbody>
          </TableScroll>
        </>
      )}
    </Section>
  )
}

const ZERO = /^0x0{40}$/

function IsSafe({
  value,
  isSafe,
  chain,
}: {
  value: ModuleRow["address"] | null
  isSafe: boolean
  chain: ChainRef | null
}) {
  if (!value) return <span className="text-muted-foreground">not read</span>
  return (
    <span className="flex flex-wrap items-center gap-1">
      <AddressLink address={value} chain={chain} short />
      {isSafe ? <Badge tone="ok">this Safe</Badge> : <Badge tone="warn">not this Safe</Badge>}
    </span>
  )
}

function Zodiac({ zodiac, chain }: { zodiac: ZodiacDetails; chain: ChainRef | null }) {
  const rows: [string, ReactNode][] = [
    ["Owner, owner()", <IsSafe key="o" value={zodiac.owner} isSafe={zodiac.ownerIsSafe} chain={chain} />],
    ["Avatar, avatar()", <IsSafe key="a" value={zodiac.avatar} isSafe={zodiac.avatarIsSafe} chain={chain} />],
    ["Target, target()", <IsSafe key="t" value={zodiac.target} isSafe={zodiac.targetIsSafe} chain={chain} />],
    [
      "Guard, getGuard()",
      zodiac.guard === "absent" ? (
        "this version has no guard"
      ) : zodiac.guard && !ZERO.test(zodiac.guard) ? (
        <AddressLink address={zodiac.guard} chain={chain} short />
      ) : (
        "none"
      ),
    ],
  ]
  if (zodiac.reality) {
    const r = zodiac.reality
    rows.push(
      ["Oracle", <AddressLink key="oracle" address={r.oracle} chain={chain} short />],
      ["Question template", r.templateId],
      ["Answer timeout", duration(r.timeout)],
      ["Cooldown before execution", duration(r.cooldown)],
      ["Answer expiration", r.expiration === "0" ? "never" : duration(r.expiration)],
      ["Minimum bond", `${r.minimumBond} (smallest units of the bond token)`],
      [
        "Arbitrator",
        /^0x0{40}$/.test(r.arbitrator) ? "none" : <AddressLink key="arb" address={r.arbitrator} chain={chain} short />,
      ],
    )
  }
  if (zodiac.modules) {
    rows.push([
      "Its own modules",
      zodiac.modules.length === 0
        ? "none"
        : zodiac.modules.map((m) => <AddressLink key={m} address={m} chain={chain} short />),
    ])
  }
  rows.push(["Cross-check RPC", COMPARISON_LABEL[zodiac.cross]])
  return (
    <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-xs">
      {rows.map(([label, value]) => (
        <div key={label} className="contents">
          <dt className="whitespace-nowrap text-muted-foreground">{label}</dt>
          <dd className="flex flex-wrap gap-1">{value}</dd>
        </div>
      ))}
    </dl>
  )
}

export function Modules({ part, chain }: { part: Part<ModulesSection> | undefined; chain: ChainRef | null }) {
  return (
    <Section id="modules" title="Modules" technical="getModulesPaginated, walked from storage" part={part}>
      {({ modules }) =>
        modules.length === 0 ? (
          <p className="text-sm">No modules. Only the owners can act for this Safe.</p>
        ) : (
          <>
            <p className="text-sm">
              A module can make the Safe do anything without owner signatures. Each one needs to be trusted.
            </p>
            <TableScroll label="Modules">
              <thead>
                <tr>
                  <th className={TH}>Module</th>
                  <th className={TH}>Identified as</th>
                  <th className={TH}>Flags</th>
                  <th className={TH}>Details</th>
                </tr>
              </thead>
              <tbody>
                {modules.map((row) => (
                  <tr key={row.address}>
                    <td className={TD}>
                      <AddressLink address={row.address} chain={chain} />
                    </td>
                    <td className={TD}>
                      {row.kind === "contract" || row.kind === "safe" ? (
                        <IdentificationText identification={row.identification} chain={chain} address={row.address} />
                      ) : (
                        <span>{ACCOUNT_KIND_LABEL[row.kind]}</span>
                      )}
                    </td>
                    <td className={TD}>
                      <Flags flags={row.flags} />
                    </td>
                    <td className={`${TD} min-w-80`}>
                      {row.zodiac ? <Zodiac zodiac={row.zodiac} chain={chain} /> : <span>none</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </TableScroll>
          </>
        )
      }
    </Section>
  )
}

const HANDLER_TECHNICAL: Record<string, string> = {
  Guard: "guard_manager.guard.address",
  "Module guard": "module_manager.module_guard.address",
  "Fallback handler": "fallback_manager.handler.address",
}

const ANNOUNCED_LABEL = { yes: "yes", no: "no event found", unknown: "not determined" }

export function Handlers({ part, chain }: { part: Part<HandlersSection> | undefined; chain: ChainRef | null }) {
  return (
    <Section id="handlers" title="Guard and fallback handler" part={part}>
      {(handlers) => (
        <TableScroll label="Guard and fallback handler">
          <thead>
            <tr>
              <th className={TH}>Setting</th>
              <th className={TH}>Address</th>
              <th className={TH}>Identified as</th>
              <th className={TH}>Set by an event</th>
              <th className={TH}>Flags</th>
            </tr>
          </thead>
          <tbody>
            {handlerSlots(handlers).map(([label, slot]) => (
              <tr key={label}>
                <td className={TD}>
                  {label}
                  <span className="block font-mono text-xs text-muted-foreground">{HANDLER_TECHNICAL[label]}</span>
                </td>
                {!slot.applicable ? (
                  <td className={TD} colSpan={4}>
                    Not in this Safe version
                  </td>
                ) : !slot.address ? (
                  <td className={TD} colSpan={4}>
                    Not set
                  </td>
                ) : (
                  <>
                    <td className={TD}>
                      <AddressLink address={slot.address} chain={chain} />
                    </td>
                    <td className={TD}>
                      <IdentificationText identification={slot.identification} chain={chain} address={slot.address} />
                    </td>
                    <td className={TD}>{ANNOUNCED_LABEL[slot.announced]}</td>
                    <td className={TD}>
                      <Flags flags={slot.flags} />
                    </td>
                  </>
                )}
              </tr>
            ))}
          </tbody>
        </TableScroll>
      )}
    </Section>
  )
}
