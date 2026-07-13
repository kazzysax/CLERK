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
 * Pick an injected EIP-1193 provider. When several wallets inject, prefer
 * genuine MetaMask — impersonators (Zerion, Rabby, Brave all set isMetaMask)
 * and OKX have "Testnet Mode" toggles that block X Layer Testnet (chain 1952)
 * with: "X Layer Testnet is a mainnet. Turn off Testnet Mode".
 */
export function getInjectedProvider() {
  const eth = typeof window !== "undefined" ? window.ethereum : null;
  if (!eth) return null;
  if (Array.isArray(eth.providers) && eth.providers.length) {
    const mm = eth.providers.find(p =>
      p.isMetaMask && !p.isOkxWallet && !p.isOKExWallet && !p.isZerion && !p.isRabby && !p.isBraveWallet);
    if (mm) return mm;
    const okx = eth.providers.find(p => p.isOkxWallet || p.isOKExWallet || p.isOkx);
    if (okx) return okx;
    return eth.providers[0];
  }
  return eth;
}

/** Name the injected wallet so error hints can give wallet-specific fix steps. */
export function providerBrand(p) {
  if (!p) return "your wallet";
  if (p.isZerion) return "Zerion";
  if (p.isOkxWallet || p.isOKExWallet || p.isOkx) return "OKX Wallet";
  if (p.isRabby) return "Rabby";
  if (p.isBraveWallet) return "Brave Wallet";
  if (p.isMetaMask) return "MetaMask";
  return "your wallet";
}

/** Every message field an EIP-1193 / ethers v6 error may bury the real reason in. */
function errText(e) {
  return [e?.shortMessage, e?.reason, e?.message, e?.data?.message,
          e?.info?.error?.message, e?.error?.message]
    .filter(Boolean).join(" | ") || String(e || "");
}

/** Where the Testnet Mode switch lives, per wallet. */
const TESTNET_MODE_PATHS = {
  "Zerion":     "Zerion → your profile icon → Settings → turn OFF Testnet Mode",
  "OKX Wallet": "OKX Wallet → Settings (⚙) → Preferences → turn OFF Testnet Mode",
};

/**
 * Actionable message for wallet "Testnet Mode" rejections (chain switch OR
 * transaction send — Zerion blocks at Execute time, after the switch worked).
 * Returns null when the error isn't one we have a better message for.
 */
export function walletTxErrorHint(err, networkName = "X Layer Testnet", walletName = "your wallet") {
  const msg = errText(err);
  if (/testnet mode/i.test(msg) || /is a mainnet/i.test(msg)) {
    const path = TESTNET_MODE_PATHS[walletName] || (walletName + " settings → turn OFF Testnet Mode");
    return (
      walletName + " has Testnet Mode ON but doesn't recognize " + networkName +
      " (chain 1952) as a testnet, so it blocks it. Fix: open " + path +
      " → reconnect and try again. Or use MetaMask on chain 1952."
    );
  }
  if (/user rejected|denied|4001/i.test(msg)) return "Wallet request was rejected.";
  return null;
}

/** Human-readable fix for common wallet switch/add failures. */
export function walletChainErrorHint(err, networkName = "X Layer Testnet", walletName = "your wallet") {
  const hint = walletTxErrorHint(err, networkName, walletName);
  if (hint) return hint;
  const msg = errText(err);
  if (/Unrecognized chain|4902/i.test(msg)) return "Add " + networkName + " to your wallet, then try again.";
  return msg || ("Please switch your wallet to " + networkName + ".");
}

/**
 * Switch (or add) the injected wallet to the given X Layer network config
 * (`activeNet()` or XLAYER.testnet / .mainnet).
 */
export async function ensureWalletOnNet(ethereum, netCfg) {
  if (!ethereum) throw new Error("No wallet provider");
  const brand = providerBrand(ethereum);
  const chainIdHex = netCfg.chainIdHex;
  const params = {
    chainId: chainIdHex,
    chainName: netCfg.name,
    nativeCurrency: {
      name: netCfg.nativeToken.name,
      symbol: netCfg.nativeToken.symbol,
      decimals: netCfg.nativeToken.decimals,
    },
    rpcUrls: [netCfg.rpc, netCfg.rpcFallback].filter(Boolean),
    blockExplorerUrls: [netCfg.explorer],
  };
  // Skip the switch call if the wallet is already on the right chain — OKX
  // Wallet is known to hang forever (never resolve, never reject) on a
  // redundant wallet_switchEthereumChain to the chain it's already on.
  try {
    const current = await ethereum.request({ method: "eth_chainId" });
    if (String(current).toLowerCase() === chainIdHex.toLowerCase()) return;
  } catch { /* probe failed — fall through and attempt the switch anyway */ }
  try {
    await ethereum.request({ method: "wallet_switchEthereumChain", params: [{ chainId: chainIdHex }] });
    return;
  } catch (e) {
    const code = e?.code ?? e?.data?.originalError?.code;
    // 4902 = chain not added; -32603 sometimes used by OKX for missing chain
    if (code === 4902 || code === -32603 || /unrecognized chain/i.test(String(e?.message))) {
      try {
        await ethereum.request({ method: "wallet_addEthereumChain", params: [params] });
        return;
      } catch (addErr) {
        throw new Error(walletChainErrorHint(addErr, netCfg.name, brand));
      }
    }
    throw new Error(walletChainErrorHint(e, netCfg.name, brand));
  }
}

/**
 * Shared ClerkLedgerV2 ABI — the single copy every page and script imports.
 * Superset of what any one page needs; unused entries are harmless to ethers.
 */
/**
 * ClerkReputation ABI — accuracy onchain, no OKB fees / escrow.
 * (trackRecord 4th field = finalized count, not wei paid)
 * Ratings are customer-only — there is no merchant self-rating path.
 */
export const LEDGER_ABI = [
  "function merchants(address) view returns (bool registered,uint64 registeredAt)",
  "function registerMerchant()",
  "function reopen(bytes32 ticketHash)",
  "function reopenWindow() view returns (uint64)",
  "function finalize(bytes32 ticketHash)",
  "function trackRecord() view returns (uint256 solo,uint256 assisted,uint256 reopened,uint256 finalized,uint256 custScoreCenti,uint256 custRatings)",
  "function soloRateBps() view returns (uint256)",
  "function customerScore() view returns (uint256 centistars, uint256 ratings)",
  "function getTicket(bytes32) view returns (tuple(address merchant,uint64 registeredAt,uint64 resolvedAt,uint16 confidenceBps,bool resolvedByClerk,uint8 status,uint8 customerRating))",
  "function totalFinalized() view returns (uint256)",
  "event TicketRegistered(bytes32 indexed ticketHash, address indexed merchant)",
  "event ResolutionFinalized(bytes32 indexed ticketHash, bool resolvedByClerk)",
  "event CustomerRated(bytes32 indexed ticketHash, uint8 rating, bytes32 proofHash)",
  "event MerchantRegistered(address indexed merchant, uint64 at)",
];
