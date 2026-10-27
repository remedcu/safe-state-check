import { parseAbi } from "viem"

// Only the functions and events the checks call or decode. Signatures are equal in Safe 1.3.0, 1.4.1 and 1.5.0
// (setup is 0xb63e800d in all three); event indexing differs by version (SAFE_EVENTS_INDEXED and SAFE_EVENTS_PLAIN).
export const SAFE_ABI = parseAbi([
  "function getOwners() view returns (address[])",
  "function getThreshold() view returns (uint256)",
  "function nonce() view returns (uint256)",
  "function getModulesPaginated(address start, uint256 pageSize) view returns (address[] array, address next)",
  "function VERSION() view returns (string)",
  "function setup(address[] _owners, uint256 _threshold, address to, bytes data, address fallbackHandler, address paymentToken, uint256 payment, address paymentReceiver)",
  "event SafeSetup(address indexed initiator, address[] owners, uint256 threshold, address initializer, address fallbackHandler)",
])

// Every creation entry point of the 1.0.0 to 1.5.0 factories (not every factory has every one).
export const FACTORY_ABI = parseAbi([
  "function createProxy(address singleton, bytes data)",
  "function createProxyWithNonce(address _singleton, bytes initializer, uint256 saltNonce)",
  "function createProxyWithCallback(address _singleton, bytes initializer, uint256 saltNonce, address callback)",
  "function createProxyWithNonceL2(address _singleton, bytes initializer, uint256 saltNonce)",
  "function createChainSpecificProxyWithNonce(address _singleton, bytes initializer, uint256 saltNonce)",
  "function createChainSpecificProxyWithNonceL2(address _singleton, bytes initializer, uint256 saltNonce)",
  "event ProxyCreationL2(address indexed proxy, address singleton, bytes initializer, uint256 saltNonce)",
  "event ChainSpecificProxyCreationL2(address indexed proxy, address singleton, bytes initializer, uint256 saltNonce, uint256 chainId)",
])

// The Safe's own events, in the shape 1.4.1 and 1.5.0 emit: the address or transaction hash is indexed. 1.3.0 emits
// the same events (same topic) with nothing indexed, and an upgraded Safe's history mixes both, so a log is decoded
// with whichever list matches its topic count.
export const SAFE_EVENTS_INDEXED = parseAbi([
  "event AddedOwner(address indexed owner)",
  "event RemovedOwner(address indexed owner)",
  "event EnabledModule(address indexed module)",
  "event DisabledModule(address indexed module)",
  "event ChangedGuard(address indexed guard)",
  "event ChangedModuleGuard(address indexed moduleGuard)",
  "event ChangedFallbackHandler(address indexed handler)",
  "event ExecutionSuccess(bytes32 indexed txHash, uint256 payment)",
  "event ExecutionFailure(bytes32 indexed txHash, uint256 payment)",
])

// The 1.3.0 shape of the events above, plus the events whose indexing never changed.
export const SAFE_EVENTS_PLAIN = parseAbi([
  "event AddedOwner(address owner)",
  "event RemovedOwner(address owner)",
  "event EnabledModule(address module)",
  "event DisabledModule(address module)",
  "event ChangedGuard(address guard)",
  "event ChangedFallbackHandler(address handler)",
  "event ExecutionSuccess(bytes32 txHash, uint256 payment)",
  "event ExecutionFailure(bytes32 txHash, uint256 payment)",
  "event ChangedThreshold(uint256 threshold)",
  "event ChangedMasterCopy(address singleton)",
  "event ApproveHash(bytes32 indexed approvedHash, address indexed owner)",
  "event SignMsg(bytes32 indexed msgHash)",
  "event ExecutionFromModuleSuccess(address indexed module)",
  "event ExecutionFromModuleFailure(address indexed module)",
  "event SafeSetup(address indexed initiator, address[] owners, uint256 threshold, address initializer, address fallbackHandler)",
])

export const MULTISEND_ABI = parseAbi(["function multiSend(bytes transactions) payable"])

// Calls a setup batch usually holds, for display.
export const SETUP_HELPER_ABI = parseAbi([
  "function enableModules(address[] modules)",
  "function setupToL2(address l2Singleton)",
  "function configure((uint256 x, uint256 y, uint176 verifiers) signer)",
  "function approve(address spender, uint256 amount)",
])

export const ZODIAC_ABI = parseAbi([
  "function owner() view returns (address)",
  "function avatar() view returns (address)",
  "function target() view returns (address)",
  "function getGuard() view returns (address)",
  "function getModulesPaginated(address start, uint256 pageSize) view returns (address[] array, address next)",
  "function oracle() view returns (address)",
  "function template() view returns (uint256)",
  "function questionTimeout() view returns (uint32)",
  "function questionCooldown() view returns (uint32)",
  "function answerExpiration() view returns (uint32)",
  "function minimumBond() view returns (uint256)",
  "function questionArbitrator() view returns (address)",
])
