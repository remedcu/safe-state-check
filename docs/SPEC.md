# Safe State Check: product spec

What the tool must do, written on 2026-10-12 before the build, from two manual reviews that proved "no hidden state" by hand: the SafeDAO Safe on Gnosis Chain and the Reward Distribution Safe on Ethereum. This tool does the same automatically.

- Audience: both general Safe users and reviewers. The verdict comes first; the detail sits below it.
- Chains: every chain in `@safe-global/safe-deployments`.
- Safe versions: 1.3.0, 1.4.1 and 1.5.0, L1 and L2 singletons. Older versions are shown as unsupported.
- No backend: a static site on Cloudflare, with GitHub as the source.

[ARCHITECTURE.md](ARCHITECTURE.md) is the design that implements this spec. Research during the build corrected parts of section 5; its section 12 lists the corrections, and the design wins where the two differ. Section numbers start at 2 because code and tests cite them.

## 2. How the check works

The core idea fits in one paragraph. Every contract account has a **storage root**: one hash that commits to every non-zero storage slot. `eth_getProof` returns it as `storageHash`.

A Safe's visible configuration tells you which slots must exist and what they hold:
- its owners, threshold and nonce
- its modules
- its guard, module guard and fallback handler
- its singleton

The tool rebuilds a storage trie from exactly those slots and compares the rebuilt root with the real one:

- **Match:** the Safe has no other storage. There is no owner or module entry outside the linked lists, no hidden guard and no leftover from a setup delegatecall. This holds for every possible slot, not only the ones we thought to check.
- **Mismatch:** at least one more slot exists, or one slot holds a different value. The root says *that* something is there, not *what*. Benign causes:
  - a pre-approved hash (`approveHash`)
  - a signed message (SignMessageLib)

  Malicious causes:
  - a shadow owner
  - a shadow module
  - a guard written without its event

  Section 5.11 is how the tool narrows it down.

**Why shadow entries matter.** The getters (`getOwners`, `getModulesPaginated`) walk the linked lists. A mapping entry outside the list is invisible to them, but the Safe still honours it:

| Version | Shadow owner `owners[x] != 0` | Shadow module `modules[x] != 0` |
|---|---|---|
| 1.3.0 | counts as a signer: `GnosisSafe.sol:301` (GS026 check only tests `owners[currentOwner] != address(0)`) | can execute: `ModuleManager.sol:68` |
| 1.4.1 | counts as a signer: `Safe.sol:331`; `isOwner` returns true (`OwnerManager.sol:140-142`) | can execute |
| 1.5.0 | counts as a signer: `Safe.sol:338` | can execute: `ModuleManager.sol:104` (GS104) |

(Paths are in `safe-global/safe-smart-account` at the version tags.)

**What a match does not prove.** The root covers storage only. Code (singleton, modules, guard, fallback handler, owner contracts), owner key security and signatures held offchain need their own checks (sections 5.2, 5.6 to 5.10). Say this in the UI.

## 3. Threat model

| Threat | How the tool sees it |
|---|---|
| Shadow owner or shadow module written by a setup delegatecall (`setup` `to` and `data`) or by a later delegatecall transaction | Root mismatch. Creation decode flags a non-standard `to`. History trace finds the slot. |
| Guard, module guard or fallback handler written by raw `sstore` without the event | The getter-equivalent slot read still shows it (these are fixed slots), and the event history lacks it, so the tool flags the missing event. |
| Non-canonical singleton or proxy | Codehash check against safe-deployments. |
| Unknown or malicious module, guard or fallback handler set openly | Identification against known deployments. A malicious fallback handler can answer `isValidSignature` for anything, so offchain signatures "by the Safe" could be forged; rate unknown handlers High. |
| A module that is an EOA | One key controls the Safe without signatures. Critical. |
| Owner that is a contract or an EIP-7702 delegated EOA | Show the type, the delegate, and for owner Safes their own owners (one level). |
| Pre-approved hash for a future transaction | Benign slot, but list it: an approved hash for nonce >= current is a pending action. |
| Pending transactions in the Safe Transaction Service | Optional data source. Signatures never shared anywhere cannot be seen; say so. |
| A lying RPC | Two independent RPCs must agree on block hash, `storageHash` and slot values. Verify every Merkle proof locally (section 5.5). |
| The same address on other chains (`createProxyWithNonce` replay) | Optional: report where the address has code, and whether the owners match. |

Out of scope: auditing module source code, owner key custody, offchain governance.

## 4. Product scope

- **Input:**
  - Safe address and chain.
  - Optional block number; the default is a recent pinned block (section 5.1).
  - Optional custom RPC URLs, for a primary and a cross-check RPC.
- **Output:**
  - a verdict banner
  - summary cards
  - detail sections
  - a downloadable JSON report, plus a Markdown summary for pasting into reviews
