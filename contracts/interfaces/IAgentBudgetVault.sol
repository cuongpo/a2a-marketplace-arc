// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IMissionEscrow} from "./IMissionEscrow.sol";

/// @title IAgentBudgetVault
/// @notice Multi-tenant USDC budget vault. An operator deposits USDC once, authorises ONE buyer-agent
///         executor under hard caps, and the executor can only move funds into allowlisted escrows.
interface IAgentBudgetVault {
    struct Policy {
        address executor;
        uint128 perMissionCap; // max providerPrice + verifierFee for a single mission
        uint128 totalCap; // max NET committed spend (commitments minus reconciled refunds)
        uint128 dailyCap; // max gross commitments per UTC day (block.timestamp / 1 days)
        uint64 expiry; // executor authority ends at this unix time
        bool paused;
    }

    event Deposited(address indexed operator, uint256 amount);
    event WithdrawnByOperator(address indexed operator, address indexed to, uint256 amount);
    event PolicySet(
        address indexed operator,
        address indexed executor,
        uint128 perMissionCap,
        uint128 totalCap,
        uint128 dailyCap,
        uint64 expiry
    );
    event EscrowAllowed(address indexed operator, address indexed escrow, bool allowed);
    event Paused(address indexed operator, bool paused);
    event ExecutorRevoked(address indexed operator, address indexed executor);
    event MissionCommitted(
        address indexed operator, address indexed escrow, uint256 indexed missionId, address executor, uint256 amount
    );
    event MissionReconciled(
        address indexed operator, address indexed escrow, uint256 indexed missionId, uint256 committed, uint256 refunded
    );

    error NotOperatorPolicy();
    error NotExecutor();
    error PolicyPaused();
    error PolicyExpired();
    error EscrowNotAllowed();
    error PerMissionCapExceeded();
    error TotalCapExceeded();
    error DailyCapExceeded();
    error InsufficientAvailable();
    error ZeroAmount();
    error MissionNotTerminal();
    error AlreadyReconciled();
    error UnknownMission();
    error NotMissionOperator();
    error RefundTargetMismatch();
    error EscrowNotTrusted();
    error FundingMismatch();
    error RefundExceedsCommitment();

    function deposit(uint256 amount) external; // operator funds own budget (needs prior USDC approve)
    function withdrawAvailable(uint256 amount, address to) external; // operator reclaims UNCOMMITTED funds only
    function setPolicy(
        address executor,
        uint128 perMissionCap,
        uint128 totalCap,
        uint128 dailyCap,
        uint64 expiry
    ) external;
    function setEscrowAllowed(address escrow, bool allowed) external;
    function setPaused(bool paused) external; // operator
    function revokeExecutor() external; // operator

    /// @notice Executor-only. Vault forces p.refundTo = address(this), approves the exact amount and
    ///         calls escrow.createMission. Reverts if any policy limit would be exceeded.
    function createMissionFor(address operator, address escrow, IMissionEscrow.MissionParams calldata p)
        external
        returns (uint256 missionId);

    /// @notice Anyone. After the mission is terminal (Settled/Expired), claims the refund (if any) from
    ///         the escrow into this vault and credits the operator's available balance. Once per mission.
    function reconcile(address escrow, uint256 missionId) external;

    /// @notice Operator proxies buyer-only escrow actions.
    function challengeMission(address escrow, uint256 missionId) external;
    function cancelUnassignedMission(address escrow, uint256 missionId) external;

    function policyOf(address operator) external view returns (Policy memory);
    function availableOf(address operator) external view returns (uint256);
    function committedOf(address operator) external view returns (uint256);
    function netSpentOf(address operator) external view returns (uint256);
    function dailySpentOf(address operator, uint256 day) external view returns (uint256);
    function escrowAllowed(address operator, address escrow) external view returns (bool);
    /// @dev Escrows fixed at vault construction. An operator can only allowlist escrows from this set,
    ///      because the pooled vault trusts escrow getters when reconciling refunds.
    function isTrustedEscrow(address escrow) external view returns (bool);
    function missionOperator(address escrow, uint256 missionId) external view returns (address);
    function missionCommitted(address escrow, uint256 missionId) external view returns (uint256);
    function totalHeld() external view returns (uint256); // sum of all operators' available + committed
    function usdc() external view returns (address);
}
