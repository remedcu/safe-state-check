import type { ReactNode } from "react"
import { SERVICE_LABEL } from "@/core/markdown"
import type { ChainRef, CreationSection, HistorySection, Part, PendingSection } from "@/core/report"
import { AddressLink, Badge, HexText, IdentificationText, Section, TableScroll, TD, TH } from "@/ui/components/common"

function Facts({ rows }: { rows: [string, ReactNode][] }) {
  return (
    <dl className="grid grid-cols-1 gap-x-4 gap-y-1 text-sm sm:grid-cols-[auto_1fr]">
      {rows.map(([label, value]) => (
        <div key={label} className="contents">
          <dt className="text-muted-foreground">{label}</dt>
          <dd className="min-w-0">{value}</dd>
        </div>
      ))}
    </dl>
  )
}

const ZERO = /^0x0{40}$/

export function Creation({ part, chain }: { part: Part<CreationSection> | undefined; chain: ChainRef | null }) {
  return (
    <Section id="creation" title="Creation" technical="factory call and setup" part={part}>
      {(creation) => {
        const setup = creation.setup
        const rows: [string, ReactNode][] = [
          ["Transaction", <HexText key="tx" value={creation.txHash} />],
          ["Block", `${creation.block}${creation.timestamp ? `, ${creation.timestamp}` : ""}`],
          ["Found through", `${SERVICE_LABEL[creation.source.service]} ${creation.source.host}`],
          [
            "Factory",
            <span key="f" className="flex flex-col gap-0.5">
              <AddressLink address={creation.factory.address} chain={chain} />
              <IdentificationText
                identification={creation.factory.identification}
                chain={chain}
                address={creation.factory.address}
              />
              <span className="font-mono text-xs">{creation.factory.method}</span>
            </span>,
          ],
        ]
        if (creation.singleton) {
          rows.push(["Logic contract at creation", <AddressLink key="s" address={creation.singleton} chain={chain} />])
        }
        if (creation.callback) {
          rows.push([
            "Callback",
            <span key="cb" className="flex flex-col gap-0.5">
              <AddressLink address={creation.callback.address} chain={chain} />
              <IdentificationText
                identification={creation.callback.identification}
                chain={chain}
                address={creation.callback.address}
              />
            </span>,
          ])
        }
        if (setup) {
          rows.push(
            ["Owners at setup", `${setup.threshold} of ${setup.owners.length}`],
            [
              "Setup call (to, data)",
              ZERO.test(setup.to) ? (
                "none"
              ) : (
                <span key="to" className="flex flex-col gap-0.5">
                  <AddressLink address={setup.to} chain={chain} />
                  <IdentificationText identification={setup.toIdentification} chain={chain} address={setup.to} />
                  <HexText value={setup.data} />
                </span>
              ),
            ],
            ["Fallback handler at setup", <AddressLink key="h" address={setup.fallbackHandler} chain={chain} />],
            [
              "Payment",
              setup.payment === "0" ? (
                "none"
              ) : (
                <span key="p">
                  {setup.payment} of <AddressLink address={setup.paymentToken} chain={chain} short /> to{" "}
                  <AddressLink address={setup.paymentReceiver} chain={chain} short />
                </span>
              ),
            ],
          )
        } else {
          rows.push(["Setup", "not decoded"])
        }
        return (
          <>
            <Facts rows={rows} />
            {setup?.batch && (
              <TableScroll label="Calls made by the setup">
                <thead>
                  <tr>
                    <th className={TH}>Call</th>
                    <th className={TH}>To</th>
                    <th className={TH}>Function</th>
                  </tr>
                </thead>
                <tbody>
                  {setup.batch.map((call, index) => (
                    <tr key={index}>
                      <td className={TD}>{call.operation}</td>
                      <td className={TD}>
                        <AddressLink address={call.to} chain={chain} />
                        <IdentificationText identification={call.identification} chain={chain} address={call.to} />
                      </td>
                      <td className={`${TD} font-mono text-xs`}>{call.fn ?? call.data.slice(0, 10)}</td>
                    </tr>
                  ))}
                </tbody>
              </TableScroll>
            )}
            {creation.storageDiff && (
              <TableScroll label="Storage written by the creation">
                <thead>
                  <tr>
                    <th className={TH}>Meaning</th>
                    <th className={TH}>Key</th>
                    <th className={TH}>Before</th>
                    <th className={TH}>After</th>
                  </tr>
                </thead>
                <tbody>
                  {creation.storageDiff.map((row) => (
                    <tr key={row.key}>
                      <td className={TD}>{row.meaning}</td>
                      <td className={`${TD} min-w-64`}>
                        <HexText value={row.key} />
                      </td>
                      <td className={`${TD} min-w-64`}>
                        <HexText value={row.before} />
                      </td>
                      <td className={`${TD} min-w-64`}>
                        <HexText value={row.after} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </TableScroll>
            )}
          </>
        )
      }}
    </Section>
  )
}

export function History({ part }: { part: Part<HistorySection> | undefined }) {
  return (
    <Section id="history" title="History" technical="Safe events" part={part}>
      {(history) => (
        <>
          <p className="text-sm">
            Events from {SERVICE_LABEL[history.source.service]} {history.source.host}, blocks {history.fromBlock} to{" "}
            {history.toBlock}.{" "}
            {history.complete ? (
              <Badge tone="ok">complete</Badge>
            ) : (
              <Badge tone="warn">incomplete: a change without its event cannot be ruled out</Badge>
            )}
          </p>
          <p className="text-sm">
            Transactions: {history.executions.success} executed, {history.executions.failure} failed;{" "}
            {history.executions.moduleSuccess} executed by modules, {history.executions.moduleFailure} failed.
          </p>
          {history.differences.length > 0 && (
            <TableScroll label="Configuration that the events do not explain">
              <thead>
                <tr>
                  <th className={TH}>Setting</th>
                  <th className={TH}>Now</th>
                  <th className={TH}>From the events</th>
                </tr>
              </thead>
              <tbody>
                {history.differences.map((d) => (
                  <tr key={d.field}>
                    <td className={TD}>{d.field}</td>
                    <td className={`${TD} font-mono text-xs`}>{d.current}</td>
                    <td className={`${TD} font-mono text-xs`}>{d.fromEvents}</td>
                  </tr>
                ))}
              </tbody>
            </TableScroll>
          )}
          <TableScroll label="Configuration events">
            <thead>
              <tr>
                <th className={TH}>Event</th>
                <th className={TH}>Block</th>
                <th className={TH}>Details</th>
                <th className={TH}>Transaction</th>
              </tr>
            </thead>
            <tbody>
              {history.configEvents.map((event) => (
                <tr key={`${event.txHash}-${event.logIndex}`}>
                  <td className={TD}>
                    {event.name}
                    {!event.confirmed && <span className="block text-xs text-warn">not confirmed by the RPC</span>}
                  </td>
                  <td className={TD}>{event.block}</td>
                  <td className={`${TD} font-mono text-xs`}>
                    {Object.entries(event.args).map(([key, value]) => (
                      <span key={key} className="block whitespace-nowrap">
                        {key}: {value}
                      </span>
                    ))}
                  </td>
                  <td className={`${TD} min-w-64`}>
                    <HexText value={event.txHash} />
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

export function Pending({ part, chain }: { part: Part<PendingSection> | undefined; chain: ChainRef | null }) {
  return (
    <Section id="pending" title="Pending actions" part={part}>
      {(pending) => {
        const none =
          pending.approvedHashes.length +
            pending.signedMessages.length +
            pending.queued.length +
            pending.messages.length +
            pending.delegates.length ===
          0
        return (
          <>
            {none && <p className="text-sm">Nothing pending was found.</p>}
            {pending.approvedHashes.length > 0 && (
              <TableScroll label="Pre-approved transaction hashes">
                <thead>
                  <tr>
                    <th className={TH}>Approved hash</th>
                    <th className={TH}>Owner</th>
                    <th className={TH}>Nonce</th>
                  </tr>
                </thead>
                <tbody>
                  {pending.approvedHashes.map((a) => (
                    <tr key={a.slot}>
                      <td className={`${TD} min-w-64`}>
                        <HexText value={a.hash} />
                      </td>
                      <td className={TD}>
                        <AddressLink address={a.owner} chain={chain} />
                      </td>
                      <td className={TD}>{a.nonce ?? "unknown"}</td>
                    </tr>
                  ))}
                </tbody>
              </TableScroll>
            )}
            {pending.signedMessages.length > 0 && (
              <ul className="text-sm">
                {pending.signedMessages.map((m) => (
                  <li key={m.slot}>
                    Message signed onchain: <HexText value={m.hash} />
                  </li>
                ))}
              </ul>
            )}
            {pending.queued.length > 0 && (
              <TableScroll label="Queued transactions">
                <thead>
                  <tr>
                    <th className={TH}>Nonce</th>
                    <th className={TH}>To</th>
                    <th className={TH}>Kind</th>
                    <th className={TH}>Signatures</th>
                  </tr>
                </thead>
                <tbody>
                  {pending.queued.map((q) => (
                    <tr key={q.safeTxHash}>
                      <td className={TD}>{q.nonce}</td>
                      <td className={TD}>
                        <AddressLink address={q.to} chain={chain} />
                      </td>
                      <td className={TD}>{q.operation}</td>
                      <td className={TD}>
                        {q.confirmations} of {q.required}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </TableScroll>
            )}
            {pending.messages.length > 0 && (
              <p className="text-sm">{pending.messages.length} offchain messages in the Safe Transaction Service.</p>
            )}
            {pending.delegates.length > 0 && (
              <ul className="text-sm">
                {pending.delegates.map((d) => (
                  <li key={`${d.delegate}-${d.delegator}`}>
                    Delegate <AddressLink address={d.delegate} chain={chain} short /> for{" "}
                    <AddressLink address={d.delegator} chain={chain} short />
                    {d.label ? ` (${d.label})` : ""}
                  </li>
                ))}
              </ul>
            )}
            <p className="text-xs text-muted-foreground">
              Sources: {pending.sources.map((s) => `${SERVICE_LABEL[s.service]} ${s.host}`).join(", ") || "none"}.
            </p>
          </>
        )
      }}
    </Section>
  )
}
