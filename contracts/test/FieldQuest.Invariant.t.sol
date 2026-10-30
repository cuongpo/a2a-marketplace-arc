// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {StdInvariant} from "forge-std/StdInvariant.sol";
import {Vm} from "forge-std/Vm.sol";
import {FQBase} from "./FieldQuest.Base.t.sol";
import {IMissionEscrow} from "../interfaces/IMissionEscrow.sol";
import {MissionEscrow} from "../MissionEscrow.sol";
import {AgentBudgetVault} from "../AgentBudgetVault.sol";
import {MockUSDC} from "./mocks/Mocks.sol";

/// @dev Handler = a full fixture (inherits FQBase) plus bounded actions. Only `act_*` selectors are targeted.
contract FQHandler is FQBase {
    IMissionEscrow.Status internal constant S_FUNDED = IMissionEscrow.Status.Funded;

    address public op2 = makeAddr("operator2");
    address public ex2 = makeAddr("executor2");
    uint256 public conservationViolations;
    uint256 public settlements;
    uint256 public expiries;

    constructor() {
        setUp();
        address[2] memory ops = [operator, op2];
        address[2] memory exs = [executor, ex2];
        for (uint256 i = 0; i < 2; i++) {
            usdc.mint(ops[i], 5_000e6);
            vm.startPrank(ops[i]);
            usdc.approve(address(vault), type(uint256).max);
            vault.deposit(2_000e6);
            vault.setPolicy(exs[i], 400e6, 100_000e6, 1_500e6, uint64(T0 + 3650 days));
            vault.setEscrowAllowed(address(esc), true);
            vm.stopPrank();
        }
    }

    function operators() external view returns (address[2] memory) {
        return [operator, op2];
    }

    function deployed() external view returns (MockUSDC, MissionEscrow, AgentBudgetVault, address, address) {
        return (usdc, esc, vault, provider, verifier);
    }

    // ---------------------------------------------------------------- helpers
    function _pick(uint256 seed) internal view returns (uint256 id) {
        uint256 n = esc.missionCount();
        if (n == 0) return 0;
        id = bound(seed, 1, n);
    }

    function _check(uint256 id) internal {
        Vm.Log[] memory logs = vm.getRecordedLogs();
        for (uint256 i = 0; i < logs.length; i++) {
            if (logs[i].emitter == address(esc) && logs[i].topics[0] == IMissionEscrow.MissionSettled.selector) {
                (, uint256 pc, uint256 vc, uint256 rf) = abi.decode(logs[i].data, (uint8, uint256, uint256, uint256));
                IMissionEscrow.Mission memory m = esc.getMission(id);
                if (pc + vc + rf != uint256(m.providerPrice) + m.verifierFee) conservationViolations++;
                settlements++;
            }
        }
    }

    // ---------------------------------------------------------------- actions
    function act_createDirect(uint256 price, uint256 fee) external {
        price = bound(price, 1e6, 300e6);
        fee = bound(fee, 0, 30e6);
        usdc.mint(buyer, price + fee);
        IMissionEscrow.MissionParams memory p = _paramsFor(provider, uint128(price), uint128(fee));
        vm.prank(buyer);
        esc.createMission(p);
    }

    function act_createVault(uint256 who, uint256 price, uint256 fee) external {
        price = bound(price, 1e6, 300e6);
        fee = bound(fee, 0, 30e6);
        bool first = who % 2 == 0;
        IMissionEscrow.MissionParams memory p = _paramsFor(provider, uint128(price), uint128(fee));
        vm.prank(first ? executor : ex2);
        vault.createMissionFor(first ? operator : op2, address(esc), p);
    }

    function act_assign(uint256 seed) external {
        uint256 id = _pick(seed);
        if (id == 0) return;
        IMissionEscrow.Mission memory m = esc.getMission(id);
        if (m.status != S_FUNDED || block.timestamp >= m.deadline) return;
        _assign(esc, id);
    }

    function act_submit(uint256 seed) external {
        uint256 id = _pick(seed);
        if (id == 0) return;
        IMissionEscrow.Mission memory m = esc.getMission(id);
        if (m.status != IMissionEscrow.Status.Assigned || block.timestamp > m.deadline) return;
        _submitOn(esc, id);
    }

    function act_verdict(uint256 seed, uint256 decision) external {
        uint256 id = _pick(seed);
        if (id == 0 || _status(id) != IMissionEscrow.Status.Submitted) return;
        _verdictOn(esc, id, uint8(bound(decision, 1, 3)));
    }

    function act_challenge(uint256 seed) external {
        uint256 id = _pick(seed);
        if (id == 0) return;
        IMissionEscrow.Mission memory m = esc.getMission(id);
        if (block.timestamp >= m.challengeEndsAt) return;
        if (m.status == IMissionEscrow.Status.Accepted) {
            if (m.buyer == address(vault)) {
                vm.prank(vault.missionOperator(address(esc), id));
                vault.challengeMission(address(esc), id);
            } else {
                vm.prank(m.buyer);
                esc.challenge(id);
            }
        } else if (m.status == IMissionEscrow.Status.Rejected) {
            vm.prank(m.provider);
            esc.challenge(id);
        }
    }

    function act_escalateStale(uint256 seed) external {
        uint256 id = _pick(seed);
        if (id == 0) return;
        IMissionEscrow.Mission memory m = esc.getMission(id);
        if (m.status != IMissionEscrow.Status.Submitted || block.timestamp < m.submittedAt + esc.VERIFIER_TIMEOUT()) return;
        esc.escalateStale(id);
    }

    function act_finalize(uint256 seed) external {
        uint256 id = _pick(seed);
        if (id == 0) return;
        IMissionEscrow.Mission memory m = esc.getMission(id);
        bool ok = (m.status == IMissionEscrow.Status.Accepted || m.status == IMissionEscrow.Status.Rejected)
            && block.timestamp >= m.challengeEndsAt;
        if (!ok) return;
        vm.recordLogs();
        esc.finalize(id);
        _check(id);
    }

    function act_resolve(uint256 seed, bool providerWins) external {
        uint256 id = _pick(seed);
        if (id == 0 || _status(id) != IMissionEscrow.Status.Challenged) return;
        vm.recordLogs();
        vm.prank(arbiter);
        esc.resolve(id, providerWins);
        _check(id);
    }

    function act_resolveByTimeout(uint256 seed) external {
        uint256 id = _pick(seed);
        if (id == 0) return;
        IMissionEscrow.Mission memory m = esc.getMission(id);
        if (m.status != IMissionEscrow.Status.Challenged || block.timestamp < m.challengedAt + esc.ARBITER_TIMEOUT()) return;
        vm.recordLogs();
        esc.resolveByTimeout(id);
        _check(id);
    }

    function act_expire(uint256 seed) external {
        uint256 id = _pick(seed);
        if (id == 0) return;
        IMissionEscrow.Mission memory m = esc.getMission(id);
        if ((m.status != S_FUNDED && m.status != IMissionEscrow.Status.Assigned) || block.timestamp <= m.deadline) return;
        esc.expire(id);
        if (esc.refundAmount(id) != uint256(m.providerPrice) + m.verifierFee) conservationViolations++;
        expiries++;
    }

    function act_cancel(uint256 seed) external {
        uint256 id = _pick(seed);
        if (id == 0 || _status(id) != S_FUNDED) return;
        address b = esc.getMission(id).buyer;
        if (b == address(vault)) {
            vm.prank(vault.missionOperator(address(esc), id));
            vault.cancelUnassignedMission(address(esc), id);
        } else {
            vm.prank(b);
            esc.cancelUnassigned(id);
        }
        if (esc.refundAmount(id) != uint256(esc.getMission(id).providerPrice) + esc.getMission(id).verifierFee) {
            conservationViolations++;
        }
    }

    function act_withdraw(bool isProvider, bool alt) external {
        address who = isProvider ? provider : verifier;
        if (esc.credits(who) == 0) return;
        vm.prank(who);
        esc.withdraw(alt ? providerWallet : who);
    }

    function act_claimRefund(uint256 seed) external {
        uint256 id = _pick(seed);
        if (id == 0 || esc.refundClaimed(id) || esc.refundAmount(id) == 0) return;
        IMissionEscrow.Status s = _status(id);
        if (s != IMissionEscrow.Status.Settled && s != IMissionEscrow.Status.Expired) return;
        esc.claimRefund(id);
    }

    function act_reconcile(uint256 seed) external {
        uint256 id = _pick(seed);
        if (id == 0 || vault.missionCommitted(address(esc), id) == 0) return;
        IMissionEscrow.Status s = _status(id);
        if (s != IMissionEscrow.Status.Settled && s != IMissionEscrow.Status.Expired) return;
        vault.reconcile(address(esc), id);
    }

    function act_vaultDeposit(bool first, uint256 amount) external {
        amount = bound(amount, 1, 500e6);
        address o = first ? operator : op2;
        usdc.mint(o, amount);
        vm.startPrank(o);
        usdc.approve(address(vault), amount);
        vault.deposit(amount);
        vm.stopPrank();
    }

    function act_vaultWithdraw(bool first, uint256 amount) external {
        address o = first ? operator : op2;
        uint256 avail = vault.availableOf(o);
        if (avail == 0) return;
        amount = bound(amount, 1, avail);
        vm.prank(o);
        vault.withdrawAvailable(amount, o);
    }

    function act_warp(uint256 secs) external {
        vm.warp(block.timestamp + bound(secs, 0, 4 days));
    }
}