- **Permalink:** `/#/<chainId>/<address>` or `/#/<chainId>/<address>@<block>`. The hash keeps it client-side; Cloudflare never sees the address in a request path.
- **No wallet connection:** the tool is read-only and never asks for a signature.
- **No backend:** every call goes from the browser to RPCs and public APIs. Optional API keys (for example Etherscan) stay in `localStorage`, never in the URL or the repo.

## 5. Checks

### 5.1 Inputs and pinning
- Validate the address checksum and the chain id. Reject a non-contract or "not deployed" with a clear message.
- Pin one block for every read: `latest - 3` by default.
  - Many public RPCs serve `eth_getProof` only for recent blocks. The Gnosis official RPC answered "distance to target block exceeds maximum proof window" for a 2-week-old block, and PublicNode allows only a short window.
  - Record the block number, hash and timestamp. Re-read the block hash at the end; if it changed (reorg), redo the run.
- Probe each RPC once per chain and cache the result for the session. Probe for:
  - archive `eth_call` and `eth_getProof` at the pinned block
  - an `eth_getLogs` range limit (try 10,000, then 1,000, then 100 blocks)
  - `debug_traceTransaction` with `prestateTracer`
  - `debug_storageRangeAt`
  - state overrides in `eth_call`

### 5.2 Code identity
- Proxy: the runtime codehash must be one of the SafeProxy runtimes for that version (from safe-deployments `safe_proxy_factory` `proxyCreationCode`, runtime part).
- Singleton: read slot 0 directly (`eth_getStorageAt` or the proof), not `masterCopy()`. Its codehash must equal `deployments.<type>.codeHash` in safe-deployments for `safe` or `safe_l2` at 1.3.0, 1.4.1 or 1.5.0 (`canonical`, `eip155` or `zksync` deployment types).
- `VERSION()` must match the singleton's version.
- Anything else: unsupported or unknown, verdict "Could not verify" plus a red flag.

### 5.3 Configuration reads (all at the pinned block)
- `getOwners()`, `getThreshold()`, `nonce()`.
- `getModulesPaginated(0x1, pageSize)`: loop until `next == 0x1`, with a hard cap and cycle detection.
- Slots: guard `0x4a204f62…34c8`, fallback handler `0x6c9a6c4a…18d5`, and module guard `0xb104e0b9…9947` (1.5.0 only); full values in appendix A.
- `ownerCount` (slot 3) must equal the number of owners. `threshold` (slot 4) must be at least 1 and at most `ownerCount`.
- Slot 6 (deprecated domain separator) must be 0 for 1.3.0 and later.
- Balances: native and nothing else at launch.

### 5.4 Storage accounting
Build the expected slot set, then read every value from `eth_getProof` with those keys. One call returns `storageHash` and the values at the same block.

| Slot | Key | Expected entries |
|---|---|---|
| singleton | `0x00…00` | 1 |
| ownerCount | `0x00…03` | 1 |
| threshold | `0x00…04` | 1 |
| nonce | `0x00…05` | 1 if nonce > 0 |
| owners linked list | `keccak256(abi.encode(addr, 2))` for `0x1` and every owner | owners + 1 |
| modules linked list | `keccak256(abi.encode(addr, 1))` for `0x1` and every module | modules + 1 (an empty list still has `modules[0x1] = 0x1`) |
| fallback handler | fixed slot | 1 if set |
| guard | fixed slot | 1 if set |
| module guard (1.5.0) | fixed slot | 1 if set |
| signedMessages | `keccak256(abi.encode(msgHash, 7))` from `SignMsg` events | per event, if still non-zero |
| approvedHashes | `keccak256(abi.encode(hash, keccak256(abi.encode(owner, 8))))` from `ApproveHash` events | per event, if still non-zero |

- Check the linked lists from the raw values too: `owners[0x1]` is the first owner, each entry points to the next, and the last points to `0x1`. Do the same for modules.
- Show the formula in the UI, for example: "Expected non-zero slots: 10 = 1 singleton + 1 owner count + 1 threshold + 1 nonce + 2 owner entries + 3 module entries + 1 fallback handler." The count is for reading only; the root comparison is the check (a root cannot be counted).
- Rebuild the root: a secure Merkle Patricia trie, where the key is `keccak256(slot)` and the value is `rlp(value with leading zeros stripped)`, omitting zero values. Use `@ethereumjs/mpt` (the successor of `@ethereumjs/trie`; 10.1.3 on npm, 2026-08-21) or an own small implementation. Either way it must reproduce every fixture in appendix B before anything else is built.
- Run it twice:
  1. With configuration slots only.
  2. If that mismatches, with event-derived slots added (5.10).

  Report which pass matched.

### 5.5 Proofs and RPC trust
- Verify the account proof against the block's `stateRoot` locally, and every storage proof against `storageHash` locally.
- Read the same block from a second, independent RPC operator. Block hash, `stateRoot`, `storageHash` and all slot values must match. Show both operators in the "Verification" section.
- If a chain's storage proofs do not verify as a standard MPT (some L2s used other tries), mark the root check unsupported for that chain and say why. Do not guess.

