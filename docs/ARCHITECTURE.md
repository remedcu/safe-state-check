# Architecture

How Safe State Check is built: the modules, the check pipeline, the RPC layer, the error taxonomy, the generated data
and the rules behind the verdict. [SPEC.md](SPEC.md) is the product spec. This file is the design for it, with
the corrections that research found (section 12). The [README](../README.md) covers use, privacy, reproduction with
`cast`, development and deployment.

## 1. What the tool proves

Given only a Safe address, the tool reads the Safe at one pinned block and says whether its storage holds anything
its visible configuration does not explain. It does this in the browser, against public RPCs that may be slow, limited
or wrong, so every claim carries where it came from and how it was checked.

**Trust model.** One block header is the anchor: two RPCs run by different operators must return the same block hash
and `stateRoot` for the pinned block number. Everything read with `eth_getProof` is verified locally against that
`stateRoot` (`src/core/proof.ts`), so it is as trustworthy as the anchor, whichever RPC served it. Everything else
(`eth_call` results, logs, transactions, traces, API data) is "sourced": the report names the source, and where the
cross-check RPC can serve the same read, the two answers are compared.

| Claim                                                       | Basis                                                                                                                        |
| ----------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| Storage root, every slot value, account code hashes         | proven against the anchor                                                                                                    |
| Owner and module lists                                      | proven (walked from raw slots); getters are only a seed and a cross-check                                                    |
| Code identity (singleton, proxy, modules, handlers, owners) | proven code hash looked up in the generated registry                                                                         |
| Zodiac module parameters, `VERSION()`, owner Safes' owners  | `eth_call`, compared on both RPCs when the cross-check serves it                                                             |
| Creation, event history, pending actions                    | logs and APIs; an event that clears a finding counts only when the cross-check RPC's receipt for its transaction contains it |

A green verdict needs the anchor agreed by two operators, or the user's own node trusted alone (section 6.1). One
operator alone could serve a fake chain whose proofs verify against its own fake `stateRoot`.

## 2. Constraints

- Static SPA, no backend, served as Cloudflare Workers static assets. The build reads no host-specific variables, so
  the same repo can be connected to Pages unchanged.
- Only input: the address (bare, EIP-3770 `shortName:0x...`, Safe{Wallet} URL, or permalink). Chain, block, RPCs and
  APIs all have defaults.
- Default RPCs come from chainlist.org, filtered for trust and committed, so builds do not depend on chainlist and
  every change is reviewed. Users add their own (primary and cross-check) in `localStorage`.
- Keyed APIs: Etherscan only with a key; a shipped key would leak. The Safe Transaction Service is called without a key
  by default (Safe documents a keyless tier, and it is the party the user already trusts with the Safe), with an off
  switch and an optional key (`SAFE_TX_SERVICE_DEFAULT_ON` in `src/data/settings.ts`). The public indexers (Blockscout,
  Sourcify) have their own switch, on by default.
- Known contracts are generated from `@safe-global/safe-deployments`, `@safe-global/safe-modules-deployments` and
  `@gnosis-guild/zodiac` by a build script, never by hand. Zodiac stays a devDependency.
- Errors are never cryptic: every I/O failure maps to one kind with plain text and the raw detail behind a toggle.
- Coverage in the committed `chains.json` (refresh of 2026-10-12): of 566 safe-deployments chains, 154 have a default
  RPC whose proofs verify (16 of them only at the newest block, section 6.4), 65 have a primary and a cross-check of
  different operators (52 with proofs on both), 55 return proofs that are not standard Ethereum proofs (ZK Stack,
  Polygon zkEVM, Cosmos EVM chains, chains with extra account fields such as Avalanche and Blast), 47 have RPCs but
  none that proves, and 310 have no default RPC. All 566 stay selectable.

## 3. Module map

```text
src/
  core/      pure functions, no I/O. Slots, trie, proofs, linked lists, identification, every check rule, verdict.
             report.ts is the report model: the contract between checks, data and UI.
  data/      all I/O. JSON-RPC transport, endpoints, capability probe, anchor and proven reads, cross-check, event
             sources, Blockscout, Safe Transaction Service, Etherscan, Sourcify, settings, input parsing, chain
             detection. types.ts holds its contracts. generated/ holds the committed generated files.
  check/     the pipeline: runs the steps over the data interfaces, streams events, assembles the report. Also the
             candidate test and the on-demand look at other chains.
  ui/        React views over Report and CheckEvent.
scripts/
  refresh-rpcs.ts     writes src/data/generated/chains.json and data/rpcs/refresh-meta.json
  build-registry.ts   writes src/data/generated/known-contracts.json and data/registry/codehashes.json
  check.ts            CLI: same pipeline as the UI, prints Markdown and writes the JSON report
data/        generator inputs and metadata that are committed but not bundled
```

Dependency rules, enforced with `@typescript-eslint/no-restricted-imports` in `eslint.config.js`:

- `core` imports nothing from `data`, `check` or `ui`, except `import type` from `@/data/types` (generated file schemas).
- `data` may import `core` (proof verification, slot keys, report types). Never `check` or `ui`.
- `check` imports `core` and `data`. Never `ui`.
- `ui` imports `check` (start a run), `data` (chains, settings, input, detection) and `core` (types, Markdown).

## 4. Entry points and flows

- **Input bar submit.** `parseInput` (data). If no chain is known, `detectChains` (data), and the user picks when
  several chains match. Then `startCheck` (check): `openSession` reads the settings and `chains.json` and builds the
  endpoint pool; `runCheck` streams `CheckEvent`s and the UI reduces them into a partial report. At the end the UI
  writes the permalink to `location.hash`.
- **Permalink** `/#/<chainId>/<address>[@<block>]`. Same as a submit, with chain and block from the hash; no detection.
- **Settings drawer.** `saveSettings` writes the `localStorage` key `safe-state-check:settings:v1`. Only `openSession`
  and the drawer read it.
- **"Test candidates"** (diagnosis). `testCandidates` (check) proves the candidate slots, reclassifies the rows that
  are still unexplained, rebuilds the root and sends an updated report. A stop signal cancels it.
- **"Search all chains".** `detectChains` with scope `all`, only after a click, because the address then goes to every
  chain's RPC.
- **"Check other chains".** `checkOtherChains` (check, `src/check/otherChains.ts`), only after a click: detection over
  every chain with a default RPC, then, on each chain where the address is a Safe, a session anchored at that chain's
  latest block that reads version, owners and threshold. It fills `crossChain` and one `same-address-other-chains`
  finding naming the chains with code and those whose owners or threshold differ.
- **CLI.** `npm run cli -- <input>` with optional `--chain`, `--block`, `--rpc`, `--cross-rpc`, `--no-defaults`,
  `--own-node`, `--sts-key`, `--no-sts`, `--etherscan-key`, `--history-budget`, `--json <file>` and `--verbose`.
  Builds `Settings` from the flags (no `localStorage`; public indexers on), runs the popular detection phase when no
  chain is given, then `startCheck`. `exitCode` in `src/check/start.ts` maps the verdict to the exit code.
- **`npm run rpcs:refresh`.** Network. Rewrites `chains.json` and `refresh-meta.json`; reviewed as a normal PR.
- **`npm run registry:build`.** Network only for code hashes missing from `data/registry/codehashes.json`. Rewrites
  the registry and the cache.

