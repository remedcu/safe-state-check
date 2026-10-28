# Safe State Check

Safe State Check looks for hidden owners, hidden modules and any other storage a Safe's visible configuration does not
explain. It runs in your browser against public RPCs or your own. There is no backend and no wallet connection.

Every contract has a storage root: one hash that commits to all of its non-zero storage slots. The tool reads the
Safe's owners, modules, threshold, nonce, guard, module guard, fallback handler and singleton, rebuilds the root from
exactly the slots those settings explain, and compares it with the real root from `eth_getProof`. If they match, the
Safe holds no other storage, in any slot. If they differ, something else is there, and the tool tries to find out what.

The design is in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## What it checks

- **Storage root.** The rebuilt root against the proven root. A second pass adds the approved hashes and signed
  messages found in the event history. If the root still does not match, a diagnosis step looks for the extra slots:
  it asks the RPC to list the Safe's slots, or traces the Safe's transactions. It names the extra slots where it can
  (for example a hidden owner entry).
- **Code identity.** The proxy and the singleton must be known Safe releases. The check supports Safe 1.3.0, 1.4.1 and
  1.5.0, L1 and L2. Older versions are shown as unsupported.
- **Owners.** Each owner is classified as a plain account, an EIP-7702 delegated account, a Safe (one level deep: its
  owners and threshold) or another contract.
- **Modules, guard, module guard and fallback handler.** Identified by their proven code hash, looked up in
  `@safe-global/safe-deployments`, `@safe-global/safe-modules-deployments`, Zodiac and a short reviewed list. A module
  that is a plain account is Critical. Unknown modules and fallback handlers are High.
- **Creation.** The factory, the `setup` call and any setup delegatecall.
- **Event history.** Every module, guard, handler and owner present now should have an event that set it. A missing
  event is High, or Medium when the history came from an indexer, which can drop events.
- **Pending actions.** Pre-approved hashes and signed messages, plus the queued transactions, offchain messages and
  delegates from the Safe Transaction Service. An approval or a signed message in storage without the event that
  announces it is Critical: it acts as a signature nobody gave.
- **Other chains, on a click.** "Check other chains" looks for code at the same address on every chain with a default
  RPC and, where it finds a Safe, compares its owners and threshold.

## What it does not check

The app shows this list under every result:

- What the code does. The Safe's logic, modules, guard and fallback handler are named by their code hash, not audited.
- Owner keys. How owners keep their keys, and whether one is compromised.
- Signatures kept offchain. Signatures that were never shared with the Safe Transaction Service or any other service
  cannot be seen.
- Storage of other contracts. A module's or guard's own settings sit in its own storage, outside this Safe's storage
  root.
- Owners of owners. An owner that is a Safe is shown one level deep; its own setup is not checked.
- Token balances and approvals.

A run can add lines to it, for example when the fallback handler keeps per-Safe settings in its own storage, or when
you trusted your own RPC without a cross-check.

## Reading the result

| Banner                          | Meaning                                                                                                                                                   |
| ------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Storage fully explained (green) | Every slot in the proven storage is explained: by the configuration, or as an approved hash or signed message that its event announces.                   |
| Unexplained storage (red)       | The proven root does not match, or a slot holds something that is not benign. Red only on verified data.                                                  |
| Could not verify (amber)        | Something the result rests on could not be read, proven or confirmed. The banner lists why. Amber says this run cannot tell, not that the Safe is unsafe. |

Green and red are about storage. The banner also shows the number of findings by severity (Critical, High, Medium,
Info). A green banner can sit above a Critical finding: a module that is a plain account has all its slots explained,
and it still controls the Safe. Read the counts.

The banner shows the block and its time. If the block came from the link or the settings, or is more than one hour
old, the banner says that this is the state at that block, not the current state, and offers to check the latest block.
If you stop a run, the banner says "Stopped: partial result" and keeps what was proven so far. That is not a verdict.

## How far to trust a green result

**One block, two operators.** The check pins one block, by default 3 blocks below the newest. Two RPCs run by
different operators must return the same block hash and state root for it. That header is the anchor.

**Every state read is proven.** The storage root, every slot value and the code hash of every account the verdict
uses come from `eth_getProof`. Your browser verifies each proof against the anchor's state root. A proven value is as
good as the anchor, whichever RPC served it.

**Other reads are sourced.** `eth_call` results (`VERSION()`, Zodiac module settings), logs, transactions and API
answers cannot be proven. The report names where each came from. Where the cross-check RPC serves the same read, the
answers are compared.

