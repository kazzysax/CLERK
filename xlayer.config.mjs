/**
 * xlayer.config.js — the single source of truth for everything OKX / X Layer.
 * Chain, gas token, RPCs, explorer, DEX aggregator, and common token addresses.
 * Imported by the server, the deploy script, the portal, and the swap module so
 * nothing hardcodes a network value in two places.
 *
 * Params verified against OKX X Layer docs:
 *   Mainnet chainId 196 (0xC4), Testnet 1952 (0x7A0). Native gas token: OKB.
 */

export const XLAYER = {
  mainnet: {
    name: "X Layer",
    chainId: 196,
    chainIdHex: "0xC4",
    nativeToken: { symbol: "OKB", name: "OKB", decimals: 18 }, // gas is paid in OKB
    rpc: "https://rpc.xlayer.tech",
    rpcFallback: "https://xlayerrpc.okx.com",      // OKX's secondary endpoint
    wsFlashblocks: "wss://xlayerws.okx.com/flashblocks",
    explorer: "https://www.okx.com/web3/explorer/xlayer",
    explorerTx: (h) => `https://www.okx.com/web3/explorer/xlayer/tx/${h}`,
    explorerAddr: (a) => `https://www.okx.com/web3/explorer/xlayer/address/${a}`,
    bridge: "https://www.okx.com/xlayer/bridge",
  },
  testnet: {
    name: "X Layer Testnet",
    chainId: 1952,
    chainIdHex: "0x7A0",
    nativeToken: { symbol: "OKB", name: "Test OKB", decimals: 18 },
    // drpc is more reliable from some regions; OKX primary kept as fallback
    rpc: "https://xlayer-testnet.drpc.org",
    rpcFallback: "https://testrpc.xlayer.tech/terigon",
    explorer: "https://www.okx.com/web3/explorer/xlayer-test",
    explorerTx: (h) => `https://www.okx.com/web3/explorer/xlayer-test/tx/${h}`,
    explorerAddr: (a) => `https://www.okx.com/web3/explorer/xlayer-test/address/${a}`,
    faucet: "https://www.okx.com/xlayer/faucet",
    bridge: "https://www.okx.com/xlayer/bridge",
  },
};

/**
 * Active network for front-ends. Set via window.CLERK_NETWORK = "mainnet"|"testnet"
 * before page modules load (or edit default below). Deployed testnet contract is set
 * in each page's window.CLERK_CONTRACT bootstrap script.
 */
export function activeNet() {
  const which = (typeof window !== "undefined" && window.CLERK_NETWORK) || "testnet";
  return net(which === "mainnet" ? "mainnet" : "testnet");
}

/**
 * OKX DEX aggregator — used to swap a merchant's held tokens into OKB so they
 * can pay gas and fund escrow. Single-chain swap on X Layer (chainId 196).
 * Docs: OKX DEX API. Requires OKX API credentials (key/secret/passphrase).
 */
export const OKX_DEX = {
  base: "https://www.okx.com/api/v5/dex/aggregator",
  quote: "/quote",
  swap: "/swap",
  approveTx: "/approve-transaction",
  chainId: 196, // X Layer mainnet
};

/**
 * Common X Layer token addresses a merchant might already hold and want to
 * swap FROM into OKB. The aggregator represents the native gas token (OKB)
 * with the canonical sentinel address below.
 * NOTE: verify each against the OKX explorer for your environment before
 * mainnet use — token deployments differ between mainnet and testnet.
 */
export const TOKENS = {
  // Native OKB sentinel used by the OKX DEX aggregator for gas-token swaps
  OKB_NATIVE: "0x0000000000000000000000000000000000000000",
  // Wrapped OKB (WOKB) and common stables on X Layer mainnet — VERIFY on explorer:
  WOKB: "0xe538905cf8410324e03A5A23C1c177a474D59b2b",
  USDT: "0x1E4a5963aBFD975d8c9021ce480b42188849D41d",
  USDC: "0x74b7F16337b8972027F6196A17a631aC6dE26d22",
};

export function net(which) {
  const n = XLAYER[which];
  if (!n) throw new Error(`unknown X Layer network: ${which}`);
  return n;
}

/**
 * Shared ClerkLedgerV2 ABI — the single copy every page and script imports.
 * Superset of what any one page needs; unused entries are harmless to ethers.
 */
export const LEDGER_ABI = [
  "function merchants(address) view returns (bool registered,uint256 escrow,uint256 pricePerTicket)",
  "function registerMerchant(uint256 pricePerTicket) payable",
  "function depositEscrow() payable",
  "function withdrawEscrow(uint256 amount)",
  "function setPrice(uint256 pricePerTicket)",
  "function reopen(bytes32 ticketHash)",
  "function reopenWindow() view returns (uint64)",
  "function finalize(bytes32 ticketHash)",
  "function trackRecord() view returns (uint256 solo,uint256 assisted,uint256 reopened,uint256 paidOut,uint256 custScoreCenti,uint256 custRatings,uint256 merchScoreCenti,uint256 merchRatings)",
  "function soloRateBps() view returns (uint256)",
  "function customerScore() view returns (uint256 centistars, uint256 ratings)",
  "function merchantScore() view returns (uint256 centistars, uint256 ratings)",
  "function getTicket(bytes32) view returns (tuple(address merchant,uint64 registeredAt,uint64 resolvedAt,uint16 confidenceBps,bool resolvedByClerk,uint8 status,uint8 customerRating,uint8 merchantRating,uint256 lockedPayout))",
  "event TicketRegistered(bytes32 indexed ticketHash, address indexed merchant)",
  "event ResolutionFinalized(bytes32 indexed ticketHash, bool resolvedByClerk, uint256 payout)",
  "event CustomerRated(bytes32 indexed ticketHash, uint8 rating, bytes32 proofHash)",
];