### 5.6 Owners
For each owner:
- Type: EOA (no code), EIP-7702 delegated EOA (code `0xef0100` + delegate address; show the delegate and warn), contract, or precompile (for example `0x…02`, the usual inert owner).
- Contract owners: if it is a Safe (`VERSION()` and `getOwners()` answer), show its version, owners and threshold one level deep. Otherwise show "contract owner, not inspected".
- Highlight an inert-owner setup (only `0x…02` or similar): only modules can act. Show what that means in plain words.

### 5.7 Modules
For each module:
- EOA module: Critical.
- Contract: identify it against `@safe-global/safe-modules-deployments` (allowance, 4337, social recovery, and so on) and `@gnosis-guild/zodiac` mastercopies. Detect EIP-1167 proxies and resolve the mastercopy.
- Zodiac modules: read `owner()`, `avatar()`, `target()` and `getGuard()`. Flag an owner that is not the Safe. For the Reality module, also show the oracle, template, timeout, cooldown, expiration, minimum bond and arbitrator.
- Unknown: High, with the codehash and a link to Sourcify (`https://sourcify.dev/server/v2/contract/<chainId>/<address>`; `"exact_match"` is exact, `"match"` is partial).

### 5.8 Guard, module guard, fallback handler
- Identify each against safe-deployments (CompatibilityFallbackHandler, ExtensibleFallbackHandler, Safe4337Module as handler) and known guards.
- Unknown fallback handler: High (see section 3). Unknown guard: Medium (it can block transactions, including the owner swap).

### 5.9 Creation transaction
Find it from the factory's `ProxyCreation` or `ProxyCreationL2` event, or from the Safe Transaction Service `/safes/<a>/creation/`. Decode the factory call and the `setup` initializer:
- owners and threshold
- `to` and `data`
- fallback handler
- `paymentToken`, `payment`, `paymentReceiver`

Flag:
- A non-zero `to` that is not a known setup helper (SafeToL2Setup, SafeModuleSetup for 4337, MultiSend for module setup): High. A delegatecall at setup can write any slot.
- Any payment: Info, unless the receiver is unexpected.
- A factory that is not canonical, or `createProxyWithCallback` with an unknown callback.
- If tracing is available, show the creation transaction's storage diff for the Safe.

### 5.10 History and pending actions
- Event sources, best first:
  1. The RPC's `eth_getLogs` in chunks sized by the probe.
  2. Blockscout API v2 for the chain (`/api/v2/addresses/<a>/logs`, paged with `next_page_params`).
  3. Etherscan v2 with a user key.
- Do not use Blockscout `counters`: they reported 0 transactions for active addresses in the Mainnet review.
- Events needed:
  - `SafeSetup`
  - `AddedOwner`, `RemovedOwner`, `ChangedThreshold`
  - `EnabledModule`, `DisabledModule`
  - `ChangedGuard`, `ChangedModuleGuard`, `ChangedFallbackHandler`, `ChangedMasterCopy`
  - `ApproveHash`, `SignMsg`
  - `ExecutionSuccess`, `ExecutionFailure`
  - `ExecutionFromModuleSuccess`, `ExecutionFromModuleFailure`

  Topics are in appendix A; take the ABIs from safe-deployments per version.
- Rebuild the configuration from the event history and compare it with the current state. A guard, handler or module present now but never announced by an event is a red flag.
- Safe Transaction Service (optional; CORS was open on 2026-10-12, but it may start requiring an API key): queued transactions with nonce >= current, messages, delegates. List approved hashes and queued transactions as "pending actions".

### 5.11 When the root does not match
Run these in order and stop at the first that explains everything:
1. Add event-derived `approvedHashes` and `signedMessages` slots (5.10) and rebuild.
2. If the RPC supports `debug_storageRangeAt` (usually only your own node), enumerate every slot directly. Each one is then known; classify each.
3. If the RPC supports `debug_traceTransaction` with `prestateTracer` and `diffMode: true`:
   - list every transaction that touched the Safe (creation, `execTransaction`, module executions, and calls into it found via Blockscout `internal-transactions`)
   - trace each one and collect every slot written on the Safe
   - read current values, rebuild, compare
   - classify unknown slots by trying preimages: `keccak256(abi.encode(a, 1|2))` and the approvedHashes and signedMessages forms, for every address and hash seen in those traces
4. Let the user test candidates: paste addresses or hashes, and the tool computes and reads their owner, module, approvedHash and signedMessage slots.
5. If still unexplained: verdict "Unexplained storage". List what was tried and which RPC capabilities were missing.

### 5.12 Optional cross-chain look
For each chain in safe-deployments with a default RPC, report whether the address has code there and whether its owners match. Run it on demand, not by default (it costs many calls).

## 6. Verdict rules

