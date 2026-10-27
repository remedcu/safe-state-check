// A small hand-written registry for unit tests, with real addresses and code hashes taken from the deployment packages
// and, for the fixture Safe's accounts, from eth_getCode at Ethereum block 26176126. The generated src/data/generated/known-contracts.json replaces it in live
// tests.
import type { Address, Hex } from "viem"
import { buildRegistry } from "@/core/registry"
import type { ContractKind, KnownContract, KnownFlag, ReviewedContract } from "@/data/types"

type Spec = {
  kind: ContractKind
  address: Address | null
  codeHash: Hex
  roles?: ContractKind[]
  flags?: KnownFlag[]
  chains?: number[] | "any-evm"
}

function contract(id: string, spec: Spec): KnownContract {
  const [name, rest] = id.split("@")
  const version = rest.split("/")[0]
  const origin = id.startsWith("zodiac/")
    ? "zodiac"
    : spec.kind === "module" || id.startsWith("SafeModuleSetup") || id.startsWith("SafeWebAuthn")
      ? "safe-modules-deployments"
      : "safe-deployments"
  return {
    id,
    name: name.replace(/^zodiac\//, ""),
    version,
    kind: spec.kind,
    roles: spec.roles ?? [],
    address: spec.address,
    codeHash: spec.codeHash,
    codeHashSource: "package",
    chains: spec.chains ?? [1, 100],
    flags: spec.flags ?? [],
    writes: null,
    source: {
      origin,
      package: null,
      version: null,
      path: null,
      deploymentType: id.endsWith("/canonical") ? "canonical" : null,
      url: null,
      reviewedOn: null,
    },
  }
}

export const HASH = {
  proxy111: "0xaea7d4252f6245f301e540cfbee27d3a88de543af8e49c5c62405d5499fab7e5",
  proxy130: "0xb89c1b3bdf2cf8827818646bce9a8f6e372885f8c55e5c07acbd307cb133b000",
  proxy141: "0xd7d408ebcd99b2b70be43e20253d6d92a8ea8fab29bd3be7f55b10032331fb4c",
  proxy150: "0x4e381985ca68b3e5d27b4425fa581c19cf33146d3f887a3cfca96f55528ea46f",
  safe111: "0x56b8be58b5ad629a621593a2e5e5e8e9a28408dc06e95597497b303902772e45",
  safe130: "0xbba688fbdb21ad2bb58bc320638b43d94e7d100f6f3ebaab0a4e4de6304b1c2e",
  safeL2130: "0x21842597390c4c6e3c1239e434a682b054bd9548eee5e9b1d6a4482731023c0f",
  safe141: "0x1fe2df852ba3299d6534ef416eefa406e56ced995bca886ab7a553e6d0c5e1c4",
  safeL2141: "0xb1f926978a0f44a2c0ec8fe822418ae969bd8c3f18d61e5103100339894f81ff",
  safe150: "0xdda019cbd7c867a533a2a86e5c53434fdc50b13122b5a5ddb4a8df61b31c20f2",
  safeL2150: "0x180193227186ccb85316c94db1f0d156ed932b14712cfaac78901899178572dc",
  compat141: "0x7c6007a5d711cea8dfd5d91f5940ec29c7f200fe511eb1fc1397b367af3c42f9",
  compat150: "0x3c6a85bcf7b563daa624b884b4e9a1b9fa5371edde7be945d998071a48f28bbc",
  extensible150: "0xba5bafdfba82e226b6dc8ae29bedf5026bd854ab4bee00128ca322717a5f2acf",
  factory130: "0x337d7f54be11b6ed55fef7b667ea5488db53db8320a05d1146aa4bd169a39a9b",
  factory141: "0x50c3cdc4074750a7a974204a716c999edd37482f907608d960b2b025ee0b3317",
  factory150: "0x967dae4cda22b0c9ef7f31b010bdc1ceb0af9904b0c3dc060b5302e4c18a4529",
  multiSend141: "0x0e4f7fc66550a322d1e7688e181b75e217e662a4f3f4d6a29b22bc61217c4b77",
  multiSendCallOnly141: "0xecd5bd14a08c5d2122379900b2f272bdf107a7e92423c10dd5fe3254386c9939",
  toL2Setup141: "0x2f25df28caf984366ee584e13241707e85dcd5a6ea0c14267928dafc1fd6274b",
  toL2Setup150: "0xf6034d841bcbff8912aa55526b0f1609212536aaf60bb16f5e8a269a4ab38f18",
  moduleSetup030: "0xaf2d170bb766d2773c3fa88717f5b3599827478074d3767d1dee55e5c2f3fbcb",
  safe4337030: "0x2aea997c4e3cf0e2f333025372e219abcfde81c21fc2f8fb066414a5685dd3e0",
  sharedSigner: "0xeaa32d0280053e2feea48a7c3fa15a535cd07c23ff60c9469cfa1999533e9332",
  signMessageLib141: "0x525c754a46b79e05543a59bb61e8de3c9eee0d955a59352409cbe67ea1077528",
  realityETH: "0xe5883a69c42f4a864e1f7202b5a5e09ddb43e9996c94b192f75a2f6823fcd4be",
  realityERC20: "0xbd65d06b1aca18cf7736f4cd6d73cd9bc8d9ba12cd8e11120ec7b35c18f6ae3f",
  delay110: "0xacfe2969dd5516ec08ca2347669ac722df65a7826aa4faa6aed07e97be02c0fd",
  delay111: "0xdd928eddfff7b68bd8fff28178c29e3388c1d098051d9262f151c4b534c577b8",
  scopeGuard: "0x7f0bc060b24a8f97f89c9abef9b8f40f8018e777aae271bed7fe21b759373a55",
  // eth_getCode at block 26176126: the RealityVetoModule of the B1 Safe (immutables, so one hash per deployment).
  vetoModule: "0xc1ea22a6e60824589438b7e058bc8e6129ef5cd2105282d29249f3e3a77bd789",
} as const satisfies Record<string, Hex>

export const ADDRESS = {
  safe111: "0x34CfAC646f301356fAa8B21e94227e3583Fe3F5F",
  safe130: "0xd9Db270c1B5E3Bd161E8c8503c55cEABeE709552",
  safeL2130: "0x3E5c63644E683549055b9Be8653de26E0B4CD36E",
  safe141: "0x41675C099F32341bf84BFc5382aF534df5C7461a",
  safeL2141: "0x29fcB43b46531BcA003ddC8FCB67FFE91900C762",
  safe150: "0xFf51A5898e281Db6DfC7855790607438dF2ca44b",
  safeL2150: "0xEdd160fEBBD92E350D4D398fb636302fccd67C7e",
  compat141: "0xfd0732Dc9E303f09fCEf3a7388Ad10A83459Ec99",
  compat150: "0x3EfCBb83A4A7AfcB4F68D501E2c2203a38be77f4",
  extensible150: "0x85a8ca358D388530ad0fB95D0cb89Dd44Fc242c3",
  factory130: "0xa6B71E26C5e0845f74c812102Ca7114b6a896AB2",
  factory141: "0x4e1DCf7AD4e460CfD30791CCC4F9c8a4f820ec67",
  factory150: "0x14F2982D601c9458F93bd70B218933A6f8165e7b",
  multiSend141: "0x38869bf66a61cF6bDB996A6aE40D5853Fd43B526",
  multiSendCallOnly141: "0x9641d764fc13c8B624c04430C7356C1C7C8102e2",
  toL2Setup141: "0xBD89A1CE4DDe368FFAB0eC35506eEcE0b1fFdc54",
  toL2Setup150: "0x900C7589200010D6C6eCaaE5B06EBe653bc2D82a",
  moduleSetup030: "0x2dd68b007B46fBe91B9A7c3EDa5A7a1063cB5b47",
  safe4337030: "0x75cf11467937ce3F2f357CE24ffc3DBF8fD5c226",
  sharedSigner: "0x94a4F6affBd8975951142c3999aEAB7ecee555c2",
  signMessageLib141: "0xd53cd0aB83D845Ac265BE939c57F53AD838012c9",
  realityETH: "0x4e35DA39Fa5893a70A40Ce964F993d891E607cC0",
  realityERC20: "0x7276813b21623d89BA8984B225d5792943DD7dbF",
  delay110: "0x01F8cabB808D7dE0dF4202D4B60C8310d2f1339b",
  delay111: "0x824175b945838d127C1ca83CbcE11D8e44F6dF01",
  scopeGuard: "0xeF27fcd3965a866b22Fb2d7C689De9AB7e611f1F",
  vetoModule: "0x4210382652A5e3C9aF7e1D3c88085818A465449b",
} as const satisfies Record<string, Address>

export const KNOWN_CONTRACTS: KnownContract[] = [
  contract("SafeProxy@1.1.1", { kind: "proxy", address: null, codeHash: HASH.proxy111, chains: "any-evm" }),
  contract("SafeProxy@1.3.0", { kind: "proxy", address: null, codeHash: HASH.proxy130, chains: "any-evm" }),
  contract("SafeProxy@1.4.1", { kind: "proxy", address: null, codeHash: HASH.proxy141, chains: "any-evm" }),
  contract("SafeProxy@1.5.0", { kind: "proxy", address: null, codeHash: HASH.proxy150, chains: "any-evm" }),
  contract("GnosisSafe@1.1.1/canonical", { kind: "singleton", address: ADDRESS.safe111, codeHash: HASH.safe111 }),
  contract("GnosisSafe@1.3.0/canonical", { kind: "singleton", address: ADDRESS.safe130, codeHash: HASH.safe130 }),
  contract("GnosisSafeL2@1.3.0/canonical", {
    kind: "singleton",
    address: ADDRESS.safeL2130,
    codeHash: HASH.safeL2130,
    flags: ["l2"],
  }),
  contract("Safe@1.4.1/canonical", { kind: "singleton", address: ADDRESS.safe141, codeHash: HASH.safe141 }),
  contract("SafeL2@1.4.1/canonical", {
    kind: "singleton",
    address: ADDRESS.safeL2141,
    codeHash: HASH.safeL2141,
    flags: ["l2"],
  }),
  // 1.5.0 is deployed on chain 1 only in this fixture, so a 1.4.1 Safe on chain 100 is not behind.
  contract("Safe@1.5.0/canonical", {
    kind: "singleton",
    address: ADDRESS.safe150,
    codeHash: HASH.safe150,
    chains: [1],
  }),
  contract("SafeL2@1.5.0/canonical", {
    kind: "singleton",
    address: ADDRESS.safeL2150,
    codeHash: HASH.safeL2150,
    flags: ["l2"],
    chains: [1],
  }),
  contract("CompatibilityFallbackHandler@1.4.1/canonical", {
    kind: "fallback-handler",
    address: ADDRESS.compat141,
    codeHash: HASH.compat141,
  }),
  contract("CompatibilityFallbackHandler@1.5.0/canonical", {
    kind: "fallback-handler",
    address: ADDRESS.compat150,
    codeHash: HASH.compat150,
  }),
  contract("ExtensibleFallbackHandler@1.5.0/canonical", {
    kind: "fallback-handler",
    address: ADDRESS.extensible150,
    codeHash: HASH.extensible150,
    flags: ["keeps-safe-state"],
  }),
  contract("GnosisSafeProxyFactory@1.3.0/canonical", {
    kind: "proxy-factory",
    address: ADDRESS.factory130,
    codeHash: HASH.factory130,
  }),
  contract("SafeProxyFactory@1.4.1/canonical", {
    kind: "proxy-factory",
    address: ADDRESS.factory141,
    codeHash: HASH.factory141,
  }),
  contract("SafeProxyFactory@1.5.0/canonical", {
    kind: "proxy-factory",
    address: ADDRESS.factory150,
    codeHash: HASH.factory150,
  }),
  contract("MultiSend@1.4.1/canonical", {
    kind: "setup-helper",
    address: ADDRESS.multiSend141,
    codeHash: HASH.multiSend141,
  }),
  contract("MultiSendCallOnly@1.4.1/canonical", {
    kind: "setup-helper",
    address: ADDRESS.multiSendCallOnly141,
    codeHash: HASH.multiSendCallOnly141,
  }),
  contract("SafeToL2Setup@1.4.1/canonical", {
    kind: "setup-helper",
    address: ADDRESS.toL2Setup141,
    codeHash: HASH.toL2Setup141,
  }),
  contract("SafeToL2Setup@1.5.0/canonical", {
    kind: "setup-helper",
    address: ADDRESS.toL2Setup150,
    codeHash: HASH.toL2Setup150,
    chains: [1],
  }),
  contract("SafeModuleSetup@0.3.0", {
    kind: "setup-helper",
    address: ADDRESS.moduleSetup030,
    codeHash: HASH.moduleSetup030,
  }),
  contract("Safe4337Module@0.3.0", {
    kind: "module",
    roles: ["fallback-handler"],
    address: ADDRESS.safe4337030,
    codeHash: HASH.safe4337030,
  }),
  contract("SafeWebAuthnSharedSigner@0.2.1", {
    kind: "owner-signer",
    roles: ["setup-helper"],
    address: ADDRESS.sharedSigner,
    codeHash: HASH.sharedSigner,
    flags: ["writes-safe-storage"],
  }),
  contract("SignMessageLib@1.4.1/canonical", {
    kind: "library",
    address: ADDRESS.signMessageLib141,
    codeHash: HASH.signMessageLib141,
    flags: ["writes-safe-storage"],
  }),
  contract("zodiac/realityETH@2.0.0", {
    kind: "module",
    address: ADDRESS.realityETH,
    codeHash: HASH.realityETH,
    chains: "any-evm",
  }),
  contract("zodiac/realityERC20@2.0.0", {
    kind: "module",
    address: ADDRESS.realityERC20,
    codeHash: HASH.realityERC20,
    chains: "any-evm",
  }),
  contract("zodiac/delay@1.1.0", {
    kind: "modifier",
    address: ADDRESS.delay110,
    codeHash: HASH.delay110,
    flags: ["faulty"],
    chains: "any-evm",
  }),
  contract("zodiac/delay@1.1.1", {
    kind: "modifier",
    address: ADDRESS.delay111,
    codeHash: HASH.delay111,
    chains: "any-evm",
  }),
  contract("zodiac/scopeGuard@1.0.0", {
    kind: "guard",
    address: ADDRESS.scopeGuard,
    codeHash: HASH.scopeGuard,
    chains: "any-evm",
  }),
]

export const REVIEWED_CONTRACTS: ReviewedContract[] = [
  {
    name: "RealityVetoModule",
    version: null,
    kind: "module",
    chainId: 1,
    address: ADDRESS.vetoModule,
    codeHash: HASH.vetoModule,
    sourceUrl: "https://sourcify.dev/server/v2/contract/1/0x4210382652A5e3C9aF7e1D3c88085818A465449b",
    reviewedOn: "2026-10-12",
    reviewedBy: "test fixture",
    note: "Unit-test entry; the real list is src/data/reviewed-contracts.json.",
  },
]

export const REGISTRY = buildRegistry({ contracts: KNOWN_CONTRACTS }, REVIEWED_CONTRACTS)