In-memory session state: the capability cache per `(chainId, url)`, endpoint health per run, the registry index.
Apart from the settings in `localStorage`, nothing persists.

## 5. Check pipeline

Steps, in dependency order. Each emits `step` events (`running`, then `done`, `degraded`, `skipped` or `failed`) and a
`section` event with its part of the report as soon as it finishes. Step ids are `StepId` in `src/core/report.ts`.

| Step             | Needs                  | Produces                                                    |
| ---------------- | ---------------------- | ----------------------------------------------------------- |
| `anchor`         | request, endpoint pool | `Anchor`                                                    |
| `identity`       | anchor                 | `IdentitySection`, the Safe's first proof                   |
| `config`         | identity               | owners, modules, threshold, nonce, owner count, handlers    |
| `storage`        | config                 | `StorageSection`, pass 1                                    |
| `owners`         | config                 | `OwnersSection`                                             |
| `modules`        | config                 | `ModulesSection`                                            |
| `handlers`       | config                 | `HandlersSection`                                           |
| `creation`       | identity               | `CreationSection`                                           |
| `history`        | creation, config       | `HistorySection`                                            |
| `pending`        | history, config        | `PendingSection`                                            |
| `storage-events` | a pass-1 mismatch      | pass 2                                                      |
| `diagnosis`      | a pass-2 mismatch      | `DiagnosisSection`                                          |
| `reorg`          | every other read       | `verification.reorg`                                        |
| `verdict`        | everything             | verdict, cards, sorted findings, "what this does not check" |

RPC methods per step, and what happens when a capability is missing:

- `anchor`: `eth_chainId`, `eth_blockNumber`, `eth_getBlockByNumber` on both RPCs, and `eth_getProof` of the zero
  address with no keys as the proof probe (section 6.4; any account works, and a proof of absence is enough). No proof-capable RPC: header-only anchor, storage unproven, verdict unverified (section 6.4). One
  operator: verdict unverified (`single-operator`).
- `identity`: `eth_getProof(safe, base keys)` with slots 0, 3, 4, 5, 6, guard, fallback handler, module guard,
  `owners[0x1]` and `modules[0x1]`; `eth_getProof(singleton, [])`; `eth_getCode` when code must be parsed;
  `eth_call VERSION()`. No account: stop (`not-deployed`). An account without code: stop (`no-code`). Not a Safe:
  stop (`not-a-safe`) when the code is an EIP-7702 delegation, or when it is not a known SafeProxy, slot 0 holds no known
  singleton, and `getThreshold` and `getOwners` do not answer like a set-up Safe. Unknown proxy or singleton on a
  Safe: continue, verdict unverified plus a Critical finding.
- `config`: `eth_call` of `getOwners`, `getThreshold`, `nonce` and `getModulesPaginated` as seeds, then
  `eth_getProof(safe, list keys)` until `walkList` completes. Without archive `eth_call`: walk from raw slots only, one
  proof per list entry.
- `storage`: `eth_getProof(safe, every pass-1 key)` once, as one read. The unproven path (`eth_getStorageAt` on both
  RPCs, compared) is chosen once per run from `anchor.headerOnly`, never per read: on a chain whose proofs work, one
  failed proof is a failed read, not an unproven one.
- `owners`: per owner `eth_getProof(owner, [])`, and `eth_getCode` when it has code. Owner Safes:
  `eth_getProof(owner, [0, 3, 4])` and `eth_call getOwners`. An account whose read fails stays as a row of kind
  `unknown` with a gap naming the address and the failed call (`inspection-incomplete`).
- `modules` and `handlers`: the same, plus the EIP-1167 implementation's proof, Zodiac getters by `eth_call` and
  Sourcify for unknown code (only when public indexers are on). Without `eth_call` at the anchor, Zodiac fields say
  "not read".
