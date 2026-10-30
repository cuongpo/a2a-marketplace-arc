// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {IAgentBudgetVault} from "./interfaces/IAgentBudgetVault.sol";
import {IMissionEscrow} from "./interfaces/IMissionEscrow.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/// @title AgentBudgetVault
/// @notice Multi-tenant USDC budgets with operator-controlled, capped executors.
/// @dev There is no owner, administrator, upgrade mechanism, or arbitrary-call facility.
/// Escrows trusted at construction must implement IMissionEscrow faithfully,
/// including immutable refund accounting and permissionless refunds paid only to refundTo.
/// Operators may allowlist only escrows from that fixed trusted set.
/// The immutable USDC must be a non-rebasing, non-fee-on-transfer ERC-20. Executors may
/// commit only their operator's capped funds to that operator's allowlisted escrows;
/// executor authority never grants withdrawal, policy-management, or buyer-proxy rights.
/// An executor address may separately act as an operator of its own independent budget.
///
/// Accounting invariant: usdc.balanceOf(address(this)) >= sum(availableOf(operator)).
/// totalHeld() is the running sum of available plus unreconciled committed amounts,
/// including funds held in escrow, not merely this contract's token balance. That sum
/// equals credited deposits minus operator withdrawals minus payouts recognized on
/// reconciliation (commitment minus refund). Escrow payouts remain in committed until
/// reconciliation. Unsolicited transfers and refunds awaiting reconciliation are surplus
/// tokens, not new available credit. These invariants assume faithful USDC and escrows.
contract AgentBudgetVault is IAgentBudgetVault, ReentrancyGuard {
    using SafeERC20 for IERC20;

    address public immutable override usdc;
    mapping(address escrow => bool trusted) private trustedEscrow;

    mapping(address operator => uint256 amount) private _available;
    mapping(address operator => uint256 amount) private _committed;
    mapping(address operator => uint256 amount) private _netSpent;
    mapping(address operator => mapping(uint256 day => uint256 amount)) private _dailySpent;
    mapping(address operator => Policy) private _policy;
    mapping(address operator => mapping(address escrow => bool allowed)) public override escrowAllowed;
    mapping(address escrow => mapping(uint256 missionId => address operator)) public override missionOperator;
    mapping(address escrow => mapping(uint256 missionId => uint256 amount)) public override missionCommitted;

    uint256 private _totalHeld;

    /// @param usdc_ The nonzero USDC ERC-20 address used by all allowlisted escrows.
    /// @param trustedEscrows_ The fixed set of one to eight trusted escrow contracts.
    constructor(address usdc_, address[] memory trustedEscrows_) {
        if (usdc_ == address(0)) revert NotOperatorPolicy();
        usdc = usdc_;
        if (trustedEscrows_.length == 0 || trustedEscrows_.length > 8) revert EscrowNotTrusted();
        for (uint256 i = 0; i < trustedEscrows_.length; ++i) {
            address escrow = trustedEscrows_[i];
            if (escrow == address(0) || escrow.code.length == 0 || trustedEscrow[escrow]) {
                revert EscrowNotTrusted();
            }
            if (IMissionEscrow(escrow).usdc() != usdc_) revert EscrowNotTrusted();
            trustedEscrow[escrow] = true;
        }
    }

    /// @inheritdoc IAgentBudgetVault
    function isTrustedEscrow(address escrow) public view override returns (bool) {
        return trustedEscrow[escrow];
    }

    /// @inheritdoc IAgentBudgetVault
    function deposit(uint256 amount) external override nonReentrant {
        if (amount == 0) revert ZeroAmount();
        IERC20 token = IERC20(usdc);
        uint256 beforeBalance = token.balanceOf(address(this));
        token.safeTransferFrom(msg.sender, address(this), amount);
        _requireReceived(token, beforeBalance, amount);

        _available[msg.sender] += amount;
        _totalHeld += amount;
        emit Deposited(msg.sender, amount);
    }

    /// @inheritdoc IAgentBudgetVault
    /// @dev No policy, pause, expiry, or executor check can block an operator's withdrawal.
    function withdrawAvailable(uint256 amount, address to) external override nonReentrant {
        if (to == address(0)) revert NotOperatorPolicy();
        if (amount == 0) revert ZeroAmount();
        if (amount > _available[msg.sender]) revert InsufficientAvailable();

        _available[msg.sender] -= amount;
        _totalHeld -= amount;
        IERC20(usdc).safeTransfer(to, amount);
        emit WithdrawnByOperator(msg.sender, to, amount);
    }

    /// @inheritdoc IAgentBudgetVault
    /// @dev Replacing caps or the executor preserves pause state and all spend counters.
    /// Invalid executor/cap configuration uses the interface's NotOperatorPolicy error.
    function setPolicy(
        address executor,
        uint128 perMissionCap,
        uint128 totalCap,
        uint128 dailyCap,
        uint64 expiry
    ) external override nonReentrant {
        if (executor == address(0) || perMissionCap == 0 || perMissionCap > totalCap) {
            revert NotOperatorPolicy();
        }
        if (expiry <= block.timestamp) revert PolicyExpired();

        Policy storage policy = _policy[msg.sender];
        policy.executor = executor;
        policy.perMissionCap = perMissionCap;
        policy.totalCap = totalCap;
        policy.dailyCap = dailyCap;
        policy.expiry = expiry;
        emit PolicySet(msg.sender, executor, perMissionCap, totalCap, dailyCap, expiry);
    }

    /// @inheritdoc IAgentBudgetVault
    function setEscrowAllowed(address escrow, bool allowed) external override nonReentrant {
        if (allowed && !isTrustedEscrow(escrow)) revert EscrowNotTrusted();
        escrowAllowed[msg.sender][escrow] = allowed;
        emit EscrowAllowed(msg.sender, escrow, allowed);
    }

    /// @inheritdoc IAgentBudgetVault
    function setPaused(bool paused) external override nonReentrant {
        _policy[msg.sender].paused = paused;
        emit Paused(msg.sender, paused);
    }

    /// @inheritdoc IAgentBudgetVault
    function revokeExecutor() external override nonReentrant {
        address executor = _policy[msg.sender].executor;
        _policy[msg.sender].executor = address(0);
        emit ExecutorRevoked(msg.sender, executor);
    }

    /// @inheritdoc IAgentBudgetVault
    function createMissionFor(address operator, address escrow, IMissionEscrow.MissionParams calldata p)
        external
        override
        nonReentrant
        returns (uint256 missionId)
    {
        Policy memory policy = _policy[operator];
        if (policy.executor == address(0) || msg.sender != policy.executor) revert NotExecutor();
        if (policy.paused) revert PolicyPaused();
        if (block.timestamp > policy.expiry) revert PolicyExpired();
        if (!escrowAllowed[operator][escrow]) revert EscrowNotAllowed();
        if (!isTrustedEscrow(escrow)) revert EscrowNotTrusted();

        uint256 total = uint256(p.providerPrice) + uint256(p.verifierFee);
        uint256 day = block.timestamp / 1 days;
        if (total == 0) revert ZeroAmount();
        if (total > uint256(policy.perMissionCap)) revert PerMissionCapExceeded();
        if (_netSpent[operator] + total > uint256(policy.totalCap)) revert TotalCapExceeded();
        if (_dailySpent[operator][day] + total > uint256(policy.dailyCap)) revert DailyCapExceeded();
        if (total > _available[operator]) revert InsufficientAvailable();

        _available[operator] -= total;
        _committed[operator] += total;
        _netSpent[operator] += total;
        _dailySpent[operator][day] += total;
        // Moving available into committed does not change _totalHeld.

        IMissionEscrow.MissionParams memory params = p;
        params.refundTo = address(this);
        IERC20 token = IERC20(usdc);
        token.forceApprove(escrow, total);
        uint256 beforeBalance = token.balanceOf(address(this));
        missionId = IMissionEscrow(escrow).createMission(params);
        uint256 afterBalance = token.balanceOf(address(this));
        if (afterBalance > beforeBalance || beforeBalance - afterBalance != total) revert FundingMismatch();
        token.forceApprove(escrow, 0);

        // Keep the operator association forever, including after reconciliation,
        // so an escrow cannot reuse a previously reconciled ID for another credit.
        if (missionId == 0 || missionOperator[escrow][missionId] != address(0)) revert UnknownMission();
        missionOperator[escrow][missionId] = operator;
        missionCommitted[escrow][missionId] = total;

        IMissionEscrow.Mission memory mission = IMissionEscrow(escrow).getMission(missionId);
        if (
            mission.buyer != address(this) || mission.refundTo != address(this)
                || mission.providerPrice != p.providerPrice || mission.verifierFee != p.verifierFee
        ) revert RefundTargetMismatch();

        emit MissionCommitted(operator, escrow, missionId, msg.sender, total);
    }

    /// @inheritdoc IAgentBudgetVault
    function reconcile(address escrow, uint256 missionId) external override nonReentrant {
        address operator = missionOperator[escrow][missionId];
        if (operator == address(0)) revert UnknownMission();
        uint256 committedAmount = missionCommitted[escrow][missionId];
        if (committedAmount == 0) revert AlreadyReconciled();

        IMissionEscrow missionEscrow = IMissionEscrow(escrow);
        IMissionEscrow.Mission memory mission = missionEscrow.getMission(missionId);
        if (mission.status != IMissionEscrow.Status.Settled && mission.status != IMissionEscrow.Status.Expired) {
            revert MissionNotTerminal();
        }
        if (mission.refundTo != address(this)) revert RefundTargetMismatch();

        uint256 refund = missionEscrow.refundAmount(missionId);
        if (refund > committedAmount) revert RefundExceedsCommitment();
        if (refund > 0 && !missionEscrow.refundClaimed(missionId)) {
            IERC20 token = IERC20(usdc);
            uint256 beforeBalance = token.balanceOf(address(this));
            missionEscrow.claimRefund(missionId);
            _requireReceived(token, beforeBalance, refund);
        }
        // Permissionless claims always pay this vault. A prior third-party claim
        // therefore needs accounting credit, not a second token transfer.
        // All mutating entry points share the guard; the zero marker is permanent.
        missionCommitted[escrow][missionId] = 0;
        _committed[operator] -= committedAmount;
        _available[operator] += refund;
        uint256 spent = _netSpent[operator];
        _netSpent[operator] = spent - (refund < spent ? refund : spent);
        _totalHeld = _totalHeld - committedAmount + refund;

        emit MissionReconciled(operator, escrow, missionId, committedAmount, refund);
    }

    /// @inheritdoc IAgentBudgetVault
    function challengeMission(address escrow, uint256 missionId) external override nonReentrant {
        if (missionOperator[escrow][missionId] != msg.sender) revert NotMissionOperator();
        IMissionEscrow(escrow).challenge(missionId);
    }

    /// @inheritdoc IAgentBudgetVault
    function cancelUnassignedMission(address escrow, uint256 missionId) external override nonReentrant {
        if (missionOperator[escrow][missionId] != msg.sender) revert NotMissionOperator();
        IMissionEscrow(escrow).cancelUnassigned(missionId);
    }

    /// @inheritdoc IAgentBudgetVault
    function policyOf(address operator) external view override returns (Policy memory) {
        return _policy[operator];
    }

    /// @inheritdoc IAgentBudgetVault
    function availableOf(address operator) external view override returns (uint256) {
        return _available[operator];
    }

    /// @inheritdoc IAgentBudgetVault
    function committedOf(address operator) external view override returns (uint256) {
        return _committed[operator];
    }

    /// @inheritdoc IAgentBudgetVault
    function netSpentOf(address operator) external view override returns (uint256) {
        return _netSpent[operator];
    }

    /// @inheritdoc IAgentBudgetVault
    function dailySpentOf(address operator, uint256 day) external view override returns (uint256) {
        return _dailySpent[operator][day];
    }

    /// @inheritdoc IAgentBudgetVault
    function totalHeld() external view override returns (uint256) {
        return _totalHeld;
    }

    /// @dev Reject unexpected token behavior without introducing errors outside the interface/OZ ABI.
    function _requireReceived(IERC20 token, uint256 beforeBalance, uint256 amount) private view {
        uint256 afterBalance = token.balanceOf(address(this));
        if (afterBalance < beforeBalance || afterBalance - beforeBalance != amount) {
            revert SafeERC20.SafeERC20FailedOperation(address(token));
        }
    }
}
