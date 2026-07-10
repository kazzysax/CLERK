// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * ClerkReputation — onchain accuracy ledger with NO payment / NO escrow / NO OKB fees.
 *
 * What still lives onchain (auditable, permanent):
 *  - Ticket hash at intake (provenance; no PII)
 *  - Resolution: confidence, solo vs human-assisted, timestamps
 *  - Reopen (voids ratings, counted publicly)
 *  - Customer + merchant star ratings (Bayesian scores)
 *  - Public track record (solo / assisted / reopened / rating math)
 *
 * What is gone vs ClerkLedgerV2:
 *  - No escrow deposits or withdrawals
 *  - No price-per-ticket
 *  - No locked payouts, claimable balances, or claimPayout
 *  - Merchants register for free (gas only)
 *
 * Merchants may still need tiny amounts of native OKB for *wallet gas* on X Layer;
 * that is network gas, not a fee paid to Clerk.
 */
contract ClerkReputation {
    error NotOperator();
    error NotPendingOperator();
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
    error ZeroAddress();
    error Paused();

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
    }

    struct MerchantAccount {
        bool registered;
        uint64 registeredAt;
    }

    uint256 public constant PRIOR_CENTISTARS = 350;
    uint256 public constant BAYES_WEIGHT = 20;
    uint256 public constant RATING_WINDOW = 30 days;
    uint256 private constant BPS = 10000;

    address public operator;
    address public pendingOperator;
    uint64 public immutable reopenWindow;

    bool public paused;

    mapping(bytes32 => Ticket) public tickets;
    mapping(address => MerchantAccount) public merchants;

    uint256 public custRatingCount;
    uint256 public custRatingSum;
    uint256 public merchRatingCount;
    uint256 public merchRatingSum;
    uint256 public soloResolved;
    uint256 public humanAssisted;
    uint256 public reopenedCount;
    uint256 public totalFinalized; // count of finalized resolutions (not a payment amount)

    event MerchantRegistered(address indexed merchant, uint64 registeredAt);
    event TicketRegistered(bytes32 indexed ticketHash, address indexed merchant);
    event ResolutionSubmitted(
        bytes32 indexed ticketHash,
        uint16 confidenceBps,
        bool resolvedByClerk,
        uint64 finalizableAt
    );
    event TicketReopened(bytes32 indexed ticketHash, address indexed by);
    event ResolutionFinalized(bytes32 indexed ticketHash, bool resolvedByClerk);
    event CustomerRated(bytes32 indexed ticketHash, uint8 rating, bytes32 proofHash);
    event MerchantRated(bytes32 indexed ticketHash, uint8 rating);
    event PausedSet(bool paused);
    event OperatorTransferStarted(address indexed current, address indexed pendingOp);
    event OperatorTransferred(address indexed previous, address indexed current);

    modifier onlyOperator() {
        if (msg.sender != operator) revert NotOperator();
        _;
    }
    modifier whenNotPaused() {
        if (paused) revert Paused();
        _;
    }

    constructor(uint64 _reopenWindow) {
        operator = msg.sender;
        reopenWindow = _reopenWindow;
    }

    function setPaused(bool p) external onlyOperator {
        paused = p;
        emit PausedSet(p);
    }

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

    /// Free registration — no OKB deposit.
    function registerMerchant() external whenNotPaused {
        MerchantAccount storage m = merchants[msg.sender];
        if (m.registered) revert AlreadyRegistered();
        m.registered = true;
        m.registeredAt = uint64(block.timestamp);
        emit MerchantRegistered(msg.sender, m.registeredAt);
    }

    function registerTicket(bytes32 ticketHash, address merchant) external onlyOperator whenNotPaused {
        if (tickets[ticketHash].status != Status.None) revert TicketAlreadyExists();
        if (!merchants[merchant].registered) revert MerchantNotRegistered();
        Ticket storage t = tickets[ticketHash];
        t.merchant = merchant;
        t.registeredAt = uint64(block.timestamp);
        t.status = Status.Registered;
        emit TicketRegistered(ticketHash, merchant);
    }

    /// Records a resolution claim. No funds move.
    function submitResolution(bytes32 ticketHash, uint16 confidenceBps, bool resolvedByClerk)
        external
        onlyOperator
        whenNotPaused
    {
        if (confidenceBps > BPS) revert InvalidConfidence();
        Ticket storage t = tickets[ticketHash];
        if (t.status != Status.Registered) revert WrongStatus();

        t.confidenceBps = confidenceBps;
        t.resolvedByClerk = resolvedByClerk;
        t.resolvedAt = uint64(block.timestamp);
        t.status = Status.Pending;

        emit ResolutionSubmitted(
            ticketHash, confidenceBps, resolvedByClerk, uint64(block.timestamp) + reopenWindow
        );
    }

    /// ALWAYS available while paused — merchant protection against bad claims.
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

        t.status = Status.Reopened;
        reopenedCount += 1;
        emit TicketReopened(ticketHash, msg.sender);
    }

    function finalize(bytes32 ticketHash) public whenNotPaused {
        Ticket storage t = tickets[ticketHash];
        if (t.status != Status.Pending) revert WrongStatus();
        if (block.timestamp <= uint256(t.resolvedAt) + reopenWindow) revert ReopenWindowStillOpen();

        t.status = Status.Finalized;
        if (t.resolvedByClerk) soloResolved += 1;
        else humanAssisted += 1;
        totalFinalized += 1;

        emit ResolutionFinalized(ticketHash, t.resolvedByClerk);
    }

    function finalizeBatch(bytes32[] calldata hashes) external whenNotPaused {
        for (uint256 i = 0; i < hashes.length; i++) {
            Ticket storage t = tickets[hashes[i]];
            if (t.status != Status.Pending) continue;
            if (block.timestamp <= uint256(t.resolvedAt) + reopenWindow) continue;
            finalize(hashes[i]);
        }
    }

    function rateAsCustomer(bytes32 ticketHash, uint8 rating, bytes32 proofHash)
        external
        onlyOperator
        whenNotPaused
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

    /// Compatible shape with older UIs: 4th value is finalized *count* (not OKB paid).
    function trackRecord()
        external
        view
        returns (
            uint256 solo,
            uint256 assisted,
            uint256 reopened,
            uint256 finalized,
            uint256 custScoreCenti,
            uint256 custRatings,
            uint256 merchScoreCenti,
            uint256 merchRatings
        )
    {
        return (
            soloResolved,
            humanAssisted,
            reopenedCount,
            totalFinalized,
            _bayes(custRatingCount, custRatingSum),
            custRatingCount,
            _bayes(merchRatingCount, merchRatingSum),
            merchRatingCount
        );
    }

    function getTicket(bytes32 ticketHash) external view returns (Ticket memory) {
        return tickets[ticketHash];
    }
}
