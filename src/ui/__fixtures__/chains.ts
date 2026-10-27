// Chains for UI tests and the fixture player, shaped like src/data/generated/chains.json. Ethereum and Gnosis have
// proof-capable defaults, zkSync has RPCs but no standard proofs, and the last chain has no working default RPC.
import type { ChainInfo } from "@/data/types"

const PROBED = "2026-10-12T14:00:00Z"

export const ETHEREUM: ChainInfo = {
  chainId: 1,
  name: "Ethereum Mainnet",
  shortName: "eth",
  shortNameAliases: [],
  isTestnet: false,
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  explorer: { url: "https://etherscan.io", addressUrl: "https://etherscan.io/address/{address}" },
  blockscoutApi: "https://eth.blockscout.com/api/v2",
  safeTxServiceApi: "https://api.safe.global/tx-service/eth/api/v1",
  safeWallet: true,
  detectRank: 0,
  rootCheck: { status: "supported", reason: "eth_getProof verified against stateRoot by drpc and blast" },
  rpcs: [
    {
      url: "https://eth.drpc.org",
      operator: "drpc",
      operatorKind: "provider",
      aggregator: true,
      proofs: true,
      probedAt: PROBED,
    },
    {
      url: "https://eth-mainnet.public.blastapi.io",
      operator: "blast",
      operatorKind: "provider",
      aggregator: false,
      proofs: true,
      probedAt: PROBED,
    },
    {
      url: "https://ethereum-rpc.publicnode.com",
      operator: "publicnode",
      operatorKind: "provider",
      aggregator: false,
      proofs: false,
      probedAt: PROBED,
    },
  ],
}

export const GNOSIS: ChainInfo = {
  chainId: 100,
  name: "Gnosis",
  shortName: "gno",
  shortNameAliases: [],
  isTestnet: false,
  nativeCurrency: { name: "xDAI", symbol: "XDAI", decimals: 18 },
  explorer: { url: "https://gnosisscan.io", addressUrl: "https://gnosisscan.io/address/{address}" },
  blockscoutApi: "https://gnosisscan.io/api/v2",
  safeTxServiceApi: "https://api.safe.global/tx-service/gno/api/v1",
  safeWallet: true,
  detectRank: 2,
  rootCheck: { status: "supported", reason: "eth_getProof verified against stateRoot by team:gnosischain.com" },
  rpcs: [
    {
      url: "https://rpc.gnosischain.com",
      operator: "team:gnosischain.com",
      operatorKind: "team",
      aggregator: false,
      proofs: true,
      probedAt: PROBED,
    },
    {
      url: "https://gnosis-rpc.publicnode.com",
      operator: "publicnode",
      operatorKind: "provider",
      aggregator: false,
      proofs: true,
      probedAt: PROBED,
    },
  ],
}

export const ZKSYNC: ChainInfo = {
  chainId: 324,
  name: "zkSync Mainnet",
  shortName: "zksync",
  shortNameAliases: [],
  isTestnet: false,
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  explorer: { url: "https://explorer.zksync.io", addressUrl: "https://explorer.zksync.io/address/{address}" },
  blockscoutApi: "https://zksync.blockscout.com/api/v2",
  safeTxServiceApi: "https://api.safe.global/tx-service/zksync/api/v1",
  safeWallet: true,
  detectRank: 9,
  rootCheck: {
    status: "unsupported",
    reason: "ZK Stack (EraVM) keeps state in a different tree and does not serve eth_getProof",
  },
  rpcs: [
    {
      url: "https://mainnet.era.zksync.io",
      operator: "team:zksync.io",
      operatorKind: "team",
      aggregator: false,
      proofs: false,
      probedAt: PROBED,
    },
  ],
}

export const NO_RPC_CHAIN: ChainInfo = {
  chainId: 424242,
  name: "Quiet Testnet",
  shortName: "quiet",
  shortNameAliases: [],
  isTestnet: true,
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  explorer: null,
  blockscoutApi: null,
  safeTxServiceApi: null,
  safeWallet: false,
  detectRank: 1000,
  rootCheck: { status: "no-rpc", reason: "No public RPC passed the chain id, CORS and header checks" },
  rpcs: [],
}

export const FIXTURE_CHAINS: ChainInfo[] = [ETHEREUM, GNOSIS, ZKSYNC, NO_RPC_CHAIN]
