// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {IIdentityRegistry8004, IReputationRegistry8004} from "./interfaces/IERC8004.sol";
import {IMissionEscrow} from "./interfaces/IMissionEscrow.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/// @title Erc8004Adapter — OPTIONAL / ISOLATED reputation integration
/// @notice Reputation is a social signal, NOT proof that a physical observation is true.
/// @dev Feedback comes from this adapter contract address as the client, not the caller.
///      The escrow must never call this adapter. This adapter only reads the escrow;
///      registry availability cannot gate escrow settlement, refunds, or withdrawals.
///      There is no owner, administrator, or upgrade mechanism.
contract Erc8004Adapter is ReentrancyGuard {
    enum Role {
        Provider,
        Verifier
    }

    error ZeroAddress();
    error BindFailed();
    error MissionNotFinal();
    error NothingToRecord();

    address public immutable identity;
    address public immutable reputation;
    address public immutable escrow;

    mapping(address => uint256) public agentOf;
    // Separate presence bit permits binding agent ID zero.
    mapping(address => bool) private _bound;
    mapping(uint256 => bool) public providerRecorded;
    mapping(uint256 => bool) public verifierRecorded;

    event AgentBound(address indexed account, uint256 indexed agentId);
    event FeedbackRecorded(uint256 indexed missionId, uint256 indexed agentId, Role indexed role, int128 value);
    event FeedbackFailed(uint256 indexed missionId, uint256 indexed agentId, Role indexed role);

    constructor(address identity_, address reputation_, address escrow_) {
        if (identity_ == address(0) || reputation_ == address(0) || escrow_ == address(0)) {
            revert ZeroAddress();
        }
        identity = identity_;
        reputation = reputation_;
        escrow = escrow_;
    }

    /// @notice Bind or replace only your own binding, after checking current identity ownership.
    /// @dev All identity-read failures, including malformed return data, become BindFailed.
    function bindAgent(uint256 agentId) external {
        try this.readIdentityOwner(agentId) returns (address agentOwner) {
            if (agentOwner != msg.sender) revert BindFailed();
        } catch {
            revert BindFailed();
        }
        agentOf[msg.sender] = agentId;
        _bound[msg.sender] = true;
        emit AgentBound(msg.sender, agentId);
    }

    /// @dev Self-only read boundary: decoding errors inside this call are caught by bindAgent.
    function readIdentityOwner(uint256 agentId) external view returns (address) {
        if (msg.sender != address(this)) revert BindFailed();
        return IIdentityRegistry8004(identity).ownerOf(agentId);
    }

    /// @notice Return the binding, distinguishing an unbound account from agent ID zero.
    function identityOf(address account) external view returns (uint256 agentId, bool bound) {
        return (agentOf[account], _bound[account]);
    }

    /// @notice Permissionlessly attempt feedback for a final mission; failed roles remain retryable.
    /// @dev A bound verifier without a verdict is skipped, not treated as an unbound role.
    ///      Successful roles remain recorded even if their account later rebinds.
    function recordOutcome(uint256 missionId) external nonReentrant {
        IMissionEscrow.Mission memory mission = IMissionEscrow(escrow).getMission(missionId);
        if (mission.status != IMissionEscrow.Status.Settled && mission.status != IMissionEscrow.Status.Expired) {
            revert MissionNotFinal();
        }

        bool providerBound = _bound[mission.provider];
        bool verifierBound = _bound[mission.verifier];
        if (!providerBound && !verifierBound) revert NothingToRecord();

        if (providerBound && !providerRecorded[missionId]) {
            _recordFeedback(
                missionId,
                agentOf[mission.provider],
                Role.Provider,
                mission.outcome == IMissionEscrow.Outcome.ProviderPaid ? int128(100) : int128(0),
                _deliveryTag(mission.outcome),
                mission.evidenceHash
            );
        }
        if (verifierBound && !verifierRecorded[missionId] && mission.decision != IMissionEscrow.Decision.None) {
            _recordFeedback(
                missionId,
                agentOf[mission.verifier],
                Role.Verifier,
                100,
                "verdict-delivered",
                mission.evidenceHash
            );
        }
    }

    function _recordFeedback(
        uint256 missionId,
        uint256 agentId,
        Role role,
        int128 value,
        string memory tag2,
        bytes32 evidenceHash
    ) private {
        // Solidity's no-code check can revert outside a typed call's catch clause.
        if (reputation.code.length == 0) {
            emit FeedbackFailed(missionId, agentId, role);
            return;
        }
        try IReputationRegistry8004(reputation).giveFeedback(
            agentId,
            value,
            0,
            role == Role.Provider ? "fieldquest.delivery" : "fieldquest.verification",
            tag2,
            "",
            "",
            evidenceHash
        ) {
            if (role == Role.Provider) {
                providerRecorded[missionId] = true;
            } else {
                verifierRecorded[missionId] = true;
            }
            emit FeedbackRecorded(missionId, agentId, role, value);
        } catch {
            emit FeedbackFailed(missionId, agentId, role);
        }
    }

    function _deliveryTag(IMissionEscrow.Outcome outcome) private pure returns (string memory) {
        if (outcome == IMissionEscrow.Outcome.ProviderPaid) return "paid";
        if (outcome == IMissionEscrow.Outcome.BuyerRefunded) return "refunded";
        if (outcome == IMissionEscrow.Outcome.Split) return "split";
        return "expired";
    }
}
