const hre = require("hardhat");

/**
 * Deploys ClerkReputation (accuracy onchain, no OKB fees).
 * On testnet, walks register → resolve → rate → finalize so explorer shows life.
 *
 *   npx hardhat run scripts/deploy-reputation.cjs --network xlayerTestnet
 */
async function main() {
  const [deployer] = await hre.ethers.getSigners();
  const net = hre.network.name;
  console.log(`Deploying ClerkReputation to ${net} as ${deployer.address}`);

  const REOPEN_WINDOW = net === "xlayer" ? 259200 : 60;
  const F = await hre.ethers.getContractFactory("ClerkReputation");
  const rep = await F.deploy(REOPEN_WINDOW);
  await rep.waitForDeployment();
  const addr = await rep.getAddress();
  console.log(`ClerkReputation deployed: ${addr}`);
  console.log(`Reopen window: ${REOPEN_WINDOW}s | NO escrow / NO OKB fees`);

  if (net !== "xlayerTestnet") {
    console.log("Set window.CLERK_CONTRACT + CLERK_LEDGER_ADDRESS to this address.");
    return;
  }

  console.log("registerMerchant (free)…");
  await (await rep.registerMerchant()).wait();

  const ticketHash = hre.ethers.keccak256(hre.ethers.toUtf8Bytes("rep-demo:1"));
  console.log("registerTicket:", ticketHash);
  await (await rep.registerTicket(ticketHash, deployer.address)).wait();

  console.log("submitResolution (solo, 95%) — accuracy only…");
  await (await rep.submitResolution(ticketHash, 9500, true)).wait();

  const proofHash = hre.ethers.keccak256(hre.ethers.toUtf8Bytes("demo-rating-token"));
  console.log("rateAsCustomer 5★…");
  await (await rep.rateAsCustomer(ticketHash, 5, proofHash)).wait();
  await (await rep.rateAsMerchant(ticketHash, 5)).wait();

  console.log(`Waiting ${REOPEN_WINDOW}s reopen window…`);
  await new Promise((r) => setTimeout(r, (REOPEN_WINDOW + 5) * 1000));

  console.log("finalize…");
  await (await rep.finalize(ticketHash)).wait();

  const tr = await rep.trackRecord();
  console.log("--- Onchain accuracy record ---");
  console.log(`solo: ${tr[0]} | assisted: ${tr[1]} | reopened: ${tr[2]} | finalized: ${tr[3]}`);
  console.log(`customer score: ${(Number(tr[4]) / 100).toFixed(2)} (${tr[5]} ratings)`);
  console.log(`\nContract: ${addr}`);
  console.log("Update CLERK_LEDGER_ADDRESS / window.CLERK_CONTRACT to this address.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
