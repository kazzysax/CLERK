const { expect } = require("chai");
const { ethers, network } = require("hardhat");

/**
 * ClerkLedgerV2 — full EVM test suite.
 * Deploys the real compiled bytecode to an in-process EVM and attacks every
 * mechanic: escrow lifecycle, window boundaries, rating guardrails, pause
 * asymmetry, pull payments, operator rotation, batch settlement, solvency.
 */

const WINDOW = 3600n;            // 1h reopen window for tests
const RATING_WINDOW = 30n * 24n * 3600n;
const PRICE = ethers.parseEther("0.05");
const ASSISTED = (PRICE * 4000n) / 10000n;

const H = (s) => ethers.keccak256(ethers.toUtf8Bytes(s));
const PROOF = H("magic-link-token-1");

async function jump(seconds) {
  await network.provider.send("evm_increaseTime", [Number(seconds)]);
  await network.provider.send("evm_mine");
}

describe("ClerkLedgerV2", () => {
  let ledger, operator, payout, merchant, merchant2, stranger;

  beforeEach(async () => {
    [operator, payout, merchant, merchant2, stranger] = await ethers.getSigners();
    const F = await ethers.getContractFactory("ClerkLedgerV2", operator);
    ledger = await F.deploy(payout.address, WINDOW);
    await ledger.waitForDeployment();
    await ledger.connect(merchant).registerMerchant(PRICE, { value: ethers.parseEther("1") });
  });

  // Helper: run a ticket to Pending
  async function toPending(hash, byClerk = true, conf = 9600) {
    await ledger.registerTicket(hash, merchant.address);
    await ledger.submitResolution(hash, conf, byClerk);
  }

  // ----------------------------------------------------------------
  describe("deployment & roles", () => {
    it("sets operator, payout wallet, window", async () => {
      expect(await ledger.operator()).to.equal(operator.address);
      expect(await ledger.payoutWallet()).to.equal(payout.address);
      expect(await ledger.reopenWindow()).to.equal(WINDOW);
    });
    it("rejects zero payout wallet", async () => {
      const F = await ethers.getContractFactory("ClerkLedgerV2");
      await expect(F.deploy(ethers.ZeroAddress, WINDOW)).to.be.revertedWithCustomError(F, "ZeroAddress");
    });
  });

  // ----------------------------------------------------------------
  describe("merchant escrow", () => {
    it("registers with deposit; double-register reverts", async () => {
      const m = await ledger.merchants(merchant.address);
      expect(m.registered).to.equal(true);
      expect(m.escrow).to.equal(ethers.parseEther("1"));
      await expect(ledger.connect(merchant).registerMerchant(PRICE))
        .to.be.revertedWithCustomError(ledger, "AlreadyRegistered");
    });
    it("deposits and withdraws free escrow", async () => {
      await ledger.connect(merchant).depositEscrow({ value: ethers.parseEther("0.5") });
      expect((await ledger.merchants(merchant.address)).escrow).to.equal(ethers.parseEther("1.5"));
      await ledger.connect(merchant).withdrawEscrow(ethers.parseEther("1.5"));
      expect((await ledger.merchants(merchant.address)).escrow).to.equal(0n);
    });
    it("cannot withdraw locked funds", async () => {
      await toPending(H("t1"));
      // free escrow = 1 - 0.05; withdrawing full 1.0 must revert
      await expect(ledger.connect(merchant).withdrawEscrow(ethers.parseEther("1")))
        .to.be.revertedWithCustomError(ledger, "InsufficientEscrow");
      await ledger.connect(merchant).withdrawEscrow(ethers.parseEther("0.95")); // exactly free: ok
    });
    it("unregistered merchant cannot deposit or be assigned tickets", async () => {
      await expect(ledger.connect(stranger).depositEscrow({ value: 1n }))
        .to.be.revertedWithCustomError(ledger, "MerchantNotRegistered");
      await expect(ledger.registerTicket(H("x"), stranger.address))
        .to.be.revertedWithCustomError(ledger, "MerchantNotRegistered");
    });
  });

  // ----------------------------------------------------------------
  describe("ticket lifecycle — solo", () => {
    it("register → submit locks payout out of escrow", async () => {
      await toPending(H("t1"));
      const m = await ledger.merchants(merchant.address);
      expect(m.escrow).to.equal(ethers.parseEther("0.95"));
      const t = await ledger.getTicket(H("t1"));
      expect(t.status).to.equal(2n); // Pending
      expect(t.lockedPayout).to.equal(PRICE);
      expect(t.resolvedByClerk).to.equal(true);
    });
    it("only operator registers/submits; duplicates revert", async () => {
      await expect(ledger.connect(stranger).registerTicket(H("t1"), merchant.address))
        .to.be.revertedWithCustomError(ledger, "NotOperator");
      await ledger.registerTicket(H("t1"), merchant.address);
      await expect(ledger.registerTicket(H("t1"), merchant.address))
        .to.be.revertedWithCustomError(ledger, "TicketAlreadyExists");
      await expect(ledger.connect(stranger).submitResolution(H("t1"), 9000, true))
        .to.be.revertedWithCustomError(ledger, "NotOperator");
    });
    it("submit on unregistered ticket / bad confidence reverts", async () => {
      await expect(ledger.submitResolution(H("nope"), 9000, true))
        .to.be.revertedWithCustomError(ledger, "WrongStatus");
      await ledger.registerTicket(H("t1"), merchant.address);
      await expect(ledger.submitResolution(H("t1"), 10001, true))
        .to.be.revertedWithCustomError(ledger, "InvalidConfidence");
    });
    it("insufficient escrow blocks resolution claim", async () => {
      await ledger.connect(merchant).withdrawEscrow(ethers.parseEther("0.99"));
      await ledger.registerTicket(H("t1"), merchant.address);
      await expect(ledger.submitResolution(H("t1"), 9000, true))
        .to.be.revertedWithCustomError(ledger, "InsufficientEscrow");
    });
  });

  // ----------------------------------------------------------------
  describe("reopen window — exact boundaries", () => {
    it("finalize at exactly the window boundary reverts; one second later succeeds", async () => {
      await toPending(H("t1"));
      const resolvedAt = (await ledger.getTicket(H("t1"))).resolvedAt;
      // Pin the finalize tx's block to EXACTLY resolvedAt + WINDOW → <= boundary is inclusive → revert
      await network.provider.send("evm_setNextBlockTimestamp", [Number(resolvedAt + WINDOW)]);
      await expect(ledger.finalize(H("t1")))
        .to.be.revertedWithCustomError(ledger, "ReopenWindowStillOpen");
      // One second past the boundary → succeeds
      await network.provider.send("evm_setNextBlockTimestamp", [Number(resolvedAt + WINDOW + 1n)]);
      await ledger.finalize(H("t1"));
      expect((await ledger.getTicket(H("t1"))).status).to.equal(3n); // Finalized
    });
    it("reopen inside window works; after window reverts", async () => {
      await toPending(H("t1"));
      await ledger.connect(merchant).reopen(H("t1"));
      expect((await ledger.getTicket(H("t1"))).status).to.equal(4n); // Reopened
      await toPending(H("t2"));
      await jump(WINDOW + 1n);
      await expect(ledger.connect(merchant).reopen(H("t2")))
        .to.be.revertedWithCustomError(ledger, "ReopenWindowClosed");
    });
    it("reopen returns funds; only merchant or operator may reopen", async () => {
      await toPending(H("t1"));
      await expect(ledger.connect(stranger).reopen(H("t1")))
        .to.be.revertedWithCustomError(ledger, "NotTicketMerchant");
      await ledger.reopen(H("t1")); // operator path
      expect((await ledger.merchants(merchant.address)).escrow).to.equal(ethers.parseEther("1"));
      expect(await ledger.reopenedCount()).to.equal(1n);
    });
    it("reopen voids attached ratings and restores counters", async () => {
      await toPending(H("t1"));
      await ledger.rateAsCustomer(H("t1"), 5, PROOF);
      await ledger.connect(merchant).rateAsMerchant(H("t1"), 4);
      expect(await ledger.custRatingCount()).to.equal(1n);
      expect(await ledger.merchRatingCount()).to.equal(1n);
      await ledger.connect(merchant).reopen(H("t1"));
      expect(await ledger.custRatingCount()).to.equal(0n);
      expect(await ledger.custRatingSum()).to.equal(0n);
      expect(await ledger.merchRatingCount()).to.equal(0n);
      expect(await ledger.merchRatingSum()).to.equal(0n);
    });
  });

  // ----------------------------------------------------------------
  describe("finalize & pull payments", () => {
    it("finalize credits claimable, counts solo, pays nothing directly", async () => {
      await toPending(H("t1"));
      await jump(WINDOW + 1n);
      await ledger.finalize(H("t1"));
      expect(await ledger.claimablePayout()).to.equal(PRICE);
      expect(await ledger.soloResolved()).to.equal(1n);
      expect(await ledger.totalPaidOut()).to.equal(PRICE);
      await expect(ledger.finalize(H("t1"))).to.be.revertedWithCustomError(ledger, "WrongStatus");
    });
    it("assisted resolution locks and pays exactly 40%", async () => {
      await toPending(H("t1"), false);
      expect((await ledger.getTicket(H("t1"))).lockedPayout).to.equal(ASSISTED);
      await jump(WINDOW + 1n);
      await ledger.finalize(H("t1"));
      expect(await ledger.humanAssisted()).to.equal(1n);
      expect(await ledger.claimablePayout()).to.equal(ASSISTED);
    });
    it("only payout wallet claims; balance transfers; NothingToClaim after", async () => {
      await toPending(H("t1"));
      await jump(WINDOW + 1n);
      await ledger.finalize(H("t1"));
      await expect(ledger.connect(stranger).claimPayout())
        .to.be.revertedWithCustomError(ledger, "NotPayoutWallet");
      await expect(ledger.connect(payout).claimPayout()).to.changeEtherBalance(payout, PRICE);
      expect(await ledger.claimablePayout()).to.equal(0n);
      await expect(ledger.connect(payout).claimPayout())
        .to.be.revertedWithCustomError(ledger, "NothingToClaim");
    });
    it("finalizeBatch skips not-ready and non-pending, settles the rest", async () => {
      await toPending(H("a"));
      await toPending(H("b"));
      await jump(WINDOW + 1n);
      await toPending(H("c"));                      // fresh — window still open
      await ledger.connect(merchant).reopen(H("c")); // now Reopened — must be skipped
      await toPending(H("d"));                      // fresh Pending — window open, skipped
      await ledger.finalizeBatch([H("a"), H("b"), H("c"), H("d"), H("ghost")]);
      expect((await ledger.getTicket(H("a"))).status).to.equal(3n);
      expect((await ledger.getTicket(H("b"))).status).to.equal(3n);
      expect((await ledger.getTicket(H("c"))).status).to.equal(4n); // still Reopened
      expect((await ledger.getTicket(H("d"))).status).to.equal(2n); // still Pending
      expect(await ledger.claimablePayout()).to.equal(PRICE * 2n);
    });
  });

  // ----------------------------------------------------------------
  describe("ratings — guardrail, deadline, math", () => {
    beforeEach(async () => { await toPending(H("t1")); });

    it("merchant rating REVERTS without prior customer rating (guardrail)", async () => {
      await expect(ledger.connect(merchant).rateAsMerchant(H("t1"), 5))
        .to.be.revertedWithCustomError(ledger, "CustomerRatingRequired");
      await ledger.rateAsCustomer(H("t1"), 4, PROOF);
      await ledger.connect(merchant).rateAsMerchant(H("t1"), 5); // now allowed
    });
    it("only operator relays customer ratings; only ticket merchant rates as merchant", async () => {
      await expect(ledger.connect(stranger).rateAsCustomer(H("t1"), 5, PROOF))
        .to.be.revertedWithCustomError(ledger, "NotOperator");
      await ledger.rateAsCustomer(H("t1"), 5, PROOF);
      await expect(ledger.connect(stranger).rateAsMerchant(H("t1"), 5))
        .to.be.revertedWithCustomError(ledger, "NotTicketMerchant");
    });
    it("range and once-only enforced", async () => {
      await expect(ledger.rateAsCustomer(H("t1"), 0, PROOF)).to.be.revertedWithCustomError(ledger, "InvalidRating");
      await expect(ledger.rateAsCustomer(H("t1"), 6, PROOF)).to.be.revertedWithCustomError(ledger, "InvalidRating");
      await ledger.rateAsCustomer(H("t1"), 5, PROOF);
      await expect(ledger.rateAsCustomer(H("t1"), 4, PROOF)).to.be.revertedWithCustomError(ledger, "AlreadyRated");
    });
    it("rating deadline: closed after 30 days", async () => {
      await jump(RATING_WINDOW + 1n);
      await expect(ledger.rateAsCustomer(H("t1"), 5, PROOF))
        .to.be.revertedWithCustomError(ledger, "RatingWindowClosed");
    });
    it("proofHash is emitted with the customer rating", async () => {
      await expect(ledger.rateAsCustomer(H("t1"), 5, PROOF))
        .to.emit(ledger, "CustomerRated").withArgs(H("t1"), 5, PROOF);
    });
    it("Bayesian math onchain matches spec: prior 3.50, two 5★ → 3.63", async () => {
      let [score, n] = await ledger.customerScore();
      expect(score).to.equal(350n); expect(n).to.equal(0n);
      await ledger.rateAsCustomer(H("t1"), 5, PROOF);
      await toPending(H("t2"));
      await ledger.rateAsCustomer(H("t2"), 5, H("proof2"));
      [score, n] = await ledger.customerScore();
      expect(score).to.equal(363n); // (20*350 + 1000) / 22 = 363
      expect(n).to.equal(2n);
    });
  });

  // ----------------------------------------------------------------
  describe("pause asymmetry — the merchant-protection invariant", () => {
    it("pause blocks intake, resolutions, finalize, ratings", async () => {
      await toPending(H("t1"));
      await ledger.setPaused(true);
      await expect(ledger.registerTicket(H("t2"), merchant.address)).to.be.revertedWithCustomError(ledger, "Paused");
      await expect(ledger.rateAsCustomer(H("t1"), 5, PROOF)).to.be.revertedWithCustomError(ledger, "Paused");
      await jump(WINDOW + 1n);
      await expect(ledger.finalize(H("t1"))).to.be.revertedWithCustomError(ledger, "Paused");
      await expect(ledger.connect(merchant).depositEscrow({ value: 1n })).to.be.revertedWithCustomError(ledger, "Paused");
    });
    it("reopen and withdrawEscrow ALWAYS work while paused", async () => {
      await toPending(H("t1"));
      await ledger.setPaused(true);
      await ledger.connect(merchant).reopen(H("t1"));                     // exit right 1
      await ledger.connect(merchant).withdrawEscrow(ethers.parseEther("1")); // exit right 2
      expect((await ledger.merchants(merchant.address)).escrow).to.equal(0n);
    });
    it("only operator toggles pause; unpause restores everything", async () => {
      await expect(ledger.connect(stranger).setPaused(true)).to.be.revertedWithCustomError(ledger, "NotOperator");
      await ledger.setPaused(true);
      await ledger.setPaused(false);
      await toPending(H("t1")); // works again
    });
  });

  // ----------------------------------------------------------------
  describe("two-step operator rotation", () => {
    it("full rotation transfers powers; old key loses them", async () => {
      await ledger.transferOperator(stranger.address);
      expect(await ledger.operator()).to.equal(operator.address); // not yet
      await expect(ledger.connect(merchant).acceptOperator())
        .to.be.revertedWithCustomError(ledger, "NotPendingOperator");
      await ledger.connect(stranger).acceptOperator();
      expect(await ledger.operator()).to.equal(stranger.address);
      await expect(ledger.registerTicket(H("t1"), merchant.address))
        .to.be.revertedWithCustomError(ledger, "NotOperator"); // old key dead
      await ledger.connect(stranger).registerTicket(H("t1"), merchant.address); // new key live
    });
    it("cannot rotate to zero; only operator initiates", async () => {
      await expect(ledger.transferOperator(ethers.ZeroAddress)).to.be.revertedWithCustomError(ledger, "ZeroAddress");
      await expect(ledger.connect(stranger).transferOperator(stranger.address)).to.be.revertedWithCustomError(ledger, "NotOperator");
    });
  });

  // ----------------------------------------------------------------
  describe("solvency invariant", () => {
    it("contract balance always equals free + locked + claimable across a busy sequence", async () => {
      await ledger.connect(merchant2).registerMerchant(PRICE, { value: ethers.parseEther("2") });
      const invariant = async () => {
        const bal = await ethers.provider.getBalance(await ledger.getAddress());
        const m1 = (await ledger.merchants(merchant.address)).escrow;
        const m2 = (await ledger.merchants(merchant2.address)).escrow;
        let locked = 0n;
        for (const h of ["a","b","c","d","e"]) {
          try { locked += (await ledger.getTicket(H(h))).lockedPayout; } catch {}
        }
        const claimable = await ledger.claimablePayout();
        expect(bal).to.equal(m1 + m2 + locked + claimable);
      };
      await toPending(H("a")); await invariant();
      await ledger.registerTicket(H("b"), merchant2.address);
      await ledger.submitResolution(H("b"), 8800, false); await invariant();
      await ledger.connect(merchant).reopen(H("a")); await invariant();
      await toPending(H("c")); await invariant();
      await jump(WINDOW + 1n);
      await ledger.finalizeBatch([H("b"), H("c")]); await invariant();
      await ledger.connect(payout).claimPayout(); await invariant();
      await ledger.connect(merchant).withdrawEscrow(ethers.parseEther("0.5")); await invariant();
    });
  });
});
