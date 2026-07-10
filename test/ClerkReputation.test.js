const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");

const H = (s) => ethers.keccak256(ethers.toUtf8Bytes(s));
const PROOF = H("rating-token");
const WINDOW = 100;

describe("ClerkReputation (no payment)", () => {
  let rep, op, merchant, other;

  beforeEach(async () => {
    [op, merchant, other] = await ethers.getSigners();
    const F = await ethers.getContractFactory("ClerkReputation");
    rep = await F.deploy(WINDOW);
    await rep.waitForDeployment();
  });

  it("registers merchants free (no value)", async () => {
    await expect(rep.connect(merchant).registerMerchant())
      .to.emit(rep, "MerchantRegistered");
    const m = await rep.merchants(merchant.address);
    expect(m.registered).to.equal(true);
    await expect(rep.connect(merchant).registerMerchant()).to.be.reverted;
  });

  it("full accuracy lifecycle without any OKB transfer", async () => {
    await rep.connect(merchant).registerMerchant();
    const th = H("t1");
    await rep.registerTicket(th, merchant.address);
    await rep.submitResolution(th, 9000, true);

    const balBefore = await ethers.provider.getBalance(await rep.getAddress());
    expect(balBefore).to.equal(0n);

    await rep.rateAsCustomer(th, 5, PROOF);
    await rep.connect(merchant).rateAsMerchant(th, 5);

    await time.increase(WINDOW + 1);
    await rep.finalize(th);

    const balAfter = await ethers.provider.getBalance(await rep.getAddress());
    expect(balAfter).to.equal(0n);

    const tr = await rep.trackRecord();
    expect(tr[0]).to.equal(1n); // solo
    expect(tr[3]).to.equal(1n); // finalized count
    expect(Number(tr[4])).to.be.gt(350); // Bayesian customer score moved up
  });

  it("reopen voids ratings and counts publicly", async () => {
    await rep.connect(merchant).registerMerchant();
    const th = H("t2");
    await rep.registerTicket(th, merchant.address);
    await rep.submitResolution(th, 8000, true);
    await rep.rateAsCustomer(th, 2, PROOF);
    await rep.connect(merchant).reopen(th);
    const tr = await rep.trackRecord();
    expect(tr[2]).to.equal(1n); // reopened
    expect(tr[5]).to.equal(0n); // customer ratings wiped from aggregate
  });

  it("pause blocks intake but not reopen", async () => {
    await rep.connect(merchant).registerMerchant();
    const th = H("t3");
    await rep.registerTicket(th, merchant.address);
    await rep.submitResolution(th, 7000, true);
    await rep.setPaused(true);
    await expect(rep.registerTicket(H("t4"), merchant.address)).to.be.reverted;
    await rep.connect(merchant).reopen(th);
  });
});
