// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IEvidenceRegistry} from "./IEvidenceRegistry.sol";

/// @title IMissionEscrow
/// @notice USDC escrow for verified field-observation missions.
/// @dev All amounts are USDC ERC-20 base units (6 decimals) at 0x3600000000000000000000000000000000000000.
///      Never uses msg.value / the 18-decimal native view.
interface IMissionEscrow {
    // Created + Funded are atomic: createMission pulls USDC in the same transaction, so a mission
    // is born in `Funded`. Accepted/Rejected mean "verdict recorded, challenge window open".
    // Settled means payouts/refunds were credited. Expired means deadline missed or cancelled, refund credited.
    enum Status {
        None,
        Funded,
        Assigned,
        Submitted,
        Accepted,
        Rejected,
        Challenged,
        Expired,
        Settled
    }
    enum Outcome {
        None,
        ProviderPaid, // provider credited providerPrice
        BuyerRefunded, // buyer owed providerPrice back
        Split, // reserved, never produced (arbiter timeout lets the signed verdict stand, see MissionEscrow)
        Expired // nothing delivered: buyer owed everything back
    }
    enum Decision {
        None,
        Accept,
        Reject,
        Escalate
    }

    struct MissionParams {
        bytes32 objectiveHash; // keccak256 of canonical mission spec JSON
        bytes32 tileId;
        bytes32 unit;
        bytes32 quoteHash; // hash of the provider's signed quote the buyer chose (provenance only)
        address provider;
        address verifier;
        address refundTo; // who may receive the refund (the vault sets itself)
        uint128 providerPrice;
        uint128 verifierFee;
        uint64 deadline; // evidence must be submitted by this time
        uint32 maxReadingAge; // seconds
        uint32 challengeWindow; // seconds, 0..MAX_CHALLENGE_WINDOW
    }

    struct Mission {
        address buyer; // msg.sender of createMission; pays and may challenge acceptance
        address refundTo;
        address provider;
        address verifier;
        uint128 providerPrice;
        uint128 verifierFee;
        uint64 createdAt;
        uint64 deadline;
        uint64 assignedAt;
        uint64 submittedAt;
        uint64 verdictAt;
        uint64 challengeEndsAt;
        uint64 challengedAt;
        uint32 maxReadingAge;
        uint32 challengeWindow;
        Status status;
        Outcome outcome;
        Decision decision;
        bytes32 objectiveHash;
        bytes32 tileId;
        bytes32 unit;
        bytes32 quoteHash;
        bytes32 evidenceHash;
        bytes32 readingCommitment;
        bytes32 verdictReasonHash;
    }

    /// @dev EIP-712: Verdict(uint256 missionId,bytes32 evidenceHash,uint8 decision,bytes32 reasonHash,uint64 expiry,uint256 nonce)
    struct Verdict {
        uint256 missionId;
        bytes32 evidenceHash;
        uint8 decision; // 1 accept, 2 reject, 3 escalate to human arbiter
        bytes32 reasonHash;
        uint64 expiry;
        uint256 nonce;
    }

    event MissionCreated(
        uint256 indexed id,
        address indexed buyer,
        address indexed provider,
        address verifier,
        address refundTo,
        bytes32 tileId,
        bytes32 objectiveHash,
        bytes32 quoteHash,
        uint128 providerPrice,
        uint128 verifierFee,
        uint64 deadline
    );
    event MissionAssigned(uint256 indexed id, address indexed provider);
    event EvidenceSubmitted(
        uint256 indexed id,
        address indexed provider,
        bytes32 evidenceHash,
        bytes32 readingCommitment,
        address sensorSigner,
        uint64 observedAt,
        int256 value,
        bytes32 unit,
        uint256 nonce,
        bytes32 payloadHash
    );
    event VerdictRecorded(
        uint256 indexed id,
        address indexed verifier,
        uint8 decision,
        bytes32 evidenceHash,
        bytes32 reasonHash,
        uint256 nonce,
        uint64 challengeEndsAt
    );
    event MissionChallenged(uint256 indexed id, address indexed challenger);
    /// @dev reason: 1 = verifier escalated, 2 = verifier timeout
    event MissionEscalated(uint256 indexed id, uint8 reason);
    event ArbiterResolved(uint256 indexed id, address indexed arbiter, bool providerWins);
    event MissionSettled(
        uint256 indexed id, Outcome outcome, uint256 providerCredit, uint256 verifierCredit, uint256 buyerRefund
    );
    event MissionExpired(uint256 indexed id, uint256 refund);
    event CreditAdded(address indexed account, uint256 indexed id, uint256 amount);
    event Withdrawn(address indexed account, address indexed to, uint256 amount);
    event RefundClaimed(uint256 indexed id, address indexed refundTo, uint256 amount);
    event RefundRedirected(uint256 indexed id, address indexed newRefundTo);

    // ---- lifecycle ----
    function createMission(MissionParams calldata p) external returns (uint256 id);
    function cancelUnassigned(uint256 id) external; // buyer only, Funded -> Expired, full refund
    function acceptAssignment(uint256 id) external; // provider only, Funded -> Assigned
    function submitEvidence(
        uint256 id,
        bytes32 evidenceHash,
        IEvidenceRegistry.Reading calldata reading,
        bytes calldata sensorSig
    ) external; // provider only, Assigned -> Submitted
    function submitVerdict(Verdict calldata v, bytes calldata verifierSig) external; // anyone relays
    function challenge(uint256 id) external; // buyer (vs Accepted) or provider (vs Rejected), within window
    function escalateStale(uint256 id) external; // anyone, Submitted + VERIFIER_TIMEOUT -> Challenged
    function finalize(uint256 id) external; // anyone, Accepted/Rejected after challengeEndsAt -> Settled
    function resolve(uint256 id, bool providerWins) external; // arbiter only, Challenged -> Settled
    function resolveByTimeout(uint256 id) external; // anyone, Challenged + ARBITER_TIMEOUT -> Settled (signed verdict stands; no verdict => full buyer refund)
    function expire(uint256 id) external; // anyone, Funded/Assigned past deadline -> Expired

    // ---- money out ----
    function withdraw(address to) external returns (uint256 amount); // pays msg.sender's credits to `to`
    function claimRefund(uint256 id) external returns (uint256 amount); // anyone; pays refundTo only
    function redirectRefund(uint256 id, address newRefundTo) external; // buyer only, before claim

    // ---- views ----
    function getMission(uint256 id) external view returns (Mission memory);
    function missionCount() external view returns (uint256);
    function credits(address account) external view returns (uint256);
    function refundAmount(uint256 id) external view returns (uint256); // total refund fixed at settlement
    function refundClaimed(uint256 id) external view returns (bool);
    function totalLiabilities() external view returns (uint256); // USDC the escrow owes (escrowed + credits + unclaimed refunds)
    function hashVerdict(Verdict calldata v) external view returns (bytes32);
    function verdictNonceUsed(address verifier, uint256 nonce) external view returns (bool);
    function arbiter() external view returns (address);
    function usdc() external view returns (address);
    function registry() external view returns (address);

    function MAX_CHALLENGE_WINDOW() external view returns (uint32);
    function VERIFIER_TIMEOUT() external view returns (uint32);
    function ARBITER_TIMEOUT() external view returns (uint32);
}
