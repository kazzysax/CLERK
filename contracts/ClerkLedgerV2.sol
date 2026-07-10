// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * ClerkLedgerV2 — production-hardened onchain reputation + outcome escrow.
 * Target: X Layer mainnet (chainId 196, gas token OKB).
 *
 * HARDENING OVER V1:
 *  1. PULL PAYMENTS — finalize() credits a claimable balance instead of pushing
 *     OKB. A reverting/malicious payout wallet can never brick finalization.
 *  2. CIRCUIT BREAKER — operator can pause new intake and payouts. Deliberately
 *     asymmetric: reopen() and withdrawEscrow() ALWAYS work, even when paused —
 *     merchants can exit and void bad resolutions no matter what the operator does.
 *  3. TWO-STEP OPERATOR ROTATION — key compromise is recoverable without
 *     redeploying; a fat-fingered transfer to a dead address is not accepted
 *     until the new key proves it can sign.
 *  4. RATING DEADLINE — ratings only land within RATING_WINDOW of resolution.
 *     No retroactive score manipulation on months-old tickets.
 *  5. RATING PROOF HASHES — every relayed customer rating commits the keccak256
 *     of its single-use magic-link token. The off-chain provenance trail is
 *     auditable against the chain, one hash at a time.
 *  6. BATCH FINALIZATION — finalizeBatch() skips not-yet-ready tickets instead
 *     of reverting, so one early ticket can't block a settlement sweep.
 *  7. ESCROW SOLVENCY INVARIANT — free + locked + claimable always equals
 *     deposits minus withdrawals; enforced structurally by the accounting.
 *
 * UNCHANGED CORE (from the audited design):
 *  - Ticket hash committed at intake (provenance; no PII onchain, ever).
 *  - submitResolution locks payout; reopen window must pass before money moves.
 *  - reopen() voids payout AND any attached rating, counted publicly.
 *  - Merchant rating requires a prior customer rating (CustomerRatingRequired).
 *  - Bayesian scores: (20 × 3.50 + Σ) / (20 + n), computed onchain.
 *  - Solo vs human-assisted tracked separately; assisted pays ASSISTED_BPS.
 */