| Verdict | When |
|---|---|
| **Storage fully explained** (green) | Root matches, proofs verify, both RPCs agree, code identity canonical. Other findings may still show as warnings. |
| **Unexplained storage** (red) | Root mismatch after 5.11 step 1, and the extra slots are not identified as benign. |
| **Could not verify** (amber) | Proofs unsupported on the chain, RPCs disagree, version unsupported, or the RPCs lack what is needed. Say exactly which. |

Severity for individual findings:
- **Critical:** shadow owner or module; EOA module; non-canonical singleton.
- **High:** unknown module or fallback handler; non-standard setup delegatecall; a config slot with no matching event.
- **Medium:** unknown guard; 7702 or contract owners; pending approved hashes or queued transactions.
- **Info:** payments at setup; Safe version behind the latest.

## 7. UI

Verdict first, detail below. Read top to bottom:
1. **Input bar:** address, chain select (from safe-deployments, with search), optional block, and an RPC settings drawer with primary and cross-check, prefilled per chain.
2. **Verdict banner:** colour, one sentence, and the top three reasons.
3. **Summary cards:**
   - Version (canonical or not)
   - Owners: count and threshold, for example "2 of 3"
   - Modules: count, known or unknown
   - Guard
   - Module guard (1.5.0)
   - Fallback handler
   - Nonce
   - Storage: expected slot count with the formula, and expected root vs actual root (match or mismatch)
4. **Owners table:** address, type, flags.
5. **Modules table:** address, identified as, flags, details for Zodiac modules.
6. **Storage table:** every slot with key, meaning, value, source (config or event or trace), and status.
7. **Creation:** decoded setup.
8. **History and pending actions.**
9. **Diagnosis** (only on a mismatch).
10. **Verification:** block, both RPCs, proof status.
11. **"What this does not check"** box, in plain words.

Other requirements:
- Plain-language labels first, technical names in a tooltip or second line (for example "Hidden owner entry" over `owners[x]`).
- Works at 400 px width; tables scroll inside their own container.
- A dark theme, the same under either color-scheme preference; keyboard accessible; no layout shift while results
  stream in.
- Show progress: each step appears as it completes, with a marker that shows which step is running.
- Never block the UI on one slow RPC; time out and say which call failed.

## 8. Architecture and stack

- Stack:
  - TypeScript (strict), Vite, React, Tailwind.
  - viem (2.57.4 on npm, 2026-10-08) for RPC, ABI encoding and `getProof`.
  - `@ethereumjs/mpt` for the trie, or an own implementation tested against appendix B.
  - `@safe-global/safe-deployments` (1.37.63), `@safe-global/safe-modules-deployments` (3.0.10), `@gnosis-guild/zodiac` (5.0.1; the old name `@gnosis.pm/zodiac` stopped at 4.0.3).

  Pin exact versions with a lockfile. Confirm the packages ship the data you need without Node-only code; if not, vendor the JSON at build time with a script, and record the source commit.
- Split the code into:
  - `core/`: pure functions (slots, trie, decoding, rules), no I/O, fully unit-tested. It could later back a CLI.
  - `data/`: RPC client with the probe, the two-RPC cross-check, retries with backoff, and no JSON-RPC batching by default (some providers reject it).
  - `ui/`
- No global state library unless needed. No analytics, no third-party scripts at runtime.
- Keep a small CLI parity script (`scripts/check.ts` run with `tsx`) that prints the same report from `core/`. A reviewer can then diff it with `cast` output.

## 9. Endpoint notes (tested 2026-10-12)

| Endpoint | CORS from a Pages origin | Notes |
|---|---|---|
| `https://eth.drpc.org` | allowed | archive `eth_getProof`, `debug_traceTransaction` (prestateTracer), state overrides; `eth_getLogs` at most 100 blocks on the free plan |
| `https://eth-mainnet.public.blastapi.io` | allowed | archive `eth_getProof` and overrides; no `debug_*` (401); `eth_getLogs` 10 blocks |
| `https://ethereum-rpc.publicnode.com` | allowed | recent state and proofs only (a short window), no archive logs |
| `https://rpc.gnosischain.com` | allowed | `debug_*` accepted; `eth_getLogs` up to 50,000 blocks; `eth_getProof` only inside a short window |
| `https://api.safe.global/tx-service/<net>/api/v1/` | allowed (`*`) | creation, multisig transactions, messages, delegates; worked without a key |
| `https://eth.blockscout.com/api/v2/` | allowed (`*`) | logs, transactions, internal transactions; `counters` unreliable |

Default RPCs must be operated by the chain team or an established provider, and never a relay or MEV endpoint. Let users add their own.

## 10. Hosting: Cloudflare from GitHub, no backend