- `creation`: the creation lookup (section 6.9), `eth_getTransactionByHash` (compared with the cross-check's copy),
  and `debug_traceTransaction` with `callTracer` (to find the factory call) and `prestateTracer` in diff mode (storage
  diff). Not found: unavailable, with the sources tried. No trace: decode direct factory calls, ERC-4337 `initCode` and
  the `ProxyCreationL2` initializer only, and the input only when the receipt's `ProxyCreation` from `tx.to` names this
  Safe. The two RPCs' copies differ: unavailable. Only one RPC read it: a gap says so. A setup target or helper whose
  code could not be read is a gap and makes the section partial; it never gives `setup-delegatecall-unknown`.
- `history`: the event source (section 6.10) and `eth_getTransactionReceipt` on the cross-check to confirm the events
  that clear a finding. Range not covered: partial and `history-incomplete`, with where and why the read stopped (time
  limit, chunk cap, failure); "set without event" is then reported as unknown, not as a finding. A failed history step
  also adds `history-incomplete`. A log from the Safe's address that does not decode as a Safe event is skipped and
  counted, never fatal.
- `pending`: `eth_getProof(safe, approvedHashes and signedMessages keys)`, and the Transaction Service queue, messages
  and delegates, read in parallel. Service off or failing: those lists say so.
- `storage-events`: `eth_getProof(safe, pass-1 and event keys)` once: every pass-1 key is read again with the event
  keys, so the pass rests on one read in every pin mode. With a partial history it runs with what it has.
- `diagnosis`: `debug_storageRangeAt`, then `debug_traceTransaction` with `prestateTracer` in diff mode on the
  creation and every transaction in the history, then proofs of every key found. Each sub-step reports the capability
  it missed, and the verdict lists what was tried.
- `reorg`: `eth_getBlockByNumber(anchor)` on both RPCs. Changed: one restart (`restarted` event), then unverified
  (`reorg`).

Concurrency: `owners`, `modules`, `handlers` and `storage` run in parallel after `config`; `creation` starts after
`identity`; `history` waits for `creation`. Per host at most 4 requests in flight, 12 in total. Estimate for the
Reward Distribution Safe (1 owner, 2 modules): about 45 calls on the primary and 15 on the cross-check, without
diagnosis.

The run stops without a report only when there is nothing to check (`StopReason`: not deployed, no code, not a Safe,
unknown chain, no RPC, anchor failed, cancelled). A Safe on unknown or unsupported code still produces a report.

### Step rules

**Identity (corrects SPEC 5.2).** The proxy's proven code hash must be any known SafeProxy runtime: 1.0.0, 1.1.1,
1.3.0, 1.4.1, 1.5.0, or the zkSync 1.3.0 and 1.4.1 proxies. A Safe keeps the proxy of the factory that created it, so
the proxy version says nothing about the singleton (8 mainnet Safes upgraded to 1.5.0 run 1.1.1, 1.3.0 and 1.4.1
proxies). The singleton is slot 0, never `masterCopy()`. Supported: `Safe` and `SafeL2` at 1.3.0, 1.4.1 and 1.5.0 in
any deployment type. Older singletons: unverified (`version-unsupported`). Unknown: `singleton-not-canonical`.
`VERSION()` must equal the registry version, else `getter-mismatch`.

**Config.** The raw walk is authoritative. `getModulesPaginated` is paged from the last element returned, which is
correct on every version (on 1.3.0, `next` itself is skipped by the next page). Raw list differs from a getter:
`getter-mismatch`. `ownerCount` (slot 3) differs from the walked count: `owner-count-mismatch`. Threshold outside
1..`ownerCount`: `threshold-invalid`. Broken pointer, cycle or over 1,000 entries: `list-corrupt`.

**Slot 6 (corrects SPEC 5.3).** Zero: nothing. Equal to `keccak256(abi.encode(0x035aff83d86937d35b32e04f0ddc6ff469290eef2f1b692d8a815c89404d4749, safe))`,
the domain separator of a Safe created at 1.0.0 to 1.2.0 and upgraded: benign row, `legacy-domain-separator`. Anything
else: `slot6-unexpected`.

**Storage passes.** Pass 1 keys: slots 0, 3, 4, 5, 6, the three fixed slots, `owners[x]` for the sentinel and every
owner, `modules[x]` for the sentinel and every module, and for an owner that is the SafeWebAuthnSharedSigner its
`SIGNER_SLOT`, `+1` and `+2` (`passkey-signer-slots`). Pass 2 adds `approvedHashes[owner][hash]` from `ApproveHash`
events and `signedMessages[hash]` from `SignMsg` events. Each pass rebuilds the root from one proven read that holds
every key in the pass, using the proven values. A match means the Safe has no non-zero slot outside that key set. The
formula line counts only non-zero expected slots and is for display only.

**Owners.** Kinds: no code is `eoa`; code `0xef0100` plus 20 bytes is `delegated-eoa` (`delegated-owner`, show the
delegate); `0x...01` to `0x...11` and `0x...0100` are `precompile`; a known SafeProxy with a supported singleton is
`safe` (one level: version, owners, threshold); other code is `contract` (`contract-owner`). Only precompile owners:
`inert-owners`, explained as "only modules can act". An account that could not be read is `unknown` and gives no
finding of its own; the verdict is amber instead.

**Modules and handlers.** EOA or delegated EOA as module: `eoa-module`. A Safe as module: kind `safe`, inspected one
level deep like an owner Safe, no `unknown-module`. A precompile as module: no finding. Contract: identification
(section 10). Unknown module: `unknown-module`. Unknown fallback handler: `unknown-fallback-handler`. Unknown guard:
`unknown-guard`. Unknown module guard: `unknown-module-guard`. Faulty Zodiac version (Delay 1.1.0, Roles 2.1.0):
`faulty-version`. Zodiac modules: `owner()`, `avatar()`, `target()`, `getGuard()` where the ABI has it (Delay 1.1.x
and Roles 2.x do not), Reality parameters, a modifier's own module list one level deep. Owner not the Safe:
`module-owner-not-safe`. ExtensibleFallbackHandler as handler: `handler-keeps-own-state`, and a line in "what this
does not check" (its per-Safe configuration sits in the handler's own storage, outside the root check).

**Creation.** Factory entry points, from the safe-deployments factory ABIs: `createProxy` (CREATE, up to 1.3.0),
`createProxyWithNonce` (every version), `createProxyWithCallback` (1.1.1 to 1.4.1), `createChainSpecificProxyWithNonce`
(1.4.1 and 1.5.0), and `createProxyWithNonceL2` and `createChainSpecificProxyWithNonceL2` (1.5.0). Setup selector
`0xb63e800d` on every supported version. `to`: zero, or a known setup helper (SafeToL2Setup, SafeModuleSetup,
AddModulesLib, legacy CreateAndAddModules), or MultiSend whose inner delegatecalls all go to known helpers or the shared
signer's `configure`; inner plain calls cannot write the Safe's storage. Anything else: `setup-delegatecall-unknown`.
`payment > 0`: `setup-payment` (a non-zero receiver with payment 0 is normal: Safe{Wallet} sets `0x5afe7a11e7...`).
Unknown factory: `factory-not-canonical`. Unknown callback: `creation-callback-unknown`. SafeToL2Setup on a chain other
than 1 changes slot 0 and emits `ChangedMasterCopy`: expected.

**History.** Topics: appendix A plus `ExecutionFailure`, `ExecutionFromModuleFailure`,
`ChainSpecificProxyCreationL2` and `SafeWebAuthnSharedSignerConfigured`. 1.3.0 indexes fewer arguments than 1.4.1
and 1.5.0, and an upgraded Safe mixes both, so decode by topic count. Replay `SafeSetup`, owner, threshold, module,
guard, module guard, handler and master copy events into a `ConfigState` and compare it with the proven state. Each
log is decoded on its own with viem `decodeEventLog` (strict). A module, guard, module guard, handler or owner present
now with no confirmed event that set it: `config-without-event` when node logs covered the full range,
`config-without-event-unconfirmed` (Medium) when the history came from an indexer, which can drop events; nothing when
the history is incomplete. Safes created before 1.3.0 have no `SafeSetup`: initial owners unknown,
`history-incomplete`. Executions are counted, with the last 50 listed.

**Pending.** An `approvedHashes[o][h]` slot is benign only when an `ApproveHash` event names exactly owner `o` and
hash `h`; a `signedMessages[h]` slot only when a `SignMsg` event names `h`. A delegatecall can write the slot and even
emit an `ApproveHash` naming someone else, and a forged approval is a forged signature, so a slot found any other way
is Critical (`approval-without-event`, `signed-message-without-event`) when the history was read in full. When part of
the history was not read, the event may lie outside the range read: the slot is shown as an approval or signed message
whose event was not found in that range, gets no Critical, and the verdict is amber (`history-incomplete`). An event
that no second RPC confirmed makes
the slot a storage gap, so the verdict goes amber rather than to a false Critical. An approved hash whose proven slot
is non-zero and that matches no `ExecutionSuccess` `txHash`: `pending-approved-hash`, with the nonce of a queued
transaction of the same hash when there is one. Queued Transaction Service transactions with nonce at or above the
current one: `queued-transaction`. Benign `signedMessages` slots: `signed-message`. "What this does not check" says
once that signatures never shared with any service cannot be seen.

**Diagnosis (5.11).** In order, stopping when everything is explained: (1) pass 2; (2) `debug_storageRangeAt`
enumeration, then prove every enumerated key and rebuild (a match proves the enumeration complete); (3) trace the
creation and every transaction in the history with `prestateTracer` in diff mode, prove every written key, rebuild;
(4) user candidates. Unknown keys are classified by trying `owners[a]` and `modules[a]` for every address seen in the
Safe's config, its events, the creation's calldata and the accounts the traces touched, and `approvedHashes[o][h]` and
`signedMessages[h]` for the hashes the events name (an approval or message slot without its exact event is Critical,
see Pending). A key classified as an owner or module entry outside the lists is `shadow-owner` or `shadow-module`; any
key still unknown is `unexplained-storage`. On 1.3.0, 1.4.1 and 1.5.0, every transaction that writes the Safe's
storage is the creation or emits a Safe event (`Execution*`, `ExecutionFromModule*`, `ApproveHash`), so no
internal-transactions index is needed (Blockscout's timed out at 125 s on the fixture Safe). Before 1.3.0 this does
not hold (`approveHash`, `signMessage` and a successful `execTransaction` emit nothing in 1.0.0), which is one reason
those Safes get `history-incomplete`. The root check itself stays exhaustive: a missed transaction can only leave a
slot unexplained (red), never hide one.

## 6. RPC layer

### 6.1 Endpoints

The pool for a chain: the user's primary and cross-check (if set), then the defaults from `chains.json` in rank order
(unless the user turned defaults off for that chain). Each endpoint has an operator id: the provider id for known
provider hosts (`drpc`, `publicnode`, `1rpc`, `blast`, `ethpandaops`, also for user URLs on those hosts),
`team:<domain>` for chain-team hosts, else `user:<registrable domain>`.

- Primary: the first endpoint that passes `eth_chainId` and proves the anchor.
- Cross-check: the first endpoint of another operator that passes `eth_chainId` and serves `eth_getBlockByNumber` at
  the anchor. The pair is never two aggregators (dRPC and 1RPC forward to unnamed upstreams). Proofs are not required:
  the header is what it must confirm. In the committed list, 52 chains have two proof-capable operators; counting
  header-only endpoints as cross-checks gives 65, including BNB, Unichain and Berachain, and keeps Ethereum at two
  operators (dRPC plus PublicNode) when Blast shuts down.
- No primary: stop with `no-rpc` and ask for the user's own RPC. No cross-check: run, verdict unverified
  (`single-operator`), with "add a cross-check RPC" as the action.
- Own node: the user can mark their own primary RPC as trusted alone. A user's own node is the strongest trust they
  can have, and a local anvil or node is a single operator. When no other operator confirms the header, the anchor's
  agreement is `self-trusted`: green is possible, and the banner and the verification section say the state was
  checked against the user's RPC only. Never available for a default RPC. When both RPCs are ones the user entered,
  the banner says so too.
- `localhost`, `127.0.0.1` and `[::1]` are one operator (`user:loopback`): two names for one machine never count as
  two operators.
- Independence is assumed, not proven: an aggregator (dRPC) may route to the same backend as the operator it is paired
  with. The verification section names both operators and says when one of them is an aggregator.

### 6.2 Transport

`src/data/transport.ts` is a `fetch` JSON-RPC client used through viem's `custom()` transport with `retryCount: 0`, so
viem actions and formatters (and the `GetProofReturnType` that `core/proof.ts` takes) stay, while timeouts, retries,
limits and classification are ours. Every failure throws `IoError`, which extends viem's `BaseError` without a `code`
field, so viem rethrows it unchanged (checked with viem 2.57.4).

- One JSON-RPC object per POST, never a batch array. `content-type: application/json` only, no credentials, no
  `Authorization` (a user RPC's key lives in its URL).
- Timeouts: 15 s per call; 30 s for `eth_getLogs` and `debug_*`; 6 s during chain detection; 20 s for APIs.
- Retries for transient kinds (section 7): 3 attempts, backoff 0.5 s then 1.5 s plus up to 0.25 s jitter.
  `Retry-After` is honoured up to 10 s; longer waits fail as `rate-limited` with the wait in the message.
- Limits: 4 in flight per host, 12 overall.
- Answers are read as a stream with a size cap: 32 MB, 128 MB for `eth_getLogs` and `debug_*`. A larger answer is
  `invalid-response` and is not read, so a hostile endpoint cannot fill the tab's memory.
- Every request goes to an in-memory call log (host, method, time, outcome), which the CLI prints with `--verbose`.

### 6.3 Capabilities

Probed lazily, the first time a step needs them, and cached per `(chainId, url)` for the page session:
`chainId` and `web3_clientVersion` once; proofs from the anchor attempt; archive `eth_call` from the first call at the
anchor; `eth_getStorageAt` on the cross-check; the `eth_getLogs` range by trying 10,000, then 1,000, then 100 blocks
ending at the anchor; `callTracer` and `prestateTracer` on the creation transaction; `debug_storageRangeAt` only in
diagnosis. State overrides are not probed: no step uses them.

### 6.4 Adaptive pin

1. `latest - 3` on the primary (`pinnedBy: offset`), or the user's block (`pinnedBy: user`).
2. On `proof-window` or `not-archive`: the same block on every other proof-capable endpoint. The first that proves it
   becomes the primary; the note says why.
3. Tip mode (`pinnedBy: tip`), when no endpoint proves the target. `eth_getProof` at `latest`, tied to its block by
   matching `keccak256(accountProof[0])` with the `stateRoot` of one of the last few headers. Measured on 2026-10-12
   against `ethereum-rpc.publicnode.com`, `base-rpc.publicnode.com` and `bsc-rpc.publicnode.com` (all three prove only
   the tip): 15 of 15 `latest` proofs matched a header at head-0 to head-2. A second proof at that same block number failed
   10 of 10 times on Base and BNB (the tip had moved) and 1 of 5 on Ethereum. So in tip mode the Safe's storage must be
   proven in one call that holds every key: each read of the Safe re-requests all keys asked so far, and the last read
   defines the anchor. Other accounts (singleton, owners, modules, handlers) are proven at their own block a few blocks
   later; the verification section lists those blocks. The cross-check confirms each block's header, and failover never
   moves a tip-mode proof onto the cross-check's operator, which would then confirm a block only it served. On 16
   chains the only proof-serving default RPCs prove just the newest block (Plasma, Arc, Holesky among them); the RPC
   refresh probes tip mode on each and records the result in `data/rpcs/refresh-meta.json`.
4. Header-only: anchor `latest - 3` agreed on headers, state read with `eth_getCode` and `eth_getStorageAt` (both RPCs,
   compared), every other check runs, verdict unverified. `Anchor.headerOnly` says why: `unsupported` (the chain's or
   the answers' proofs are not Merkle Patricia proofs: `root-check-unsupported`) or `no-proof-rpc` (no endpoint proves
   the block: `no-proof-rpc`, plus `unproven-read` on a chain whose proofs work). Every proven read then fails with
   one `method-unsupported` issue that says why.

A user block never moves: if no endpoint proves it, the run stops with the issue and suggests leaving the block empty. A
user block above every live endpoint's newest block stops with one plain issue ("Block is in the future") instead of
RPC errors.

### 6.5 Cross-check

Inline in every read, concurrent with the primary: header at the anchor (always), the same `eth_getProof` when the
cross-check serves proofs at that block (compare `storageHash` and values), else `eth_getStorageAt` per key, and
`eth_call` results when it serves archive calls. The creation transaction is compared too (from, to, input, block,
status). Each comparison is `match`, `mismatch`, `not-served` or `not-run`, summed up in `verification.coverage`. A
read served by an endpoint of the cross-check's own operator is `not-served`, never `match`: one operator would answer
both sides. Any mismatch is a `disagreement` issue and makes the verdict unverified.

### 6.6 Proofs

`core/proof.ts` verifies every account and storage proof against the read's anchor, always passing `root` to
`verifyMerkleProof` (without it a forged proof passes). A missing account is a proven absence. Scroll returns
`keccakCodeHash` instead of `codeHash`; the reader maps it. Before the run has verified a Merkle Patricia proof, proof
nodes that are not RLP lists (first byte `0x09` zkTrie, `0x0a` protobuf, objects), or a path that verifies to a leaf
that is not the four-field Ethereum account (Avalanche, Blast), are `non-mpt` for that endpoint, not a lie. After that,
such an answer is `proof-invalid`, so it can never open the path to unproven reads. While anchoring on a chain whose
root check is marked unsupported, a proof that does not verify is `non-mpt` too: the chain's format, not a lying RPC.
Any other failure is `proof-invalid`, and the verdict becomes unverified even if another endpoint's proof verifies.

### 6.7 Reorg re-check

After the last read, `recheckAnchor` re-reads the anchor's hash on both RPCs. Any answer with another hash means
changed; one answer with the same hash is enough for unchanged; no answer at all is a failed read. Changed: one restart
with a fresh pin (`restarted` event, the UI clears its partial report). Changed again: unverified (`reorg`).

### 6.8 Failover

When an endpoint fails a read with a kind that is about that endpoint (`ENDPOINT_KINDS` in `src/data/errors.ts`:
unreachable or rate-limited after retries, timeout, access-denied, server-error, method-unsupported, proof-window,
not-archive, block-unavailable, wrong-chain, invalid-response, non-mpt, proof-invalid, the key and plan kinds,
not-found and unknown), the reader repeats the read on the next endpoint and marks the issue `recovered`. Proven reads
move on after any failure except `cancelled`: an honest node never answers `eth_getProof` with a revert, so a primary
that does must not stop the read. A `proof-invalid` keeps the verdict unverified even when the next endpoint's proof
verifies. Proven reads are safe from any endpoint because they verify against the agreed anchor. With defaults off,
the pool holds only the user's RPCs.

Failover never moves onto the cross-check's operator: that operator would then answer both sides of a comparison. One
exception keeps a pinned run alive: when every other endpoint fails a proven read and the cross-check's own proof of the
same account verified against the agreed root, the read uses those values and marks both comparisons `not-served`.

### 6.9 Other services

- Blockscout API v2: base URL from `chains.json` (`blockscoutApi`), never `<chain>.blockscout.com` (Gnosis moved to
  `gnosisscan.io`; the old host 301s without CORS). Logs paged with `next_page_params`; `GET /addresses/<a>` gives
  `creation_transaction_hash`. Keyless, 180 requests per minute per IP on the instances seen. Called only when public
  indexers are on. Log items without a transaction hash (gnosisscan.io sends `""`) are not dropped: their blocks are
  read again from the RPC, and the read is never complete while such a block is unread.
- Safe Transaction Service: base URL from `chains.json` (`safeTxServiceApi`, from the Config Service
  `transactionService`; 7 of 54 chains use a segment other than the EIP-3770 name). `Authorization: Bearer` only with
  a user key. An invalid key is served as anonymous without any sign, so the UI cannot confirm a key works.
- Etherscan v2: `https://api.etherscan.io/v2/api?chainid=<id>`, key in the `apikey` query parameter, only with a key.
  Errors come as HTTP 200 with `status: "0"`; "No records found" is an empty success.
- Sourcify v2: `https://sourcify.dev/server/v2/contract/<chainId>/<address>`, keyless, only for unknown code and only
  when public indexers are on. It never makes a contract "known".
- Creation lookup order: Transaction Service `/safes/<a>/creation/` (when on), Blockscout address (when public
  indexers are on), then RPC: binary search for the first block with code (`eth_getCode`, about 25 calls on Ethereum,
  needs archive state) and `eth_getLogs` over that one block for the factory events. A hash from a service counts only
  once the RPC returns that transaction at or before the anchor.

### 6.10 History source

Chosen by cost, all in `src/data/logs.ts`:

1. RPC `eth_getLogs` when the range from creation to the anchor needs at most 50 chunks of the probed size.
2. Blockscout when the chain has a probed instance and public indexers are on.
3. Etherscan when the user gave a key and the chain is on their plan.
4. RPC anyway up to 1,000 chunks, then stop: partial, `history-incomplete`.

One read has a 90 s budget; public L2 RPCs with small log ranges otherwise take many minutes for an old Safe. A chunk
that fails on one endpoint moves to the next log-capable one outside the cross-check's operator. SPEC 5.10 orders RPC
first, but dRPC's free tier serves 100 blocks per call, so a Safe created a year ago on Ethereum would need about 26,000
calls. Every source is filtered to the Safe's own address (an indexer bug or a hostile RPC can return other contracts'
logs). An event that clears a finding, and an execution that spends an approval, count only when the cross-check RPC's
receipt for the transaction contains the same log (the primary's receipt when the run has no cross-check), so an
independent operator confirms them.

## 7. Errors

Every I/O call ends in data or in an `IoError` whose `issue` is a `ReportIssue`: kind, plain title, explanation,
actions, service, host, role, the operation in plain words, whether it was retried or worked around, and the raw
detail. The text is part of the report, so the UI, the Markdown summary and the CLI say the same thing. The UI shows
`{Role} RPC {host} could not {operation}: {title}. {explanation}`, the actions as buttons or links, and the raw detail
behind "Technical details".

Kinds, with the title, the explanation, what the user can do, and whether the transport retries. The texts for the
other services (Blockscout, the Transaction Service, Etherscan, Sourcify) name the service instead of the RPC.

- `unreachable`: **Could not reach the RPC.** No answer came from {host}. Most often the RPC does not accept requests
  from web pages (CORS), or it is down or misspelled. If it answered earlier in this run, the text adds that it is
  probably rate limiting you without saying so. Do: pick another RPC, add your own, retry in a minute. Retried only if
  it answered before.
- `csp-blocked`: **Address not allowed.** This site connects only to `https://` addresses and to `http://localhost` or
  `http://127.0.0.1`. Do: use an https RPC or a node on this computer. Not retried.
- `timeout`: **No answer in time.** {host} did not answer within {n} s. Do: retry, pick another RPC. Retried.
- `rate-limited`: **Rate limited.** {host} refused more requests from you for now; public RPCs limit requests per
  user. A `Retry-After` longer than 10 s is named. Do: wait a minute and retry, add your own RPC. Retried unless the
  wait is too long.
- `access-denied`: **Access denied.** {host} refused the request (HTTP {status}). It may need an API key, or it blocks
  requests from this site. Do: pick another RPC, add one with your key. Not retried.
- `server-error`: **RPC server error.** {host} failed with an internal error. Do: retry, pick another RPC. Retried.
- `method-unsupported`: **Not supported by this RPC.** {host} does not support {method}, needed to {operation}. Do:
  pick an RPC that supports it; otherwise this part is skipped. Not retried.
- `proof-window`: **Block too old for this RPC's proofs.** {host} serves storage proofs only for its newest blocks,
  and block {n} is older. Do: leave the block empty, pick an archive RPC. Not retried.
- `not-archive`: **Old state not available.** {host} no longer keeps the state of block {n}. Do: use a newer block,
  pick an archive RPC. Retried only for dRPC's "Unknown state", which passes on a retry.
- `block-unavailable`: **Block not available yet.** {host} does not have block {n} yet; it is behind the chain. Do:
  retry, pick another RPC. Retried. For a user block past every RPC's newest block: **Block is in the future.** Do:
  check the block number, or leave it empty.
- `range-too-large`: **Event range too large.** {host} rejected {k} blocks of events in one call. Handled: smaller
  ranges are tried.
- `wrong-chain`: **Wrong chain.** {host} serves chain {actual}, not {expected}. Do: check the URL, pick another RPC.
- `invalid-response`: **Unreadable answer.** {host} sent an answer the tool could not read (an HTTP 404 says there is
  no RPC at this address; an answer over the size cap says so). Do: check the URL, pick another RPC.
- `proof-invalid`: **Proof did not verify.** The proof from {host} does not match the block's state root: the RPC
  sent wrong data, and this run is not verified. Do: pick another RPC.
- `non-mpt`: **Proofs in another format.** {host} returned proofs that are not Ethereum Merkle Patricia proofs; this
  chain or this node stores state differently. Do: pick another RPC; the other checks still run.
- `disagreement`: **RPCs disagree.** {hostA} and {hostB} returned different {what} for block {n}; one is wrong or out
  of sync. Do: retry, pick another cross-check RPC.
- `reverted`: **Call reverted.** The call to {operation} reverted; usually the contract has no such function. Often
  expected.
- `key-required`: **API key needed.** {service} needs an API key for this (an RPC: an API key or a paid plan). Do: add
  a key in settings, or skip.
- `key-rejected`: **API key rejected.** {service} rejected the key. Do: check the key. A key with a character that
  cannot be sent in a header: **API key cannot be sent**, and nothing is sent.
- `plan-unsupported`: **Not on the free plan.** {service} does not serve this chain on the free plan. Do: use
  Blockscout or your own RPC.
- `not-found`: **Not found.** {service} has no record of this.
- `cancelled`: not shown; a new run started.
- `unknown`: **Unexpected error.** {host} failed with an error this tool does not recognise; the technical details
  show its answer. Do: retry, pick another RPC. The RPC's own words stay in the raw detail and never enter the plain
  text.

Classification (`src/data/errors.ts`, pure, tested against a corpus of real answers recorded by the probes): the URL
scheme is checked before `fetch` (`csp-blocked`); a `TypeError` from `fetch` is `unreachable`; our timer's abort is
`timeout`, the run's abort is `cancelled`. Message rules run first: "proof window" or "distance to target block" is
`proof-window`; block range and result-size messages are `range-too-large`; rate limit, usage limit, quota or too many
requests is `rate-limited`; "personal token" is `key-required`; "missing trie node", "Unknown state", "historical
state" and "archive" are `not-archive`; "header not found" and "unknown block" are `block-unavailable` (geth sends them
for blocks the node does not have yet); "method ... not found / not supported / not available / not whitelisted" is
`method-unsupported`; "execution reverted" is `reverted`. Then JSON-RPC codes: 3 is `reverted`, `-32005`
`rate-limited`, `-32601` and `-32004` `method-unsupported`, bare `-32603` `server-error`. Then HTTP status: 429
`rate-limited`, 401 and 403 (also Cloudflare challenges) `access-denied`, 402 `key-required`, 408 `timeout`, 5xx
`server-error`, 404 from an API `not-found`. A `-32602` with "proof window" is `proof-window`, because message rules
come first.

Redaction: a user RPC's path and query never leave `settings.ts` and the transport. `raw.url` keeps the full URL for
defaults (public, in the repo), only the origin for user RPCs, and drops `apikey` from API URLs. Raw messages and
bodies have the user URL's path, query, every path segment of 8 or more characters and any configured key replaced,
and are cut to 500 characters. API keys must be printable ASCII: the settings refuse others, and the Transaction
Service client sends nothing with one.

## 8. Input and chain detection

`parseInput` accepts: a bare address; `shortName:0x...` (EIP-3770 short names plus the Safe{Wallet} aliases, for
example `matic` for 137); a Safe{Wallet} URL with a `safe=` query (`https://app.safe.global/home?safe=eth:0x...`, any
path); the permalink, alone or as a full URL. A mixed-case address must pass the EIP-55 checksum ("The capital
letters do not match the address checksum; check for a typo, or paste the address in lower case."); all lower or all
upper case is accepted. A chain in the input that differs from the chain picker is an error, not a silent choice.

`detectChains` runs when no chain is known:

- Phase "popular": the Safe{Wallet} chains with a default RPC, ordered by `detectRank` (a short hand list of the most
  used chains first, then the rest by Safe{Wallet} order). Phase "all": every chain with a default RPC, only after a
  click, because the address goes to each chain's RPC.
- Per chain: `eth_getCode(latest)` on the first default RPC (the second if the first fails), then slot 0 when there
  is code. A known SafeProxy code hash is a Safe; else slot 0 holding a known singleton address is a Safe; other code
  is "contract"; none is "empty". Six chains at a time, 6 s timeout, two attempts per call. Detection always uses the
  default RPCs, whatever the user's RPC settings. A chain whose RPC fails is listed as an error; the other chains'
  results stay. These reads are unproven: detection only picks the chain, and the run proves everything again.
- One Safe found: run on it. Several: list them (chain, version) and let the user pick. None: "No Safe at this address
  on the N chains tried", with "Search all chains" and the chain picker.

## 9. Generated data

All generated files are committed: the Cloudflare build fetches no chain or registry data, so it is reproducible, and
every change is reviewed as a diff. `.gitattributes` marks `src/data/generated/**` as generated so GitHub collapses it.

### 9.1 `src/data/generated/chains.json` (`ChainsFile` in `src/data/types.ts`)

- Generator: `scripts/refresh-rpcs.ts`. Sources: chainlist `rpcs.json`, `chainid.network/chains.json` (chains
  chainlist drops), `chains.blockscout.com`, the Safe Config Service chain list, and the installed safe-deployments
  assets.
- Trust policy (`scripts/lib/rpc-policy.ts`, applied in order, first failing rule recorded): https; no key or key
  template in the URL; not tracking (`limited` only from an allowlisted provider); not a relay or MEV endpoint; run by
  an allowlisted provider or by the chain team (the registrable domain of the chain's chainlist `infoURL`, plus
  sourced aliases). The curated archive RPCs for Ethereum, Gnosis and Sepolia win when they pass the probe.
- Probe (`scripts/lib/rpc-probe.ts`): chain id, CORS preflight and POST from a browser origin, the header at
  `latest - 3`, and `eth_getProof` there verified with `core/proof.ts`; tip mode where only the newest block is
  proven; Blockscout instances checked by chain. Endpoints that pass all but the proof stay as `proofs: false`
  (cross-check candidates).
- Runtime file: about 380 KB as committed, 27 KB gzip, with no timestamps. It is bundled into the lazy chunk that
  holds the data layer.
- `data/rpcs/refresh-meta.json` (committed): source URLs with fetch time, ETag and sha256, the filter policy, filter
  counts, coverage, probe times. The full probe output, `rejections.json` and the source snapshots are written to
  `--out-dir`, not the repo.
- Refresh by hand (`npm run rpcs:refresh`, about ten minutes) monthly and before each release. Review: the diff of
  `chains.json` (RPCs added, removed, re-ranked) and the coverage counts. A chain with no passing default RPC says so
  plainly in the UI and asks for the user's own RPC.

### 9.2 `known-contracts.json` and `data/registry/codehashes.json`

- Generator: `scripts/build-registry.ts`. Reads safe-deployments `src/assets` (not `dist`: two 1.1.1 files are not
  wired into `dist`), safe-modules-deployments `src/assets`, Zodiac `CanonicalAddresses` through its public API, and
  checks `src/data/reviewed-contracts.json` (section 9.3).
- Code hashes: safe-deployments ships them. Safe-modules-deployments and Zodiac do not, so the script reads
  `eth_getCode` once on chains 1, 100 and 11155111 (else on a chain the package lists for that address) at a pinned
  block and records chain and block in `data/registry/codehashes.json` (address to `{ codeHash, chainId, block }`).
  SafeProxy runtimes are derived by a deployless `eth_call` of `proxyCreationCode() ++ abi.encode(singleton)`; the two
  zkSync proxy hashes are sampled constants. Later runs hit the network only for addresses missing from the cache.
- Output is deterministic: sorted by id, no timestamps. CI runs `npm run registry:build -- --offline --check`, which
  rebuilds from the packages and the cache and fails on any difference; a unit test checks that `packages[].version`
  equals the installed versions. A package bump therefore fails CI until someone runs `npm run registry:build` and
  commits the result.
- The ABIs the checks decode are not generated: `src/core/abis.ts` holds only the functions and events the checks call
  or decode.

### 9.3 `src/data/reviewed-contracts.json`

A short hand-reviewed list of contracts no package knows, for example the RealityVetoModule on both regression Safes.
Each entry (`ReviewedContract`) names chain, address, code hash, source link, a note, the reviewer (`reviewedBy`) and
the review date (`reviewedOn`, YYYY-MM-DD). Contracts with immutables have a different code hash per deployment (the
veto module stores the Safe, the Reality module and the vetoer), so an entry matches only on chain, address and code
hash together. The UI shows these as "reviewed list", never as official.

An entry counts only once a maintainer signed it off: both `reviewedBy` and `reviewedOn` set. Until then the loader
(`src/data/reviewed.ts`) leaves it out and the contract shows as unknown, because a "reviewed" label nobody reviewed
misleads the user who trusts it. `registry:build` refuses an entry with only one of the two fields, a date that is not
YYYY-MM-DD, or a placeholder reviewer, and, online, a code hash that differs from the code on that chain.

## 10. Identification

1. Look up the proven code hash in the registry. Package entries match on code hash alone; one hash can name several
   entries (canonical and eip155, Zodiac versions that share code). Reviewed entries also need chain and address.
2. EIP-1167 code (45 bytes, `363d3d373d3d3d363d73<impl>5af43d82803e903d91602b57fd5bf3`): prove the implementation's
   code hash and look that up (`via: eip1167`).
3. EIP-7702 code (`0xef0100` plus 20 bytes): a delegated EOA; the delegate is identified for display only.
4. Address hint: listed with the same code (`listed`), known code at another address (`other-address`, normal: real
   Safes use canonical code at non-canonical addresses), or a listed address with different code (`listed-code-differs`,
   `codehash-mismatch`).
5. Unknown code gets the Sourcify status and a link.

## 11. Verdict and severity

Precedence: unverified, then unexplained, then explained. A red verdict must rest on verified state, so a lying RPC
cannot turn the banner red; a mismatch seen without a verified anchor shows as amber with the mismatch as a reason.

- **Storage fully explained (green):** anchor agreed by two operators (or `self-trusted`, section 6.1), every proof
  verified, no disagreement, proxy and singleton known and supported, every owner, module, guard and handler
  inspected, root matched in pass 1, pass 2 or diagnosis with every extra slot benign, reorg check unchanged.
- **Unexplained storage (red):** verified anchor and proofs, and a root mismatch remains after pass 2 with a slot that
  is not benign (unknown, or classified as a shadow entry). When the history was not read in full and no unknown slot is a
  shadow entry, the next reason says how far the history was read and that an older approval or signed message may
  explain the slots, with "Test candidates" as the way to settle it. The verdict stays red: the extra slot is proven to
  exist, and amber would soften a real hidden write.
- **Could not verify (amber):** any `UnverifiedReason`: root check unsupported on the chain, no proof-capable RPC, one
  operator, RPCs disagree (any comparison, code hashes and transactions included), a proof did not verify, unsupported
  version, unknown proxy or singleton, two reorgs, a read the verdict needs failed, an owner, module, guard, module
  guard or fallback handler that could not be inspected (`inspection-incomplete`, naming the address and the failed
  call), state read without a proof on a chain whose proofs work (`unproven-read`), or an approval or signed message
  whose event may lie outside the history read (`history-incomplete`). Each reason is listed. A user reads green with 0
  Critical as "nothing to worry about", so green must never rest on a read that did not happen.

The banner also shows the finding counts by severity, so a green verdict with a Critical finding (for example an EOA
module, whose slots are all explained) never reads as "all good".

Severity per finding code:

- **Critical:** `shadow-owner`, `shadow-module`, `eoa-module`, `singleton-not-canonical`, `proxy-not-canonical`,
  `module-public-forwarder` (a module whose code forwards any caller's calls, such as MultiSendCallOnly: anyone can call
  `execTransactionFromModule` through it), `approval-without-event` and `signed-message-without-event` (an
  `approvedHashes` or `signedMessages` slot that no event names exactly: it acts as an owner's signature, or an
  EIP-1271 signature of the Safe, that nobody gave).
- **High:** `unexplained-storage`, `unknown-module`, `unknown-fallback-handler`, `setup-delegatecall-unknown`,
  `config-without-event`, `module-owner-not-safe`, `list-corrupt`, `getter-mismatch`, `owner-count-mismatch`,
  `threshold-invalid`, `slot6-unexpected`, `codehash-mismatch`.
- **Medium:** `unknown-guard`, `unknown-module-guard`, `delegated-owner`, `contract-owner`, `pending-approved-hash`,
  `queued-transaction`, `factory-not-canonical`, `creation-callback-unknown`, `faulty-version`,
  `config-without-event-unconfirmed` (the setting's event is missing from an indexer's history, which can drop events;
  `config-without-event` is High only when node logs cover the full range).
- **Info:** `setup-payment`, `version-behind` (only when a newer supported version is deployed on that chain),
  `inert-owners`, `legacy-domain-separator`, `passkey-signer-slots`, `signed-message`, `handler-keeps-own-state`,
  `history-incomplete`, `same-address-other-chains`.

Severity is a fixed function of the code; `src/core/findings.ts` holds the catalogue (severity, plain title,
explanation).

## 12. Corrections to SPEC.md section 5

From the research into the packages: 5.2 accepts any known SafeProxy runtime; 5.3 classifies slot 6 and reads the
module list from raw storage; 5.4 and 5.11 add the shared passkey signer's three slots; 5.8 takes Safe4337Module from
safe-modules-deployments; 5.9 decodes every factory entry point by version (section 5, Creation); 5.10 adds four
topics, decodes both event shapes and expects no `SafeSetup` before 1.3.0; 5.10 also picks the history source by cost
(section 6.10).

## 13. Invariants

Each is written to be checked by a test.

1. **Root claim.** If `storage.matchedBy` is set, `storageRoot` of the rows from that pass equals `storage.actualRoot`,
   and all those rows come from one proven read with that `storageHash`.
2. **Anchor.** A green verdict implies `verification.agreement === "agreed"` (two endpoints with different operator
   ids, not both aggregators, returned the same hash and `stateRoot` for the anchor number) or `"self-trusted"` (the
   user marked their own primary as trusted alone, and no other operator confirmed the header).
3. **Proof binding.** Every row with `proven: true` was returned by `verifyStorageProof` against the read's
   `storageHash`, and that account by `verifyAccountProof` against the anchor's `stateRoot`; `verifyMerkleProof` is
   never called without `root`.
4. **User block.** With a user block, every proven read is at that block or the run stops.
5. **Identification.** A contract is `known` only if its proven code hash, or its EIP-1167 implementation's proven code
   hash, is in the registry. An address match alone never makes it known.
6. **Severity and verdict are functions.** Severity depends only on the finding code; the verdict depends only on the
   findings, the storage passes and the verification section.
7. **No check that cannot fail.** Every finding code and every unverified reason has a unit test that triggers it, and
   every case in SPEC 11.3 has an anvil case.
8. **Secrets.** No API key and no user RPC path or query appears in the report JSON, the permalink, the Markdown
   summary or any `raw` field. Test: a user RPC `https://host/SECRET?key=SECRET` and an Etherscan key `SECRET`, then
   search the serialised report and the Markdown for `SECRET`.
9. **Keyed APIs and indexers.** No request to Etherscan without a key. No request to the Transaction Service when it
   is off. No request to Blockscout or Sourcify when public indexers are off. No `Authorization` header without a key.
10. **No batching.** Every request body is one JSON object, never an array.
11. **Classification coverage.** Every error in the recorded corpus classifies to a kind other than `unknown`.
12. **Registry reproducible.** `registry:build --offline --check` exits 0 on a clean checkout.
13. **JSON round trip.** `JSON.parse(JSON.stringify(report))` deep-equals `report`.
14. **Detection consent.** Phase "all" never runs without a user action.
15. **Single block per pass.** All values in one root rebuild share one `storageHash` and one block.

## 14. Security headers and privacy

`public/_headers` for `/*` (and, for `/assets/*`, whose file names carry a content hash,
`Cache-Control: public, max-age=31536000, immutable`):

- `Content-Security-Policy: default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src https: http://localhost:* http://127.0.0.1:*; frame-ancestors 'none'; base-uri 'none'; form-action 'none'`.
  Loopback lets a user's own node or anvil work on the deployed site: browsers treat it as a secure origin, so it is
  not mixed content. Whether a browser's local network access prompt allows it was not tested.
- `Permissions-Policy`: deny everything except `clipboard-write=(self)` for "Copy Markdown".
- `Referrer-Policy: no-referrer`, `X-Content-Type-Options: nosniff`.

Privacy text in the UI lists exactly where the Safe address goes with the current settings: the user's RPCs, the
chain's default RPCs unless they are off, the Transaction Service when it is on, Blockscout and Sourcify when public
indexers are on, Etherscan with a key, and, with no chain chosen, the default RPCs of the chains detection asks. "Search
all chains" and "Check other chains" send it to every chain's default RPC, only on a click. Nothing goes to the host:
the permalink sits in the URL hash.

## 15. Tests

Every test must bite: break the behaviour, see it fail, restore. CI runs `npm run check`, the registry offline check,
the unit tests, the build and the Playwright smoke test on every pull request; the live (`LIVE=1`) and anvil suites
run on demand. The README lists the commands.

### Data (`src/data/__tests__`)

- Unit: `classify` over the recorded error corpus; retry, backoff and `Retry-After` with fake timers; the size cap; no
  batch arrays; pair rules (another operator, never two aggregators, loopback as one operator, defaults off); pin
  order with a fake RPC (offset, failover, tip mode by root match, header-only, a user block never moves, a user block
  in the future); failover never onto the cross-check's operator; proof failures map to `proof-invalid` or `non-mpt`;
  cross-check comparisons; event sources keep only the Safe's logs and confirm on the cross-check's receipts; a
  `parseInput` table (bare, bad checksum, EIP-3770 with aliases, Safe{Wallet} URL, permalink, garbage); detection
  order and match rule; settings validation, including API keys; no public indexer when they are off; redaction
  (invariant 8); the `chains.json` schema and policy (https only, no key templates, no aggregator pairs); the reviewed
  list sign-off rule.
- Live: the Reward Distribution Safe at block 26176126 on dRPC plus Blast gives root `0x4321ab74...693e`; the Gnosis
  team RPC (short proof window) pins at `latest - 3`; tip mode on `ethereum-rpc.publicnode.com`.

### Checks (`src/core/__tests__`, `src/check/__tests__`)

- Unit, with the SPEC appendix B slot maps and fixture registries: every proxy hash, including an upgraded Safe on a
  1.1.1 proxy; slot 6 legacy and unexpected; 1.3.0 module paging; owner kinds (7702, precompile, Safe); EIP-1167
  resolution; `codehash-mismatch`; history replay with both event shapes and a mixed upgraded Safe; no `SafeSetup`
  before 1.3.0; pass 2; an approved hash matched to `ExecutionSuccess`; diagnosis with fake enumeration and traces;
  candidate classification; every finding code and unverified reason (invariant 7); verdict precedence; the event
  order of `runCheck` with fake deps, including a reorg restart.
- Live: the Reward Distribution Safe through the whole pipeline; the SEF Safe (1.5.0) gives root
  `0xc05a109c...40af`; a Gnosis Safe with Blockscout history.

### UI (`src/ui/__tests__`, `e2e/`)

- Unit: components over fixture reports, every section state (`complete`, `partial`, `unavailable`, `skipped`), every
  issue kind with its technical details toggle, streaming without layout shift; `reportToMarkdown` snapshots.
- Playwright smoke test (`e2e/smoke.spec.ts`): the built fixture page under the CSP from `public/_headers`, 400 px
  width, both themes, the keyboard path, no layout-shift entries while a fixture stream plays.

### Anvil suite (`test/anvil`)

- A fresh anvil, not a fork (a fork's `eth_getProof` after a local write can return a wrong root). Canonical contracts
  are placed from runtime code recorded once from mainnet, so their proven code hashes match the registry. Safes are
  created through the canonical factories at 1.3.0, 1.4.1 and 1.5.0 with a real `setup` call, and owners act with
  real signatures. The state is moved to a second anvil without zero-valued slots, which anvil otherwise keeps in the
  storage root.
- Every case of SPEC 11.3, plus MultiSendCallOnly as a module and a single operator without own-node trust, each
  asserting the verdict and the finding codes, through `startCheck` with the anvil as the user's own node. Anvil
  serves `prestateTracer` traces but not `debug_storageRangeAt`, so enumeration is covered only by unit fakes.
- Playwright (`e2e/anvil.spec.ts`, `ANVIL_E2E=1`): the clean and shadow-owner Safes through the real app with the
  anvil as the user's RPC; checks the banner and the storage table.

## 16. Follow-up list

Not in this design, kept for later PRs:

- Per-chain Optimistic Governor and Tellor addresses from Zodiac 4.0.3.
- Whether the RPCs Safe{Wallet} itself uses (Config Service `publicRpcUri`, keyless only) count as trusted defaults;
  they add a passing endpoint on 7 chains.
- A third Ethereum provider for the cross-check after Blast shuts down (header-only PublicNode covers it for now).
- Reading ExtensibleFallbackHandler's per-Safe configuration instead of only naming it.
- A known-guards source beyond Zodiac (the Safe{Wallet} guard list, if one is published).
- `vite preview` serving `public/_headers`, `.npmrc` with `save-exact=true`, `.claude/` in `.gitignore`.
- Whether the CLI becomes a published package (default no).