contract ClerkLedgerV2 {
    // ------------------------------------------------------------------
    // Errors
    // ------------------------------------------------------------------
    error NotOperator();
    error NotPendingOperator();
    error NotPayoutWallet();
    error NotTicketMerchant();
    error MerchantNotRegistered();
    error AlreadyRegistered();
    error TicketAlreadyExists();
    error WrongStatus();
    error ReopenWindowClosed();
    error ReopenWindowStillOpen();
    error RatingWindowClosed();
    error InvalidRating();
    error AlreadyRated();
    error CustomerRatingRequired();
    error InvalidConfidence();
    error InsufficientEscrow();
    error NothingToClaim();
    error TransferFailed();
    error ZeroAddress();
    error Paused();
    error Reentrancy();

    // ------------------------------------------------------------------
    // Types
    // ------------------------------------------------------------------
    enum Status { None, Registered, Pending, Finalized, Reopened }

    struct Ticket {
        address merchant;
        uint64 registeredAt;
        uint64 resolvedAt;
        uint16 confidenceBps;
        bool resolvedByClerk;
        Status status;
        uint8 customerRating;
        uint8 merchantRating;
        uint256 lockedPayout;
    }

    struct MerchantAccount {
        bool registered;
        uint256 escrow;         // free (withdrawable) balance
        uint256 pricePerTicket; // wei (OKB) for a solo resolution
    }

    // ------------------------------------------------------------------
    // Constants
    // ------------------------------------------------------------------
    uint256 public constant PRIOR_CENTISTARS = 350;
    uint256 public constant BAYES_WEIGHT = 20;
    uint256 public constant ASSISTED_BPS = 4000;
    uint256 public constant RATING_WINDOW = 30 days;
    uint256 private constant BPS = 10000;

    // ------------------------------------------------------------------
    // Roles & config
    // ------------------------------------------------------------------
    address public operator;
    address public pendingOperator;
    address public payoutWallet;
    uint64 public immutable reopenWindow; // 72h recommended in production

    bool public paused;
    uint256 public claimablePayout;       // pull-payment accumulator

    // ------------------------------------------------------------------
    // Storage
    // ------------------------------------------------------------------
    mapping(bytes32 => Ticket) public tickets;
    mapping(address => MerchantAccount) public merchants;

    uint256 public custRatingCount;
    uint256 public custRatingSum;
    uint256 public merchRatingCount;
    uint256 public merchRatingSum;
    uint256 public soloResolved;
    uint256 public humanAssisted;
    uint256 public reopenedCount;
    uint256 public totalPaidOut;

    uint256 private _lock = 1;

    // ------------------------------------------------------------------
    // Events
    // ------------------------------------------------------------------
    event MerchantRegistered(address indexed merchant, uint256 pricePerTicket, uint256 deposit);
    event EscrowDeposited(address indexed merchant, uint256 amount);
    event EscrowWithdrawn(address indexed merchant, uint256 amount);
    event PriceUpdated(address indexed merchant, uint256 pricePerTicket);
    event TicketRegistered(bytes32 indexed ticketHash, address indexed merchant);
    event ResolutionSubmitted(bytes32 indexed ticketHash, uint16 confidenceBps, bool resolvedByClerk, uint256 lockedPayout, uint64 finalizableAt);
    event TicketReopened(bytes32 indexed ticketHash, address indexed by);
    event ResolutionFinalized(bytes32 indexed ticketHash, bool resolvedByClerk, uint256 payout);
    event CustomerRated(bytes32 indexed ticketHash, uint8 rating, bytes32 proofHash);
    event MerchantRated(bytes32 indexed ticketHash, uint8 rating);
    event PayoutClaimed(address indexed to, uint256 amount);
    event PausedSet(bool paused);
    event OperatorTransferStarted(address indexed current, address indexed pendingOp);
    event OperatorTransferred(address indexed previous, address indexed current);
    event PayoutWalletUpdated(address indexed previous, address indexed current);

    // ------------------------------------------------------------------
    // Modifiers
    // ------------------------------------------------------------------
    modifier onlyOperator() { if (msg.sender != operator) revert NotOperator(); _; }
    modifier whenNotPaused() { if (paused) revert Paused(); _; }
    modifier nonReentrant() { if (_lock != 1) revert Reentrancy(); _lock = 2; _; _lock = 1; }

    constructor(address _payoutWallet, uint64 _reopenWindow) {
        if (_payoutWallet == address(0)) revert ZeroAddress();
        operator = msg.sender;
        payoutWallet = _payoutWallet;
        reopenWindow = _reopenWindow;
    }

    // ------------------------------------------------------------------
    // Admin — circuit breaker & key rotation
    // ------------------------------------------------------------------
    function setPaused(bool p) external onlyOperator { paused = p; emit PausedSet(p); }

    function transferOperator(address next) external onlyOperator {
        if (next == address(0)) revert ZeroAddress();
        pendingOperator = next;
        emit OperatorTransferStarted(operator, next);
    }
    function acceptOperator() external {
        if (msg.sender != pendingOperator) revert NotPendingOperator();
        emit OperatorTransferred(operator, pendingOperator);
        operator = pendingOperator;
        pendingOperator = address(0);
    }
    function setPayoutWallet(address next) external onlyOperator {
        if (next == address(0)) revert ZeroAddress();
        emit PayoutWalletUpdated(payoutWallet, next);
        payoutWallet = next;
    }

    // ------------------------------------------------------------------
    // Merchant lifecycle
    // ------------------------------------------------------------------
    function registerMerchant(uint256 pricePerTicket) external payable whenNotPaused {
        MerchantAccount storage m = merchants[msg.sender];
        if (m.registered) revert AlreadyRegistered();
        m.registered = true;
        m.pricePerTicket = pricePerTicket;
        m.escrow = msg.value;
        emit MerchantRegistered(msg.sender, pricePerTicket, msg.value);
    }

    function depositEscrow() external payable whenNotPaused {
        MerchantAccount storage m = merchants[msg.sender];
        if (!m.registered) revert MerchantNotRegistered();
        m.escrow += msg.value;
        emit EscrowDeposited(msg.sender, msg.value);
    }

    /// ALWAYS available, paused or not — merchants can exit with their free
    /// escrow regardless of operator behavior. Locked funds stay locked until
    /// the pending resolutions they back are finalized or reopened.
    function withdrawEscrow(uint256 amount) external nonReentrant {
        MerchantAccount storage m = merchants[msg.sender];
        if (!m.registered) revert MerchantNotRegistered();
        if (amount > m.escrow) revert InsufficientEscrow();
        m.escrow -= amount;
        (bool ok, ) = msg.sender.call{value: amount}("");
        if (!ok) revert TransferFailed();
        emit EscrowWithdrawn(msg.sender, amount);
    }

    function setPrice(uint256 pricePerTicket) external {
        MerchantAccount storage m = merchants[msg.sender];
        if (!m.registered) revert MerchantNotRegistered();
        m.pricePerTicket = pricePerTicket;
        emit PriceUpdated(msg.sender, pricePerTicket);
    }

    // ------------------------------------------------------------------
    // Ticket lifecycle
    // ------------------------------------------------------------------
    function registerTicket(bytes32 ticketHash, address merchant) external onlyOperator whenNotPaused {
        if (tickets[ticketHash].status != Status.None) revert TicketAlreadyExists();
        if (!merchants[merchant].registered) revert MerchantNotRegistered();
        Ticket storage t = tickets[ticketHash];
        t.merchant = merchant;
        t.registeredAt = uint64(block.timestamp);
        t.status = Status.Registered;
        emit TicketRegistered(ticketHash, merchant);
    }

    function submitResolution(bytes32 ticketHash, uint16 confidenceBps, bool resolvedByClerk)
        external onlyOperator whenNotPaused
    {
        if (confidenceBps > BPS) revert InvalidConfidence();
        Ticket storage t = tickets[ticketHash];
        if (t.status != Status.Registered) revert WrongStatus();

        MerchantAccount storage m = merchants[t.merchant];
        uint256 payout = resolvedByClerk ? m.pricePerTicket : (m.pricePerTicket * ASSISTED_BPS) / BPS;
        if (payout > m.escrow) revert InsufficientEscrow();

        m.escrow -= payout;
        t.lockedPayout = payout;
        t.confidenceBps = confidenceBps;
        t.resolvedByClerk = resolvedByClerk;
        t.resolvedAt = uint64(block.timestamp);
        t.status = Status.Pending;

        emit ResolutionSubmitted(ticketHash, confidenceBps, resolvedByClerk, payout, uint64(block.timestamp) + reopenWindow);
    }

    /// ALWAYS available, paused or not — the merchant's protection against a
    /// false resolution claim can never be switched off by the operator.
    function reopen(bytes32 ticketHash) external {
        Ticket storage t = tickets[ticketHash];
        if (t.status != Status.Pending) revert WrongStatus();
        if (msg.sender != t.merchant && msg.sender != operator) revert NotTicketMerchant();
        if (block.timestamp > uint256(t.resolvedAt) + reopenWindow) revert ReopenWindowClosed();

        if (t.customerRating != 0) {
            custRatingCount -= 1;
            custRatingSum -= t.customerRating;
            t.customerRating = 0;
        }
        if (t.merchantRating != 0) {
            merchRatingCount -= 1;
            merchRatingSum -= t.merchantRating;
            t.merchantRating = 0;
        }

        merchants[t.merchant].escrow += t.lockedPayout;
        t.lockedPayout = 0;
        t.status = Status.Reopened;
        reopenedCount += 1;
        emit TicketReopened(ticketHash, msg.sender);
    }

    /// PULL PATTERN: credits claimablePayout instead of transferring. Money
    /// movement is a separate, isolated step (claimPayout). Blocked while
    /// paused — the circuit breaker stops outbound value, never merchant exits.
    function finalize(bytes32 ticketHash) public whenNotPaused {
        Ticket storage t = tickets[ticketHash];
        if (t.status != Status.Pending) revert WrongStatus();
        if (block.timestamp <= uint256(t.resolvedAt) + reopenWindow) revert ReopenWindowStillOpen();

        uint256 payout = t.lockedPayout;
        t.lockedPayout = 0;
        t.status = Status.Finalized;

        if (t.resolvedByClerk) soloResolved += 1;
        else humanAssisted += 1;
        totalPaidOut += payout;
        claimablePayout += payout;

        emit ResolutionFinalized(ticketHash, t.resolvedByClerk, payout);
    }

    /// Settlement sweep: skips tickets that aren't ready instead of reverting.
    function finalizeBatch(bytes32[] calldata hashes) external whenNotPaused {
        for (uint256 i = 0; i < hashes.length; i++) {
            Ticket storage t = tickets[hashes[i]];
            if (t.status != Status.Pending) continue;
            if (block.timestamp <= uint256(t.resolvedAt) + reopenWindow) continue;
            finalize(hashes[i]);
        }
    }

    function claimPayout() external nonReentrant {
        if (msg.sender != payoutWallet) revert NotPayoutWallet();
        uint256 amount = claimablePayout;
        if (amount == 0) revert NothingToClaim();
        claimablePayout = 0;
        (bool ok, ) = payoutWallet.call{value: amount}("");
        if (!ok) revert TransferFailed();
        emit PayoutClaimed(payoutWallet, amount);
    }

    // ------------------------------------------------------------------
    // Ratings — deadline-bounded, proof-committed, guardrail enforced
    // ------------------------------------------------------------------
    function rateAsCustomer(bytes32 ticketHash, uint8 rating, bytes32 proofHash)
        external onlyOperator whenNotPaused
    {
        if (rating < 1 || rating > 5) revert InvalidRating();
        Ticket storage t = tickets[ticketHash];
        if (t.status != Status.Pending && t.status != Status.Finalized) revert WrongStatus();
        if (block.timestamp > uint256(t.resolvedAt) + RATING_WINDOW) revert RatingWindowClosed();
        if (t.customerRating != 0) revert AlreadyRated();
        t.customerRating = rating;
        custRatingCount += 1;
        custRatingSum += rating;
        emit CustomerRated(ticketHash, rating, proofHash);
    }

    function rateAsMerchant(bytes32 ticketHash, uint8 rating) external whenNotPaused {
        if (rating < 1 || rating > 5) revert InvalidRating();
        Ticket storage t = tickets[ticketHash];
        if (msg.sender != t.merchant) revert NotTicketMerchant();
        if (t.status != Status.Pending && t.status != Status.Finalized) revert WrongStatus();
        if (block.timestamp > uint256(t.resolvedAt) + RATING_WINDOW) revert RatingWindowClosed();
        if (t.customerRating == 0) revert CustomerRatingRequired();
        if (t.merchantRating != 0) revert AlreadyRated();
        t.merchantRating = rating;
        merchRatingCount += 1;
        merchRatingSum += rating;
        emit MerchantRated(ticketHash, rating);
    }

    // ------------------------------------------------------------------
    // Views
    // ------------------------------------------------------------------
    function _bayes(uint256 count, uint256 sum) private pure returns (uint256) {
        return (BAYES_WEIGHT * PRIOR_CENTISTARS + sum * 100) / (BAYES_WEIGHT + count);
    }
    function customerScore() external view returns (uint256 centistars, uint256 ratings) {
        return (_bayes(custRatingCount, custRatingSum), custRatingCount);
    }
    function merchantScore() external view returns (uint256 centistars, uint256 ratings) {
        return (_bayes(merchRatingCount, merchRatingSum), merchRatingCount);
    }
    function soloRateBps() external view returns (uint256) {
        uint256 total = soloResolved + humanAssisted;
        if (total == 0) return 0;
        return (soloResolved * BPS) / total;
    }
    function trackRecord() external view returns (
        uint256 solo, uint256 assisted, uint256 reopened, uint256 paidOut,
        uint256 custScoreCenti, uint256 custRatings, uint256 merchScoreCenti, uint256 merchRatings
    ) {
        return (soloResolved, humanAssisted, reopenedCount, totalPaidOut,
            _bayes(custRatingCount, custRatingSum), custRatingCount,
            _bayes(merchRatingCount, merchRatingSum), merchRatingCount);
    }
    function getTicket(bytes32 ticketHash) external view returns (Ticket memory) {
        return tickets[ticketHash];
    }
}