**What a lying RPC can do.** It cannot turn the banner red: red needs a verified anchor and verified proofs, and a
mismatch on unverified data shows as amber. It cannot hide a slot on its own either: the proven root would have to
match a state root that another operator confirmed. It can make the result amber: a proof that does not verify, a
disagreement between the two RPCs, or a failed read all give "Could not verify", with the reason.

**Amber reasons.** Any of these makes the result amber:

- the chain's proofs are not standard Ethereum proofs (ZK Stack, Polygon zkEVM, chains with extra account fields such
  as Avalanche)
- no RPC served proofs for the block
- only one operator confirmed the block
- the RPCs disagreed
- a proof did not verify
- the Safe version is not supported
- the proxy or singleton is not a known release
- the chain reorganised twice during the check
- a read the verdict needs failed
- an owner, module, guard or handler could not be inspected
- state was read without a proof on a chain whose proofs work
- a slot looks like an approval or signed message, but the history was not read far enough to find its event

Adding an RPC that serves `eth_getProof` for recent blocks fixes most of them.

**Limits.**

- Operator independence is assumed, not proven. The tool never pairs two aggregators (dRPC and 1RPC forward to nodes
  they do not name), but an aggregator may still reach a node of the operator it is paired with. The verification
  section names both operators.
- Your own node. If you mark your primary RPC as your own node and no other operator can confirm the block, the check
  accepts your RPC alone. The banner then says "Verified against your own RPC only (no independent cross-check)". When
  both RPCs are ones you entered, the banner says so.
- Code is named, not audited. "Known" means the proven code hash is in the Safe packages or the reviewed list.
- The result is for one block. Anything that happens after it is not covered.

## Input

The input field takes:

- a bare address: `0xAd219b3c26fe42BF5FC66F67490745a4fa5dff59`
- an EIP-3770 address: `eth:0xAd21...` (Safe{Wallet}'s own prefixes work too, for example `matic:` for Polygon)
- a Safe{Wallet} URL with `safe=`: `https://app.safe.global/home?safe=eth:0xAd21...`
- a permalink, alone or as a full URL: `/#/1/0xAd21...` or `/#/1/0xAd21...@26176126`

A mixed-case address must match its EIP-55 checksum. All lower case or all upper case is accepted. After a run the page
writes the permalink into the URL, with the block only if you gave one. The address stays after the `#`, so the site's
host never sees it.

**Chain detection.** With no chain in the input and none picked, the page asks the Safe{Wallet} chains that have a
default RPC (49 in the current list, most used first, six at a time) whether the address is a Safe there. It sends
`eth_getCode`, and one storage read when there is code, to the first default RPC of each chain (the second if the
first fails). One match starts the run. With several, you pick one. With none, the page offers "Search all chains",
which asks every chain with a default RPC (249). These reads are not proven: they only pick the chain, and the run
proves everything again.

Detection sends the address to every chain it asks, through the default RPCs, whatever your RPC settings. To skip it,
use `eth:0x...`, pick the chain, or use a permalink.

## Privacy

The tool has no server. The Safe address goes to these parties, and only these:

| Party                                        | Gets                                                               | When                                                                     |
| -------------------------------------------- | ------------------------------------------------------------------ | ------------------------------------------------------------------------ |
| Your RPCs                                    | the Safe address and related addresses                             | when you set them for the chain                                          |
| The chain's default RPCs                     | the Safe address and related addresses                             | unless you turn off "Also use the default RPCs" for that chain           |
| Default RPCs of other chains                 | the Safe address                                                   | chain detection; "Search all chains" and "Check other chains" on a click |
| Safe Transaction Service (`api.safe.global`) | the Safe address                                                   | on by default, without a key; there is a switch to turn it off           |
| Blockscout                                   | the Safe address                                                   | on by default ("Use public indexers"), on chains that have an instance   |
| Sourcify                                     | addresses of owners, modules and handlers whose code no list knows | on by default ("Use public indexers")                                    |
| Etherscan                                    | the Safe address                                                   | only when you enter an API key                                           |
| This site's host                             | nothing                                                            | never                                                                    |

The privacy line under the input lists the parties for your current settings. Your RPC URLs and API keys are saved in
this browser's `localStorage` under `safe-state-check:settings:v1` and sent only to the service they belong to. API
keys never go into the link, the JSON report or the Markdown summary. For your own RPCs the report keeps only the host:
the path and query, where keys usually sit, are removed.

## Reproduce a result with cast

You can check the core claim without the tool. This needs [Foundry](https://getfoundry.sh) (`cast`, `anvil`) and `jq`.
The example is the Safe `0xAd219b3c26fe42BF5FC66F67490745a4fa5dff59` on Ethereum at block 26176126.

First, confirm the block's state root with two operators, and read the real storage root from two RPCs:

```bash
B=26176126
SAFE=0xAd219b3c26fe42BF5FC66F67490745a4fa5dff59
cast block $B --field stateRoot --rpc-url https://eth.drpc.org
cast block $B --field stateRoot --rpc-url https://ethereum-rpc.publicnode.com
cast proof $SAFE --block $B --rpc-url https://eth.drpc.org | jq -r .storageHash
cast proof $SAFE --block $B --rpc-url https://eth-mainnet.public.blastapi.io | jq -r .storageHash
```

Both state roots are `0x076e2e1a0629ea82b1069570b7426e70d1d2e9011c1674b882b4c02c10c40fe7`, and both storage roots are
`0x4321ab747900a628bc24642a1cff166280215c287be657997cff8468934b693e`. `cast proof` does not verify the proof; the tool
does that against the state root.

Then rebuild the root from the slots the configuration explains. The keys follow the Safe storage layout: slots 0 and
3 to 6, the guard, fallback handler and module guard slots, then `owners[a]` (mapping slot 2) and `modules[a]` (mapping
slot 1) for the sentinel `0x...01` and every list entry.

```bash
RPC=https://eth.drpc.org
B=26176126
SAFE=0xAd219b3c26fe42BF5FC66F67490745a4fa5dff59
ONE=0x0000000000000000000000000000000000000001
slot() { echo "$1 $(cast storage $SAFE $1 --block $B --rpc-url $RPC)"; }
owners=$(cast call $SAFE "getOwners()(address[])" --block $B --rpc-url $RPC | tr -d '[],')
modules=$(cast call $SAFE "getModulesPaginated(address,uint256)(address[],address)" $ONE 100 \
  --block $B --rpc-url $RPC | head -1 | tr -d '[],')
{
  for n in 0 3 4 5 6; do slot $(cast to-uint256 $n); done
  slot $(cast keccak guard_manager.guard.address)
  slot $(cast keccak fallback_manager.handler.address)
  slot $(cast keccak module_manager.module_guard.address)
  for a in $ONE $owners; do slot $(cast index address $a 2); done
  for a in $ONE $modules; do slot $(cast index address $a 1); done
} > slots.txt

anvil --port 18611 --silent &
until cast chain-id --rpc-url http://127.0.0.1:18611 >/dev/null 2>&1; do sleep 0.2; done
grep -v ' 0x0*$' slots.txt | while read -r key value; do
  cast rpc anvil_setStorageAt $SAFE $key $value --rpc-url http://127.0.0.1:18611 >/dev/null
done
cast proof $SAFE --rpc-url http://127.0.0.1:18611 | jq -r .storageHash
kill $!
```

The last command prints `0x4321ab747900a628bc24642a1cff166280215c287be657997cff8468934b693e` again: the Safe holds
nothing beyond its configuration. The `grep` drops zero values. A zero slot does not exist in a real storage trie, but
anvil keeps a slot set to zero, and the root then differs.

This script takes the owner and module lists from the getters; the tool walks the lists in raw storage instead.
Either way, an entry outside the lists (a hidden owner) is not in `slots.txt`, so the roots differ. To see the root
change, add a line for `owners[0x...02] = 1` to `slots.txt` and run the anvil part again:

```text
0x679795a0195a1b76cdebb7c51d74e058aee92919b8c3389af86ef24535e8a28c 0x0000000000000000000000000000000000000000000000000000000000000001
```

The rebuilt root becomes `0x7fbd1922de71c80aabaac95fcf30df7cfdc3359e159b9c7ed6979920e18983f3`.

To check the tool's own slot list instead, take it from its JSON report (`--json` in the CLI, or the download in the
app) and run the anvil part on it:

```bash
jq -r '.storage.data.slots[] | "\(.key) \(.value)"' report.json > slots.txt
```

## Develop

You need Node 24 (`.nvmrc`) and npm 11.

```bash
npm ci
npm run dev        # the app at http://localhost:5173
npm run check      # eslint, prettier --check, tsc
npm test           # unit tests (vitest)
npm run build      # type check and production build into dist/
```

The look follows the Safe Design System's dark theme: the color tokens are in `src/index.css`, and DM Sans and Geist
Mono (SIL Open Font License) are served from `src/assets/fonts/`. The mark, favicons, app icons and social preview
are in `brand/`: the SVGs are the sources, and `npm run brand:export` renders the PNG and ICO files from them and
copies the served ones into `public/`.

More tests:

- `npm run test:anvil` creates Safes 1.3.0, 1.4.1 and 1.5.0 on a fresh local anvil, one per case (clean, hidden owner,
  hidden module, silent guard, approved hash, signed message, plain-account module, unknown fallback handler, 7702
  owner, non-canonical singleton, L2 setup, and more), and checks each through the real pipeline. It needs Foundry
  (`anvil` and `forge`).
- `npm run test:e2e` runs the Playwright smoke test on the built fixture page at 400 px, under both color-scheme
  preferences (the site is dark in both) and the CSP from `public/_headers`. Install the browser once with `npx playwright install chromium` (on Linux,
  `npx playwright install --with-deps chromium` also installs the system libraries it needs).
- `ANVIL_E2E=1 npx playwright test e2e/anvil.spec.ts --project light` runs the real app against the anvil suite's
  clean and hidden-owner Safes.
- `LIVE=1 npx vitest run live` runs the live regression against public Ethereum and Gnosis RPCs (read-only).

CI runs `npm run check`, the offline registry check, `npm test`, `npm run build` and the Playwright smoke test on
every pull request.

## Command line

The CLI runs the same pipeline as the web app for one Safe. It prints the Markdown summary to stdout and progress to
stderr. Without a chain in the input or `--chain`, it asks the most used chains, like the web app, and runs on the one
where the address is a Safe. If it finds several or none, it says so and exits with 64. The Transaction Service and
the public indexers (Blockscout, Sourcify) are on, as in the web app's defaults. `--no-sts` turns the service off.

```bash
npm run cli -- 'eth:0xAd219b3c26fe42BF5FC66F67490745a4fa5dff59'
npm run cli -- 0xAd219b3c26fe42BF5FC66F67490745a4fa5dff59 --chain 1 --block 26176126 --json report.json
```

| Option                  | Meaning                                                                                 |
| ----------------------- | --------------------------------------------------------------------------------------- |
| `--chain <id>`          | Chain id, when the input does not name one. A different chain in the input is an error. |
| `--block <n>`           | Block to check. Default: 3 blocks below the newest.                                     |
| `--rpc <url>`           | Your primary RPC.                                                                       |
| `--cross-rpc <url>`     | Your cross-check RPC, run by another operator.                                          |
| `--no-defaults`         | Use only your RPCs, never the default ones. Needs `--rpc`.                              |
| `--own-node`            | Trust `--rpc` alone when nothing else can cross-check it. Needs `--rpc`.                |
| `--sts-key <key>`       | Safe Transaction Service API key.                                                       |
| `--no-sts`              | Do not call the Safe Transaction Service.                                               |
| `--etherscan-key <key>` | Etherscan API key. Etherscan is called only with a key.                                 |
| `--history-budget <s>`  | Seconds the event history may take. Default: 90.                                        |
| `--json <file>`         | Also write the full JSON report.                                                        |
| `--verbose`             | Print every issue as it happens and every request at the end.                           |
| `--help`                | Show the options.                                                                       |

Exit codes:

| Code | Meaning                                                   |
| ---- | --------------------------------------------------------- |
| 0    | Storage fully explained, and no Critical or High finding  |
| 1    | Unexplained storage, or a Critical or High finding        |
| 2    | Could not verify                                          |
| 3    | The check stopped (for example, no Safe at the address)   |
| 64   | Wrong arguments, or no single chain found for the address |

## Data

All generated files are committed. The build fetches no chain or contract data, and every change to the data is
reviewed as a diff.

### Default RPCs

`src/data/generated/chains.json` holds every chain in `@safe-global/safe-deployments` with its default RPCs, its
Blockscout and Safe Transaction Service URLs, and whether its root check works. `data/rpcs/refresh-meta.json` records
the sources (with sha256), the filter policy, the filter counts and the coverage.

```bash
npm run rpcs:refresh -- --out-dir ~/rpc-refresh
```

The script reads chainlist.org's `rpcs.json`, `chainid.network`, the Blockscout chain list, the Safe Config Service and
the installed safe-deployments. Every RPC must pass the trust filter in `scripts/lib/rpc-policy.ts`:

- https only, with no key or key template in the URL;
- not flagged by chainlist as tracking (a "limited" label is accepted only from an allowlisted provider);
- not a relay, MEV or private-order-flow endpoint;
- run by an allowlisted provider (PublicNode, ethPandaOps, dRPC, 1RPC, Blast) or by the chain's own team, judged by
  the registrable domain of the chain's chainlist `infoURL`.

Then it probes each RPC the way the app uses it, with a browser origin: chain id, CORS, the header at `latest - 3`,
and `eth_getProof` there, verified with the app's own proof code. RPCs whose proofs verify can be the primary. RPCs
that serve the header but not the proof stay as cross-check candidates. The probe dump, rejections and source snapshots
go to `--out-dir`, not the repo. A refresh takes about ten minutes. Refresh by hand, monthly and before a release, and
review the `chains.json` diff (RPCs added, removed or re-ranked) and the coverage counts.

**Add an RPC.** Users add their own per chain in the settings: a primary, a cross-check, and whether to keep the
defaults. To add a default, the RPC must be listed on chainlist and pass the filter. For a provider that is not
allowlisted, add it to `PROVIDERS` in `scripts/lib/rpc-policy.ts` with its host suffix and whether it forwards to
nodes it does not name (`aggregator`). For a chain team that serves RPCs on a domain other than its `infoURL`, add the
domain to `TEAM_DOMAIN_ALIASES` with the source. Then run the refresh.

**Add a chain.** The chain list comes from `@safe-global/safe-deployments`. Update the package, then run
`npm run rpcs:refresh` and `npm run registry:build` and commit the results. Unit tests fail until both generated files
match the installed package versions. Every chain in the package is selectable, even one without a default RPC: the
user then adds their own.

### Known contracts

`src/data/generated/known-contracts.json` lists every contract the checks can name, with its code hash, kind and source.
`scripts/build-registry.ts` builds it from `@safe-global/safe-deployments`, `@safe-global/safe-modules-deployments`,
`@gnosis-guild/zodiac` and the reviewed list.

```bash
npm run registry:build                        # network only for code hashes missing from the cache
npm run registry:build -- --offline --check   # CI: rebuild from packages and cache, fail on any difference
```

safe-deployments ships code hashes. The other two packages do not, so the script reads the code once on Ethereum,
Gnosis or Sepolia and caches the hash with its chain and block in `data/registry/codehashes.json`. SafeProxy runtimes
come from each factory's `proxyCreationCode()`. The output is sorted and has no timestamps.

### The reviewed list

`src/data/reviewed-contracts.json` holds contracts that no package knows and a maintainer reviewed. An entry matches
only on chain, address and code hash together: contracts with immutables have a different code hash per deployment.
The app labels a match "reviewed list" and never calls it an official deployment.

To add one, open a pull request with the entry: name, kind, chain, address, code hash, a source link (for example a
Sourcify exact match) and a note on what was checked, with `reviewedBy` and `reviewedOn` left empty. A maintainer
reviews the source and the deployment, then fills `reviewedBy` and `reviewedOn` (YYYY-MM-DD). Until both are set, the
app ignores the entry and the contract shows as unknown. `npm run registry:build` checks the shape, and, when online,
that the code hash matches the code on that chain.

## Deploy

The site is a static build served by Cloudflare Workers with static assets. There is no Worker script: `wrangler.jsonc`
points `assets.directory` at `./dist` and serves `index.html` for unknown paths.

Connect the GitHub repository in the Cloudflare dashboard (Workers & Pages, Create, Import a repository). Then in
Settings, Build:

- Build command: `npm run build`
- Deploy command: `npx wrangler deploy`
- Preview command: `npx wrangler preview` (the default)
- Branch control: production branch `main`, "Enable Preview Builds" on, so every other branch gets a preview URL.

Workers Builds uses the Wrangler version from `package.json` and the Node version from `.nvmrc`. To check the
configuration locally without an account, run `npx wrangler deploy --dry-run` after a build.

`public/_headers` sets these security headers for every path:

- a Content Security Policy that loads scripts and styles only from the site, allows connections to any https origin
  (users add their own RPCs) and to `localhost` and `127.0.0.1` (a local node), and forbids framing
- `Referrer-Policy: no-referrer`
- `X-Content-Type-Options: nosniff`
- a `Permissions-Policy` that denies everything except `clipboard-write` for "Copy Markdown"

Production runs on `https://proofoftech.com`. `wrangler.jsonc` declares it as a route with `"custom_domain": true`, so
the first deploy creates the DNS record and certificate (the zone must be on Cloudflare in the same account, with no
existing A, AAAA or CNAME record at the apex). `"workers_dev": false` keeps the custom domain as the only production
URL; pull request previews still get `workers.dev` Preview URLs. A custom domain matches its exact hostname only, so
`www.proofoftech.com` needs a redirect rule to the apex if it should work.