- Build output is a static SPA (`dist/`). There is no server code at all.
- Deploy with Cloudflare connected to the GitHub repo, with production on `main` and a preview URL per pull request. Cloudflare's docs list both Pages and Workers with static assets for front-end hosting, and its compatibility matrix says it plans to bridge the gaps between them. Pick one from the current Cloudflare docs at build time, record the choice as a decision, and keep the build host-agnostic.
  - [Workers vs. Pages compatibility matrix](https://developers.cloudflare.com/workers/static-assets/compatibility-matrix)
  - Third-party comparisons ([mecanik.dev](https://mecanik.dev/en/posts/cloudflare-pages-vs-workers-which-to-use-in-2026/), [morphllm.com](https://www.morphllm.com/comparisons/cloudflare-pages-vs-workers)) call Workers with static assets the recommended path for new projects. This was not confirmed on Cloudflare's own pages.
- Security headers via `_headers` (both hosts support it; check):
  - `Content-Security-Policy: default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src https:; frame-ancestors 'none'; base-uri 'none'; form-action 'none'`. `connect-src https:` is needed because users may add any RPC.
  - `Referrer-Policy: no-referrer`
  - `X-Content-Type-Options: nosniff`
  - `Permissions-Policy` denying everything
- Fonts and assets are bundled, not loaded from third parties.
- SPA fallback to `index.html`.
- GitHub Actions on each pull request: lint, typecheck, unit tests, build, and optionally fork tests with an RPC secret. Cloudflare builds and deploys; CI does not need Cloudflare secrets.
- Privacy note in the UI: the Safe address goes to the RPCs and APIs the user selects.

## 11. Testing

Prove every test bites: break the behaviour it covers, confirm it fails, restore.

1. **Unit, core (no network):**
   - every fixture root in appendix B, including the negative controls
   - slot key formulas
   - linked-list checks
   - setup decoding for each version
   - verdict rules
   - proof verification with a saved proof JSON (record one from a real `eth_getProof` and commit it)
2. **Live read-only regression (opt-in, needs an archive RPC):**
   - The Mainnet Reward Distribution Safe `0xAd219b3c26fe42BF5FC66F67490745a4fa5dff59` at block 26176126 must give root `0x4321ab74…693e` and "Storage fully explained".
   - The Mainnet SEF Safe (1.5.0) `0xB6b571A5Ea224152c57A230bf47c97574f6F2FaE` at block 26176126 must give `0xc05a109c…40af`.
3. **Fork tests with anvil** (`anvil --fork-url <archive rpc> --fork-block-number <n> --prune-history`):
   - Deploy real 1.3.0, 1.4.1 and 1.5.0 Safes through the canonical factories, then the cases below.
   - On a fork, `eth_getProof` after a local write can return a wrong storage root (seen in the Mainnet review). For fork tests, either run anvil without forking, with the Safe contracts deployed fresh (deterministic deployments), or compare against a root rebuilt by `core/` on an empty anvil. Document which.

   | Case | Setup | Expected |
   |---|---|---|
   | clean | standard `setup` | green |
   | shadow owner | `setup` `to` = helper that `sstore`s `owners[x] = 1` | red, slot classified as owner entry for `x` (Critical); prove `x` can sign |
   | shadow module | helper writes `modules[x] = 1` | red, Critical; prove `x` can call `execTransactionFromModule` |
   | silent guard | helper writes the guard slot | green root (slot is known) but High: no `ChangedGuard` event |
   | approved hash | an owner calls `approveHash` | green after pass 2, pending action listed |
   | signed message | SignMessageLib delegatecall | green after pass 2 |
   | EOA module | `enableModule(eoa)` | green root, Critical finding |
   | unknown fallback handler | custom handler | green root, High |
   | 7702 owner | owner with a 7702 delegation | Medium |
   | non-canonical singleton | proxy pointing at a copy | could not verify, red flag |
   | L2 setup on a non-1 chain id | SafeToL2Setup | green, ChangedMasterCopy explained |
4. **UI:** Playwright smoke test against a local anvil with the clean and shadow-owner Safes; check the verdict banner and the storage table.

## 12. Milestones and acceptance

| # | Milestone | Done when |
|---|---|---|
| M0 | Repo, CI, Cloudflare deploy from GitHub, headers | A hello page deploys on push to `main`; pull requests get previews; headers verified with `curl -I` |
| M1 | `core/` slots and trie | All appendix B roots reproduce, including negatives; tests bite |
| M2 | `data/` RPC layer | Probe, pinned reads, two-RPC cross-check, local proof verification; live regression passes on dRPC and Blast |
| M3 | Identity and config checks | 5.2, 5.3, 5.6 to 5.9 with safe-deployments, safe-modules and Zodiac data |
| M4 | UI | Verdict, cards and tables; mobile and the dark theme |
| M5 | History and diagnosis | 5.10 and 5.11, with degradation by RPC capability |
| M6 | Fork suite | Every case in section 11.3 passes on 1.3.0, 1.4.1 and 1.5.0 |
| M7 | Docs | README: what it checks and what it does not, the trust model, how to reproduce a result with `cast` (appendix C), and how to add an RPC or chain |
## Appendix A: constants

Storage slots (identical in 1.3.0, 1.4.1 and 1.5.0; verify against the version tags):

| Name | Value |
|---|---|
| singleton | slot `0` |
| modules mapping | slot `1` |
| owners mapping | slot `2` |
| ownerCount | slot `3` |
| threshold | slot `4` |
| nonce | slot `5` |
| deprecated domain separator | slot `6` (must be 0 from 1.3.0) |
| signedMessages mapping | slot `7` |
| approvedHashes mapping | slot `8` (nested: owner, then hash) |
| guard | `0x4a204f620c8c5ccdca3fd54d003badd85ba500436a431f0cbda4f558c93c34c8` = `keccak256("guard_manager.guard.address")` |
| fallback handler | `0x6c9a6c4a39284e37ed1cf53d337577d14212a4870fb976a4366c693b939918d5` = `keccak256("fallback_manager.handler.address")` |
| module guard (1.5.0) | `0xb104e0b93118902c651344349b610029d694cfdec91c589c91ebafbcd0289947` = `keccak256("module_manager.module_guard.address")` |
| sentinel | `0x0000000000000000000000000000000000000001` (owners and modules) |

Event topics (`cast sig-event`; indexing differs by version, the topic does not):

| Event | topic0 |
|---|---|
| `SafeSetup(address,address[],uint256,address,address)` | `0x141df868a6331af528e38c83b7aa03edc19be66e37ae67f9285bf4f8e3c6a1a8` |
| `AddedOwner(address)` | `0x9465fa0c962cc76958e6373a993326400c1c94f8be2fe3a952adfa7f60b2ea26` |
| `RemovedOwner(address)` | `0xf8d49fc529812e9a7c5c50e69c20f0dccc0db8fa95c98bc58cc9a4f1c1299eaf` |
| `ChangedThreshold(uint256)` | `0x610f7ff2b304ae8903c3de74c60c6ab1f7d6226b3f52c5161905bb5ad4039c93` |
| `EnabledModule(address)` | `0xecdf3a3effea5783a3c4c2140e677577666428d44ed9d474a0b3a4c9943f8440` |
| `DisabledModule(address)` | `0xaab4fa2b463f581b2b32cb3b7e3b704b9ce37cc209b5fb4d77e593ace4054276` |
| `ChangedGuard(address)` | `0x1151116914515bc0891ff9047a6cb32cf902546f83066499bcf8ba33d2353fa2` |
| `ChangedModuleGuard(address)` | `0xcd1966d6be16bc0c030cc741a06c6e0efaf8d00de2c8b6a9e11827e125de8bb8` |
| `ChangedFallbackHandler(address)` | `0x5ac6c46c93c8d0e53714ba3b53db3e7c046da994313d7ed0d192028bc7c228b0` |
| `ChangedMasterCopy(address)` | `0x75e41bc35ff1bf14d81d1d2f649c0084a0f974f9289c803ec9898eeec4c8d0b8` |
| `ApproveHash(bytes32,address)` | `0xf2a0eb156472d1440255b0d7c1e19cc07115d1051fe605b0dce69acfec884d9c` |
| `SignMsg(bytes32)` | `0xe7f4675038f4f6034dfcbbb24c4dc08e4ebf10eb9d257d3d02c0f38d122ac6e4` |
| `ExecutionSuccess(bytes32,uint256)` | `0x442e715f626346e8c54381002da614f62bee8d27386535b2521ec8540898556e` |
| `ExecutionFromModuleSuccess(address)` | `0x6895c13664aa4f67288b25d7a21d7aaa34916e355fb9b6fae0a139a9085becb8` |
| `ProxyCreation(address,address)` | `0x4f51faf6c4561ff95f067657e43439f0f856d97c04d9ec9070a6199ad418e235` |
| `ProxyCreationL2(address,address,bytes,uint256)` | `0x6e78ae8c51534f0b801d7aa7cce5a2113f3c3368c61b06fa61415f361d400431` |

A non-L2 Safe emits no `SafeMultiSigTransaction` or `SafeModuleTransaction`; do not rely on them.

## Appendix B: fixtures

Each block is `slot value` per line: every non-zero slot of that Safe. The root is the storage root built from exactly those lines. All roots were recomputed on 2026-10-12 with an empty anvil (`anvil_setStorageAt`, then `eth_getProof`). Live roots were also read from Mainnet where noted. The storage root does not depend on the account address.

**B1. Reward Distribution Safe, Ethereum, 1.4.1 non-L2, block 26176126.** One owner, two modules, nonce 3. Live `storageHash` matched on dRPC and Blast.
```text
0x0000000000000000000000000000000000000000000000000000000000000000 0x00000000000000000000000041675c099f32341bf84bfc5382af534df5c7461a
0x0000000000000000000000000000000000000000000000000000000000000003 0x0000000000000000000000000000000000000000000000000000000000000001
0x0000000000000000000000000000000000000000000000000000000000000004 0x0000000000000000000000000000000000000000000000000000000000000001
0x0000000000000000000000000000000000000000000000000000000000000005 0x0000000000000000000000000000000000000000000000000000000000000003
0x6c9a6c4a39284e37ed1cf53d337577d14212a4870fb976a4366c693b939918d5 0x000000000000000000000000fd0732dc9e303f09fcef3a7388ad10a83459ec99
0xe90b7bceb6e7df5418fb78d8ee546e97c83a08bbccc01a0644d599ccd2a7c2e0 0x000000000000000000000000802cbafa6133c493a7c67f685f97ada5918d1df9
0x987836d13f39f6cc07c34830a39d9f3a4645b530338199ebb6048d69d0146f2b 0x0000000000000000000000000000000000000000000000000000000000000001
0xcc69885fda6bcc1a4ace058b4a62bf5e179ea78fd58a1ccd71c22cc9b688792f 0x0000000000000000000000004210382652a5e3c9af7e1d3c88085818a465449b
0xe3ebe3cb924116f2e42323265a69b434816a67760d5bb395a26b66f97c0cded5 0x0000000000000000000000008dfc5db2c83200cf0cc84d7e3c441d7721ef83dc
0x3c87853bd1943cff64926293357392dc9e0942fc33fa81a241c22b70a47343e2 0x0000000000000000000000000000000000000000000000000000000000000001
```
- Root: `0x4321ab747900a628bc24642a1cff166280215c287be657997cff8468934b693e`.
- B1-neg: the same plus a shadow owner `owners[0x…02] = 1` (`0x679795a0195a1b76cdebb7c51d74e058aee92919b8c3389af86ef24535e8a28c 0x…01`). Root: `0x7fbd1922de71c80aabaac95fcf30df7cfdc3359e159b9c7ed6979920e18983f3`.

**B2. B1 after a planned owner swap to `0x…02`, executed by the owner (nonce 4).**
```text
0x0000000000000000000000000000000000000000000000000000000000000000 0x00000000000000000000000041675c099f32341bf84bfc5382af534df5c7461a
0x0000000000000000000000000000000000000000000000000000000000000003 0x0000000000000000000000000000000000000000000000000000000000000001
0x0000000000000000000000000000000000000000000000000000000000000004 0x0000000000000000000000000000000000000000000000000000000000000001
0x6c9a6c4a39284e37ed1cf53d337577d14212a4870fb976a4366c693b939918d5 0x000000000000000000000000fd0732dc9e303f09fcef3a7388ad10a83459ec99
0xcc69885fda6bcc1a4ace058b4a62bf5e179ea78fd58a1ccd71c22cc9b688792f 0x0000000000000000000000004210382652a5e3c9af7e1d3c88085818a465449b
0xe3ebe3cb924116f2e42323265a69b434816a67760d5bb395a26b66f97c0cded5 0x0000000000000000000000008dfc5db2c83200cf0cc84d7e3c441d7721ef83dc
0x3c87853bd1943cff64926293357392dc9e0942fc33fa81a241c22b70a47343e2 0x0000000000000000000000000000000000000000000000000000000000000001
0xe90b7bceb6e7df5418fb78d8ee546e97c83a08bbccc01a0644d599ccd2a7c2e0 0x0000000000000000000000000000000000000000000000000000000000000002
0x679795a0195a1b76cdebb7c51d74e058aee92919b8c3389af86ef24535e8a28c 0x0000000000000000000000000000000000000000000000000000000000000001
0x0000000000000000000000000000000000000000000000000000000000000005 0x0000000000000000000000000000000000000000000000000000000000000004
```
- Root: `0xe1c0eed6a34ba87d8617fb7f912a6e0e0e68c20bf9a855dca8db585d208a9b3b`.
- B2-module: the same, but executed through a module, so the nonce stays 3. Root: `0x0473cea344ad1220ec3a8e07974aab74d691782f034169b80ff048eb04aaa52d`.

**B3. SEF veto Safe, Ethereum, 1.5.0 non-L2, block 26176126.** Three owners, threshold 2, no modules, nonce 0. Live `storageHash` matched on dRPC.
```text
0x0000000000000000000000000000000000000000000000000000000000000000 0x000000000000000000000000ff51a5898e281db6dfc7855790607438df2ca44b
0x0000000000000000000000000000000000000000000000000000000000000003 0x0000000000000000000000000000000000000000000000000000000000000003
0x0000000000000000000000000000000000000000000000000000000000000004 0x0000000000000000000000000000000000000000000000000000000000000002
0x14ad0a1eb194f635ea0ccdc49bbc643d10c4fafd2e1f7689cd35d93088021272 0x0000000000000000000000000000000000000000000000000000000000000001
0x48fa797118bdd3e6ac0c9fdf6418f927818ec373f02f57d9c93b3df3ae64a9e4 0x000000000000000000000000b1df01604095536cea66a9d06e67ed6f00684e58
0x6c9a6c4a39284e37ed1cf53d337577d14212a4870fb976a4366c693b939918d5 0x0000000000000000000000003efcbb83a4a7afcb4f68d501e2c2203a38be77f4
0xcc69885fda6bcc1a4ace058b4a62bf5e179ea78fd58a1ccd71c22cc9b688792f 0x0000000000000000000000000000000000000000000000000000000000000001
0xcfd02caec7f360f1678640b7f09cef89ca1fb939756131ea13b8d62ee424f763 0x0000000000000000000000009f7dfab2222a473284205cddf08a677726d786a0
0xe90b7bceb6e7df5418fb78d8ee546e97c83a08bbccc01a0644d599ccd2a7c2e0 0x000000000000000000000000a3840d235de294e55c5ba4a3c57942617c7e3c05
```
- Root: `0xc05a109ce56dcc8bb79cc1d6e9185c384c13b4124f6febf195d9391b167340af`. This shows the empty module list still has `modules[0x1] = 0x1` (`0xcc69…792f`).
- B3-neg: the same plus `owners[0x802cbafa6133c493a7c67f685f97ada5918d1df9] = 1` (`0x987836d13f39f6cc07c34830a39d9f3a4645b530338199ebb6048d69d0146f2b 0x…01`). Root: `0x94956a766ea53dfc8a0b8449a4f8b4b44e595d91d7c22540f649dcca37ecc486`.

**B4. SafeDAO Safe, Gnosis Chain, 1.4.1 L2, block 48552248.** One owner, two modules, nonce 2. The live root matched on 2026-10-02. That block is now outside the Gnosis official RPC's proof window, so use it as an offline fixture.
```text
0x0000000000000000000000000000000000000000000000000000000000000000 0x00000000000000000000000029fcb43b46531bca003ddc8fcb67ffe91900c762
0x0000000000000000000000000000000000000000000000000000000000000003 0x0000000000000000000000000000000000000000000000000000000000000001
0x0000000000000000000000000000000000000000000000000000000000000004 0x0000000000000000000000000000000000000000000000000000000000000001
0x0000000000000000000000000000000000000000000000000000000000000005 0x0000000000000000000000000000000000000000000000000000000000000002
0xe90b7bceb6e7df5418fb78d8ee546e97c83a08bbccc01a0644d599ccd2a7c2e0 0x00000000000000000000000087ed33e7c95d393c3c01e67060de43aa857fdb80
0x2a3eeb0974ddff69962821c0466fa02526ef4413a7e5746c360d2207f7a9aaea 0x0000000000000000000000000000000000000000000000000000000000000001
0xcc69885fda6bcc1a4ace058b4a62bf5e179ea78fd58a1ccd71c22cc9b688792f 0x000000000000000000000000e62320c8f29cea47587b2239476841430e17af75
0xf18654d21fb052425144f1724253585dfea7773f9daad4f19b7766d4b9d42f17 0x000000000000000000000000b3b5209a0d4fefb169d9a2795d73f199372c29ff
0x13acf23e6e7568d4e951d5850765cea89d916c5422a72210b63d53759dafce49 0x0000000000000000000000000000000000000000000000000000000000000001
0x6c9a6c4a39284e37ed1cf53d337577d14212a4870fb976a4366c693b939918d5 0x000000000000000000000000fd0732dc9e303f09fcef3a7388ad10a83459ec99
```
- Root: `0xb350a7edeade83c2ecfc6ef94623a399433c37a1cafcc59dbd80672338539998`.
- B4-neg: plus `owners[0x…02] = 1` (`0x679795a0195a1b76cdebb7c51d74e058aee92919b8c3389af86ef24535e8a28c 0x…01`). Root: `0xd219d7443dcfc6ae85050ef1c3b82ad967b0efcb47430e6f4bab63c1342b82c3`.

## Appendix C: reproduce a result with cast

The README should teach reviewers to reproduce the tool's core result without it:
```bash
RPC=https://eth.drpc.org; B=26176126; SAFE=0xAd219b3c26fe42BF5FC66F67490745a4fa5dff59
cast proof $SAFE --block $B --rpc-url $RPC | jq -r .storageHash        # real root
cast index address 0x802cbafa6133c493A7c67f685f97AdA5918d1dF9 2         # owners[addr] key
cast storage $SAFE <key> --block $B --rpc-url $RPC                      # read one slot
# rebuild the root from a slot list on an empty anvil (the method behind appendix B):
anvil --port 18611 --silent & 
while read slot val; do cast rpc anvil_setStorageAt $SAFE $slot $val --rpc-url http://127.0.0.1:18611 >/dev/null; done < slots.txt
cast proof $SAFE --rpc-url http://127.0.0.1:18611 | jq -r .storageHash  # rebuilt root
```
