const hre = require("hardhat");

/**
 * Deploys ClerkLedgerV2 to X Layer, then (on testnet) walks one full ticket
 * lifecycle so real transactions appear on the OKX explorer:
 * register merchant -> register ticket -> submit resolution -> rate (with
 * proofHash) -> finalize -> claim payout.
 *
 * Usage:
 *   npx hardhat run deploy-v2.js --network xlayerTestnet
 *   npx hardhat run deploy-v2.js --network xlayer
 */
async function main() {
  const [deployer] = await hre.ethers.getSigners();
  const net = hre.network.name;
  console.log(`Deploying ClerkLedgerV2 to ${net} as ${deployer.address}`);

  // 72h reopen window on mainnet; 60s on testnet so a demo can finalize live.
  const REOPEN_WINDOW = net === "xlayer" ? 259200 : 60;

  const Ledger = await hre.ethers.getContractFactory("ClerkLedgerV2");
  const ledger = await Ledger.deploy(deployer.address, REOPEN_WINDOW);
  await ledger.waitForDeployment();
  const addr = await ledger.getAddress();
  console.log(`ClerkLedgerV2 deployed: ${addr}`);
  console.log(`Reopen window: ${REOPEN_WINDOW}s | payout wallet: ${deployer.address}`);

  if (net !== "xlayerTestnet") {
    console.log("Mainnet deploy complete. Set window.CLERK_CONTRACT to this address in the front-ends.");
    return;
  }

  // ---- Full lifecycle on testnet ----
  const price = hre.ethers.parseEther("0.001");
  const deposit = hre.ethers.parseEther("0.01");

  console.log("registerMerchant + escrow deposit…");
  await (await ledger.registerMerchant(price, { value: deposit })).wait();

  const ticketHash = hre.ethers.keccak256(hre.ethers.toUtf8Bytes("NW-4012:demo"));
  console.log("registerTicket:", ticketHash);
  await (await ledger.registerTicket(ticketHash, deployer.address)).wait();

  console.log("submitResolution (solo, 96%) — payout locks, window starts…");
  await (await ledger.submitResolution(ticketHash, 9600, true)).wait();

  // V2 customer rating requires a proofHash (keccak of the single-use link token).
  const proofHash = hre.ethers.keccak256(hre.ethers.toUtf8Bytes("demo-rating-token"));
  console.log("rateAsCustomer 5★ (with proofHash)…");
  await (await ledger.rateAsCustomer(ticketHash, 5, proofHash)).wait();

  console.log("rateAsMerchant 5★ (guardrail satisfied)…");
  await (await ledger.rateAsMerchant(ticketHash, 5)).wait();

  console.log(`Waiting out the ${REOPEN_WINDOW}s reopen window…`);
  await new Promise((r) => setTimeout(r, (REOPEN_WINDOW + 5) * 1000));

  console.log("finalize — credits claimable payout…");
  await (await ledger.finalize(ticketHash)).wait();

  console.log("claimPayout — payout wallet pulls its balance…");
  await (await ledger.claimPayout()).wait();

  const tr = await ledger.trackRecord();
  console.log("--- Onchain track record ---");
  console.log(`solo: ${tr[0]} | assisted: ${tr[1]} | reopened: ${tr[2]}`);
  console.log(`paid out: ${hre.ethers.formatEther(tr[3])} OKB`);
  console.log(`customer score: ${(Number(tr[4]) / 100).toFixed(2)} (${tr[5]} ratings)`);
  console.log(`\nContract: ${addr}`);
  console.log("Set window.CLERK_CONTRACT to this address in portal.html + reputation.html.");
}

main().catch((e) => { console.error(e); process.exit(1); });
