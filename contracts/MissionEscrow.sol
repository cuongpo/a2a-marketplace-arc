// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {IMissionEscrow} from "./interfaces/IMissionEscrow.sol";
import {IEvidenceRegistry} from "./interfaces/IEvidenceRegistry.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {SignatureChecker} from "@openzeppelin/contracts/utils/cryptography/SignatureChecker.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";

/// @title MissionEscrow
/// @notice Fully funded USDC missions with signed sensor evidence, verifier verdicts and pull payments.
/// @dev No owner, pause, upgrade or asset-recovery authority exists. The immutable arbiter can only
/// choose between the mission's prescribed allocations; it cannot choose payout recipients.
/// Accepted/rejected verdicts are challengeable strictly before challengeEndsAt. A verifier may
/// escalate immediately, or anyone may escalate after three days without a verdict. The arbiter
/// can resolve a challenge; after seven days anyone can instead enforce a signed Accept or Reject
/// verdict, or refund the provider price for Escalate or no verdict. Outcome.Split is unused.
/// The verifier fee is credited only for a recorded signed verdict (including Escalate); without
/// one it is refunded to refundTo, including when the arbiter awards the provider price.
/// Cancellation or expiration before evidence refunds both price and fee. Settlement only
/// reclassifies liabilities; actual transfers occur through independent pull withdrawals/refunds.
/// Credits belong to providers/verifiers, who may direct their own withdrawal to another address.
/// Refund destinations may be changed only by the buyer, never by the arbiter or a relayer.
/// Assumes a non-rebasing USDC implementation; funding requires an exact balance increase.
contract MissionEscrow is IMissionEscrow, EIP712, ReentrancyGuard {
    using SafeERC20 for IERC20;
    using SafeCast for uint256;

    error ZeroAddress();
    error UnknownMission(uint256 id);
    error InvalidParticipants();
    error InvalidMissionParameters();
    error InvalidDeadline();
    error InvalidStatus(uint256 id, Status status);
    error Unauthorized();
    error DeadlineReached();
    error DeadlineNotPassed();
    error EmptyEvidence();
    error EvidenceMismatch();
    error VerdictExpired();
    error InvalidDecision();
    error VerdictNonceAlreadyUsed();
    error InvalidVerdictSignature();
    error ChallengeWindowClosed();
    error TimeoutNotReached();
    error ChallengeWindowOpen();
    error NothingToWithdraw();
    error NothingToRefund();
    error RefundAlreadyClaimed();
    error MissionNotTerminal();
    error InexactFunding(uint256 expected, uint256 balanceBefore, uint256 balanceAfter);
    error Insolvent(uint256 balance, uint256 liabilities);

    /// @inheritdoc IMissionEscrow
    uint32 public constant override MAX_CHALLENGE_WINDOW = 3 days;
    /// @inheritdoc IMissionEscrow
    uint32 public constant override VERIFIER_TIMEOUT = 3 days;
    /// @inheritdoc IMissionEscrow
    uint32 public constant override ARBITER_TIMEOUT = 7 days;
    /// @notice Maximum future evidence deadline at mission creation.
    uint32 public constant MAX_DEADLINE_HORIZON = 30 days;
    /// @notice Deadline must be strictly more than this far in the future at creation.
    uint32 public constant MIN_DEADLINE_LEAD = 60 seconds;

    bytes32 private constant VERDICT_TYPEHASH = keccak256(
        "Verdict(uint256 missionId,bytes32 evidenceHash,uint8 decision,bytes32 reasonHash,uint64 expiry,uint256 nonce)"
    );

    /// @inheritdoc IMissionEscrow
    address public immutable override usdc;
    /// @inheritdoc IMissionEscrow
    address public immutable override registry;
    /// @inheritdoc IMissionEscrow
    address public immutable override arbiter;
    /// @inheritdoc IMissionEscrow
    uint256 public override missionCount;
    /// @inheritdoc IMissionEscrow
    uint256 public override totalLiabilities;
    /// @inheritdoc IMissionEscrow
    mapping(address => uint256) public override credits;
    /// @inheritdoc IMissionEscrow
    mapping(uint256 => uint256) public override refundAmount;
    /// @inheritdoc IMissionEscrow
    mapping(uint256 => bool) public override refundClaimed;
    /// @inheritdoc IMissionEscrow
    mapping(address => mapping(uint256 => bool)) public override verdictNonceUsed;
    mapping(uint256 => Mission) private _missions;
    /// @dev True exactly when the mission has a recorded signed verdict (decision != Decision.None).
    mapping(uint256 => bool) private _verifierDelivered;

    /// @notice Set the permanent token, evidence registry and dispute arbiter.
    /// @param usdc_ ERC-20 USDC address; all amounts use its base units, not native currency.
    /// @param registry_ Registry which authenticates and consumes sensor readings.
    /// @param arbiter_ Only address authorized to choose the winner of a challenged mission.
    constructor(address usdc_, address registry_, address arbiter_)
        EIP712("FieldQuest MissionEscrow", "1")
    {
        if (usdc_ == address(0) || registry_ == address(0) || arbiter_ == address(0)) revert ZeroAddress();
        usdc = usdc_;
        registry = registry_;
        arbiter = arbiter_;
    }

    /// @inheritdoc IMissionEscrow
    /// @dev Creates and funds atomically. Fee-on-transfer or otherwise inexact deposits revert.
    function createMission(MissionParams calldata p) external override nonReentrant returns (uint256 id) {
        if (p.provider == address(0) || p.verifier == address(0) || p.refundTo == address(0)) {
            revert ZeroAddress();
        }
        if (p.provider == p.verifier || p.provider == msg.sender || p.verifier == msg.sender) {
            revert InvalidParticipants();
        }
        if (
            p.providerPrice == 0 || p.tileId == bytes32(0) || p.objectiveHash == bytes32(0)
                || p.challengeWindow > MAX_CHALLENGE_WINDOW || p.maxReadingAge == 0
        ) revert InvalidMissionParameters();
        if (
            uint256(p.deadline) <= block.timestamp + MIN_DEADLINE_LEAD
                || uint256(p.deadline) > block.timestamp + MAX_DEADLINE_HORIZON
        ) revert InvalidDeadline();

        uint256 total = uint256(p.providerPrice) + uint256(p.verifierFee);
        uint256 beforeBalance = IERC20(usdc).balanceOf(address(this));
        IERC20(usdc).safeTransferFrom(msg.sender, address(this), total);
        uint256 afterBalance = IERC20(usdc).balanceOf(address(this));
        if (afterBalance < beforeBalance || afterBalance - beforeBalance != total) {
            revert InexactFunding(total, beforeBalance, afterBalance);
        }

        id = ++missionCount;
        Mission storage m = _missions[id];
        m.buyer = msg.sender;
        m.refundTo = p.refundTo;
        m.provider = p.provider;
        m.verifier = p.verifier;
        m.providerPrice = p.providerPrice;
        m.verifierFee = p.verifierFee;
        m.createdAt = block.timestamp.toUint64();
        m.deadline = p.deadline;
        m.maxReadingAge = p.maxReadingAge;
        m.challengeWindow = p.challengeWindow;
        m.status = Status.Funded;
        m.objectiveHash = p.objectiveHash;
        m.tileId = p.tileId;
        m.unit = p.unit;
        m.quoteHash = p.quoteHash;
        totalLiabilities += total;
        _requireSolvent();
        _emitCreated(id, m);
    }

    /// @inheritdoc IMissionEscrow
    /// @dev Cancellation creates a pull refund; it never calls the refund recipient.
    function cancelUnassigned(uint256 id) external override nonReentrant {
        Mission storage m = _mission(id);
        if (msg.sender != m.buyer) revert Unauthorized();
        _requireStatus(id, m, Status.Funded);
        _expire(id, m);
    }

    /// @inheritdoc IMissionEscrow
    function acceptAssignment(uint256 id) external override nonReentrant {
        Mission storage m = _mission(id);
        if (msg.sender != m.provider) revert Unauthorized();
        _requireStatus(id, m, Status.Funded);
        if (block.timestamp >= m.deadline) revert DeadlineReached();
        m.status = Status.Assigned;
        m.assignedAt = block.timestamp.toUint64();
        emit MissionAssigned(id, m.provider);
    }

    /// @inheritdoc IMissionEscrow
    /// @dev Registry validation and nonce consumption revert atomically with this submission.
    function submitEvidence(
        uint256 id,
        bytes32 evidenceHash,
        IEvidenceRegistry.Reading calldata reading,
        bytes calldata sensorSig
    ) external override nonReentrant {
        Mission storage m = _mission(id);
        if (msg.sender != m.provider) revert Unauthorized();
        _requireStatus(id, m, Status.Assigned);
        if (block.timestamp > m.deadline) revert DeadlineReached();
        if (evidenceHash == bytes32(0)) revert EmptyEvidence();
        IEvidenceRegistry.Constraints memory constraints = IEvidenceRegistry.Constraints({
            missionId: id,
            tileId: m.tileId,
            unit: m.unit,
            notBefore: m.createdAt,
            maxAge: m.maxReadingAge
        });
        (bytes32 digest, address signer) =
            IEvidenceRegistry(registry).consumeReading(m.provider, constraints, reading, sensorSig);
        m.evidenceHash = evidenceHash;
        m.readingCommitment = digest;
        m.submittedAt = block.timestamp.toUint64();
        m.status = Status.Submitted;
        _emitEvidence(id, m, reading, signer);
    }

    /// @inheritdoc IMissionEscrow
    /// @dev SignatureChecker supports EOAs and ERC-1271 verifiers. Nonces are verifier-wide.
    function submitVerdict(Verdict calldata v, bytes calldata verifierSig) external override nonReentrant {
        Mission storage m = _mission(v.missionId);
        _requireStatus(v.missionId, m, Status.Submitted);
        if (v.evidenceHash != m.evidenceHash) revert EvidenceMismatch();
        if (v.expiry < block.timestamp) revert VerdictExpired();
        if (v.decision < 1 || v.decision > 3) revert InvalidDecision();
        if (verdictNonceUsed[m.verifier][v.nonce]) revert VerdictNonceAlreadyUsed();
        verdictNonceUsed[m.verifier][v.nonce] = true;
        if (!SignatureChecker.isValidSignatureNow(m.verifier, hashVerdict(v), verifierSig)) {
            revert InvalidVerdictSignature();
        }
        m.verdictAt = block.timestamp.toUint64();
        m.decision = Decision(v.decision);
        _verifierDelivered[v.missionId] = m.decision != Decision.None;
        m.verdictReasonHash = v.reasonHash;
        if (v.decision == uint8(Decision.Escalate)) {
            m.status = Status.Challenged;
            m.challengedAt = block.timestamp.toUint64();
            emit MissionEscalated(v.missionId, 1);
        } else {
            m.status = v.decision == uint8(Decision.Accept) ? Status.Accepted : Status.Rejected;
            m.challengeEndsAt = (block.timestamp + uint256(m.challengeWindow)).toUint64();
        }
        emit VerdictRecorded(
            v.missionId, m.verifier, v.decision, v.evidenceHash, v.reasonHash, v.nonce, m.challengeEndsAt
        );
    }

    /// @inheritdoc IMissionEscrow
    function challenge(uint256 id) external override nonReentrant {
        Mission storage m = _mission(id);
        if (m.status != Status.Accepted && m.status != Status.Rejected) revert InvalidStatus(id, m.status);
        if (block.timestamp >= m.challengeEndsAt) revert ChallengeWindowClosed();
        if (
            (m.status == Status.Accepted && msg.sender != m.buyer)
                || (m.status == Status.Rejected && msg.sender != m.provider)
        ) revert Unauthorized();
        m.status = Status.Challenged;
        m.challengedAt = block.timestamp.toUint64();
        emit MissionChallenged(id, msg.sender);
    }

    /// @inheritdoc IMissionEscrow
    function escalateStale(uint256 id) external override nonReentrant {
        Mission storage m = _mission(id);
        _requireStatus(id, m, Status.Submitted);
        if (block.timestamp < uint256(m.submittedAt) + VERIFIER_TIMEOUT) revert TimeoutNotReached();
        m.status = Status.Challenged;
        m.challengedAt = block.timestamp.toUint64();
        emit MissionEscalated(id, 2);
    }

    /// @inheritdoc IMissionEscrow
    function finalize(uint256 id) external override nonReentrant {
        Mission storage m = _mission(id);
        if (m.status != Status.Accepted && m.status != Status.Rejected) revert InvalidStatus(id, m.status);
        if (block.timestamp < m.challengeEndsAt) revert ChallengeWindowOpen();
        bool providerWins = m.status == Status.Accepted;
        _settle(id, m, providerWins ? Outcome.ProviderPaid : Outcome.BuyerRefunded,
            providerWins ? uint256(m.providerPrice) : 0);
    }

    /// @inheritdoc IMissionEscrow
    /// @dev May resolve even after the timeout until someone executes resolveByTimeout first.
    /// The arbiter chooses the provider price allocation; an undelivered verifier fee is refunded.
    function resolve(uint256 id, bool providerWins) external override nonReentrant {
        Mission storage m = _mission(id);
        if (msg.sender != arbiter) revert Unauthorized();
        _requireStatus(id, m, Status.Challenged);
        emit ArbiterResolved(id, msg.sender, providerWins);
        _settle(id, m, providerWins ? Outcome.ProviderPaid : Outcome.BuyerRefunded,
            providerWins ? uint256(m.providerPrice) : 0);
    }

    /// @inheritdoc IMissionEscrow
    /// @dev A signed Accept pays the provider; Reject, Escalate or no verdict refunds the price.
    /// Signed verdicts earn the verifier fee; no verdict refunds it too. Price + fee are conserved.
    function resolveByTimeout(uint256 id) external override nonReentrant {
        Mission storage m = _mission(id);
        _requireStatus(id, m, Status.Challenged);
        if (block.timestamp < uint256(m.challengedAt) + ARBITER_TIMEOUT) revert TimeoutNotReached();
        bool providerWins = m.decision == Decision.Accept;
        _settle(id, m, providerWins ? Outcome.ProviderPaid : Outcome.BuyerRefunded,
            providerWins ? uint256(m.providerPrice) : 0);
    }

    /// @inheritdoc IMissionEscrow
    function expire(uint256 id) external override nonReentrant {
        Mission storage m = _mission(id);
        if (m.status != Status.Funded && m.status != Status.Assigned) revert InvalidStatus(id, m.status);
        if (block.timestamp <= m.deadline) revert DeadlineNotPassed();
        _expire(id, m);
    }

    /// @inheritdoc IMissionEscrow
    /// @dev Failed/blocked transfers revert all effects, leaving other accounts' pulls independent.
    function withdraw(address to) external override nonReentrant returns (uint256 amount) {
        if (to == address(0)) revert ZeroAddress();
        amount = credits[msg.sender];
        if (amount == 0) revert NothingToWithdraw();
        credits[msg.sender] = 0;
        totalLiabilities -= amount;
        IERC20(usdc).safeTransfer(to, amount);
        _requireSolvent();
        emit Withdrawn(msg.sender, to, amount);
    }

    /// @inheritdoc IMissionEscrow
    /// @dev Relayers cannot substitute the destination. refundAmount remains fixed after payment.
    function claimRefund(uint256 id) external override nonReentrant returns (uint256 amount) {
        Mission storage m = _mission(id);
        if (!_terminal(m.status)) revert MissionNotTerminal();
        if (refundClaimed[id]) revert RefundAlreadyClaimed();
        amount = refundAmount[id];
        if (amount == 0) revert NothingToRefund();
        refundClaimed[id] = true;
        totalLiabilities -= amount;
        address recipient = m.refundTo;
        IERC20(usdc).safeTransfer(recipient, amount);
        _requireSolvent();
        emit RefundClaimed(id, recipient, amount);
    }

    /// @inheritdoc IMissionEscrow
    /// @dev Permitted before or after settlement, but never after a successful refund claim.
    function redirectRefund(uint256 id, address newRefundTo) external override nonReentrant {
        Mission storage m = _mission(id);
        if (msg.sender != m.buyer) revert Unauthorized();
        if (newRefundTo == address(0)) revert ZeroAddress();
        if (refundClaimed[id]) revert RefundAlreadyClaimed();
        m.refundTo = newRefundTo;
        emit RefundRedirected(id, newRefundTo);
    }

    /// @inheritdoc IMissionEscrow
    function getMission(uint256 id) external view override returns (Mission memory) {
        return _mission(id);
    }

    /// @inheritdoc IMissionEscrow
    /// @dev Includes the chain ID and this escrow through the EIP-712 domain separator.
    function hashVerdict(Verdict calldata v) public view override returns (bytes32) {
        return _hashTypedDataV4(keccak256(abi.encode(
            VERDICT_TYPEHASH, v.missionId, v.evidenceHash, v.decision, v.reasonHash, v.expiry, v.nonce
        )));
    }

    /// @dev Every mission-specific action uses existence, not a timestamp sentinel.
    function _mission(uint256 id) private view returns (Mission storage m) {
        m = _missions[id];
        if (m.status == Status.None) revert UnknownMission(id);
    }

    function _requireStatus(uint256 id, Mission storage m, Status expected) private view {
        if (m.status != expected) revert InvalidStatus(id, m.status);
    }

    function _terminal(Status status) private pure returns (bool) {
        return status == Status.Expired || status == Status.Settled;
    }

    /// @dev Called only from pre-terminal states. No external calls and no liability change.
    function _expire(uint256 id, Mission storage m) private {
        uint256 amount = uint256(m.providerPrice) + uint256(m.verifierFee);
        m.status = Status.Expired;
        m.outcome = Outcome.Expired;
        refundAmount[id] = amount;
        emit MissionExpired(id, amount);
    }

    /// @dev Called only after lifecycle guards. Reclassifies the complete mission total without
    /// changing totalLiabilities: providerCredit + fee + refund == providerPrice + verifierFee.
    /// Only a recorded signed verdict earns the fee; otherwise it joins the buyer's pull refund.
    function _settle(uint256 id, Mission storage m, Outcome outcome, uint256 providerCredit) private {
        uint256 fee = _verifierDelivered[id] ? uint256(m.verifierFee) : 0;
        uint256 refund = uint256(m.providerPrice) + uint256(m.verifierFee) - providerCredit - fee;
        m.status = Status.Settled;
        m.outcome = outcome;
        refundAmount[id] = refund;
        _addCredit(m.provider, id, providerCredit);
        _addCredit(m.verifier, id, fee);
        emit MissionSettled(id, outcome, providerCredit, fee, refund);
    }

    function _addCredit(address account, uint256 id, uint256 amount) private {
        if (amount == 0) return;
        credits[account] += amount;
        emit CreditAdded(account, id, amount);
    }

    function _requireSolvent() private view {
        uint256 balance = IERC20(usdc).balanceOf(address(this));
        if (balance < totalLiabilities) revert Insolvent(balance, totalLiabilities);
    }

    function _emitCreated(uint256 id, Mission storage m) private {
        emit MissionCreated(
            id, m.buyer, m.provider, m.verifier, m.refundTo, m.tileId, m.objectiveHash, m.quoteHash,
            m.providerPrice, m.verifierFee, m.deadline
        );
    }

    function _emitEvidence(
        uint256 id, Mission storage m, IEvidenceRegistry.Reading calldata reading, address signer
    ) private {
        emit EvidenceSubmitted(
            id, m.provider, m.evidenceHash, m.readingCommitment, signer, reading.observedAt,
            reading.value, m.unit, reading.nonce, reading.payloadHash
        );
    }
}