contract FQInvariantTest is StdInvariant, FQBase {
    FQHandler internal h;
    address[2] internal ops;

    function setUp() public override {
        h = new FQHandler();
        // Re-bind the fixture handles to the handler's deployment.
        (usdc, esc, vault, provider, verifier) = h.deployed();
        ops = h.operators();

        targetContract(address(h));
        bytes4[] memory sels = new bytes4[](18);
        sels[0] = h.act_createDirect.selector;
        sels[1] = h.act_createVault.selector;
        sels[2] = h.act_assign.selector;
        sels[3] = h.act_submit.selector;
        sels[4] = h.act_verdict.selector;
        sels[5] = h.act_challenge.selector;
        sels[6] = h.act_escalateStale.selector;
        sels[7] = h.act_finalize.selector;
        sels[8] = h.act_resolve.selector;
        sels[9] = h.act_resolveByTimeout.selector;
        sels[10] = h.act_expire.selector;
        sels[11] = h.act_cancel.selector;
        sels[12] = h.act_withdraw.selector;
        sels[13] = h.act_claimRefund.selector;
        sels[14] = h.act_reconcile.selector;
        sels[15] = h.act_vaultDeposit.selector;
        sels[16] = h.act_warp.selector;
        sels[17] = h.act_vaultWithdraw.selector;
        targetSelector(FuzzSelector({addr: address(h), selectors: sels}));
    }

    /// Non-vacuity: the handler's actions can drive a direct mission through settlement, withdrawal and refund.
    function test_Handler_DrivesDirectMissionToSettlement() public {
        h.act_createDirect(100e6, 5e6);
        h.act_assign(1);
        h.act_submit(1);
        h.act_verdict(1, 2); // reject
        h.act_warp(2 days);
        h.act_finalize(1);
        h.act_claimRefund(1);
        h.act_withdraw(false, false);
        assertEq(h.settlements(), 1);
        assertEq(esc.missionCount(), 1);
        assertEq(uint8(esc.getMission(1).status), uint8(IMissionEscrow.Status.Settled));
        assertTrue(esc.refundClaimed(1));
        assertEq(esc.totalLiabilities(), 0);
        assertEq(h.conservationViolations(), 0);
    }

    /// Non-vacuity: vault path including reconcile.
    function test_Handler_DrivesVaultMissionThroughReconcile() public {
        h.act_createVault(0, 100e6, 5e6);
        h.act_assign(1);
        h.act_submit(1);
        h.act_verdict(1, 1); // accept
        h.act_warp(2 days);
        h.act_finalize(1);
        h.act_reconcile(1);
        assertEq(h.settlements(), 1);
        assertEq(vault.committedOf(ops[0]), 0);
        assertEq(vault.availableOf(ops[0]), 2000e6 - 105e6);
        h.act_createVault(1, 100e6, 5e6);
        h.act_cancel(2);
        h.act_reconcile(2);
        assertEq(vault.availableOf(ops[1]), 2000e6);
        assertEq(h.conservationViolations(), 0);
    }

    /// usdc.balanceOf(escrow) >= totalLiabilities (and, with no stray transfers, exactly equal)
    function invariant_EscrowIsSolvent() public view {
        assertGe(usdc.balanceOf(address(esc)), esc.totalLiabilities());
        assertEq(usdc.balanceOf(address(esc)), esc.totalLiabilities());
    }

    /// providerCredit + verifierCredit + buyerRefund == providerPrice + verifierFee on every settlement / expiry
    function invariant_ConservationOnEverySettlement() public view {
        assertEq(h.conservationViolations(), 0);
    }

    /// totalLiabilities == open missions' funds + unwithdrawn credits + unclaimed refunds
    function invariant_LiabilitiesEqualSumOfParts() public view {
        uint256 sum = esc.credits(provider) + esc.credits(verifier);
        uint256 n = esc.missionCount();
        for (uint256 id = 1; id <= n; id++) {
            IMissionEscrow.Mission memory m = esc.getMission(id);
            bool terminal = m.status == IMissionEscrow.Status.Settled || m.status == IMissionEscrow.Status.Expired;
            if (!terminal) {
                sum += uint256(m.providerPrice) + m.verifierFee;
            } else if (!esc.refundClaimed(id)) {
                sum += esc.refundAmount(id);
            }
        }
        assertEq(esc.totalLiabilities(), sum);
    }

    /// vault token balance >= sum of operators' available balances
    function invariant_VaultBalanceCoversAvailable() public view {
        uint256 avail = vault.availableOf(ops[0]) + vault.availableOf(ops[1]);
        assertGe(usdc.balanceOf(address(vault)), avail);
    }

    /// sum(available + committed) == totalHeld
    function invariant_VaultAvailablePlusCommittedEqualsTotalHeld() public view {
        uint256 s = vault.availableOf(ops[0]) + vault.committedOf(ops[0]) + vault.availableOf(ops[1])
            + vault.committedOf(ops[1]);
        assertEq(s, vault.totalHeld());
    }

    /// committed per operator == sum of its unreconciled mission commitments
    function invariant_VaultCommittedMatchesMissions() public view {
        uint256 n = esc.missionCount();
        uint256[2] memory sums;
        for (uint256 id = 1; id <= n; id++) {
            address o = vault.missionOperator(address(esc), id);
            if (o == ops[0]) sums[0] += vault.missionCommitted(address(esc), id);
            else if (o == ops[1]) sums[1] += vault.missionCommitted(address(esc), id);
        }
        assertEq(sums[0], vault.committedOf(ops[0]));
        assertEq(sums[1], vault.committedOf(ops[1]));
    }
}
