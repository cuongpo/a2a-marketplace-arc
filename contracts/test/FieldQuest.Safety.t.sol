// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {FQBase} from "./FieldQuest.Base.t.sol";
import {MissionEscrow} from "../MissionEscrow.sol";
import {AgentBudgetVault} from "../AgentBudgetVault.sol";
import {IMissionEscrow} from "../interfaces/IMissionEscrow.sol";
import {IAgentBudgetVault} from "../interfaces/IAgentBudgetVault.sol";
import {IEvidenceRegistry} from "../interfaces/IEvidenceRegistry.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {MockUSDC, FeeOnTransferUSDC, ReentrantToken, ReentrantAttacker} from "./mocks/Mocks.sol";

/// @dev Duplicate calls, failed transfers, fee-on-transfer tokens.
contract FQSafetyTest is FQBase {
    function _settleAccepted() internal returns (uint256 id) {
        id = _toAccepted();
        _skipPastWindow(id);
        esc.finalize(id);
    }

    // ------------------------------------------------------------ duplicates
    function test_Duplicate_DoubleFinalizeReverts() public {
        uint256 id = _settleAccepted();
        vm.expectRevert(abi.encodeWithSelector(MissionEscrow.InvalidStatus.selector, id, IMissionEscrow.Status.Settled));
        esc.finalize(id);
        assertEq(esc.credits(provider), PRICE, "credit not doubled");
        assertEq(esc.credits(verifier), FEE);
        assertEq(esc.totalLiabilities(), uint256(PRICE) + FEE);
    }

    function test_Duplicate_DoubleWithdrawReverts() public {
        _settleAccepted();
        vm.startPrank(provider);
        esc.withdraw(provider);
        vm.expectRevert(MissionEscrow.NothingToWithdraw.selector);
        esc.withdraw(provider);
        vm.stopPrank();
        assertEq(usdc.balanceOf(provider), PRICE);
        assertEq(usdc.balanceOf(address(esc)), FEE);
    }

    function test_Duplicate_DoubleClaimRefundReverts() public {
        uint256 id = _toRejected();
        _skipPastWindow(id);
        esc.finalize(id);
        esc.claimRefund(id);
        vm.expectRevert(MissionEscrow.RefundAlreadyClaimed.selector);
        esc.claimRefund(id);
        assertEq(usdc.balanceOf(address(esc)), FEE, "only verifier fee remains");
    }

    function test_Duplicate_DoubleSubmitEvidenceReverts() public {
        uint256 id = _toSubmitted();
        IEvidenceRegistry.Reading memory r = _reading(id);
        bytes memory sig = _signReading(sensorPk, r);
        vm.prank(provider);
        vm.expectRevert(abi.encodeWithSelector(MissionEscrow.InvalidStatus.selector, id, IMissionEscrow.Status.Submitted));
        esc.submitEvidence(id, EVID, r, sig);
    }

    function test_Duplicate_DoubleAcceptAssignmentReverts() public {
        uint256 id = _toAssigned();
        vm.prank(provider);
        vm.expectRevert(abi.encodeWithSelector(MissionEscrow.InvalidStatus.selector, id, IMissionEscrow.Status.Assigned));
        esc.acceptAssignment(id);
    }

    function test_Duplicate_DoubleExpireAndCancelRevert() public {
        uint256 id = _create();
        vm.prank(buyer);
        esc.cancelUnassigned(id);
        vm.prank(buyer);
        vm.expectRevert(abi.encodeWithSelector(MissionEscrow.InvalidStatus.selector, id, IMissionEscrow.Status.Expired));
        esc.cancelUnassigned(id);
        vm.warp(esc.getMission(id).deadline + 1);
        vm.expectRevert(abi.encodeWithSelector(MissionEscrow.InvalidStatus.selector, id, IMissionEscrow.Status.Expired));
        esc.expire(id);
    }

    function test_Duplicate_DoubleReconcileReverts() public {
        _vaultStd();
        uint256 id = _vaultMission(PRICE, FEE);
        vm.prank(address(vault));
        esc.cancelUnassigned(id);
        vault.reconcile(address(esc), id);
        vm.expectRevert(IAgentBudgetVault.AlreadyReconciled.selector);
        vault.reconcile(address(esc), id);
        assertEq(vault.availableOf(operator), 1000e6);
        assertEq(vault.committedOf(operator), 0);
    }

    // ------------------------------------------------------------ failed USDC transfers (blocklist)
    function test_Blocklist_WithdrawToBlockedLeavesStateIntactThenSucceedsAfterUnblock() public {
        _settleAccepted();
        usdc.setBlocked(providerWallet, true);
        uint256 liabilities = esc.totalLiabilities();

        vm.prank(provider);
        vm.expectRevert();
        esc.withdraw(providerWallet);
        assertEq(esc.credits(provider), PRICE, "credit intact");
        assertEq(esc.totalLiabilities(), liabilities, "liabilities intact");
        assertEq(usdc.balanceOf(address(esc)), liabilities);

        // other parties unaffected
        vm.prank(verifier);
        esc.withdraw(verifier);
        assertEq(usdc.balanceOf(verifier), FEE);

        usdc.setBlocked(providerWallet, false);
        vm.prank(provider);
        esc.withdraw(providerWallet);
        assertEq(usdc.balanceOf(providerWallet), PRICE);
        assertEq(usdc.balanceOf(address(esc)), 0);
    }

    function test_Blocklist_WithdrawToAlternativeAddressWorks() public {
        _settleAccepted();
        usdc.setBlocked(providerWallet, true);
        address alt = makeAddr("alt");
        vm.prank(provider);
        vm.expectRevert();
        esc.withdraw(providerWallet);
        vm.prank(provider);
        esc.withdraw(alt);
        assertEq(usdc.balanceOf(alt), PRICE);
        assertEq(esc.credits(provider), 0);
    }

    function test_Blocklist_BlockedRefundRecipientDoesNotLockOthers() public {
        uint256 id = _toRejected();
        _skipPastWindow(id);
        esc.finalize(id);
        usdc.setBlocked(buyer, true);

        vm.expectRevert();
        esc.claimRefund(id);
        assertFalse(esc.refundClaimed(id), "claim flag rolled back");
        assertEq(esc.refundAmount(id), PRICE);

        vm.prank(verifier);
        esc.withdraw(verifier); // unaffected
        assertEq(usdc.balanceOf(verifier), FEE);

        address newTo = makeAddr("newTo");
        vm.prank(buyer);
        esc.redirectRefund(id, newTo);
        esc.claimRefund(id);
        assertEq(usdc.balanceOf(newTo), PRICE);
        assertEq(esc.totalLiabilities(), 0);
    }

    function test_Blocklist_BlockedBuyerCannotFund() public {
        usdc.setBlocked(buyer, true);
        IMissionEscrow.MissionParams memory p = _params();
        vm.prank(buyer);
        vm.expectRevert();
        esc.createMission(p);
        assertEq(esc.missionCount(), 0);
    }

    // ------------------------------------------------------------ fee-on-transfer rejection
    function test_FeeOnTransfer_RejectedAtCreateMission() public {
        FeeOnTransferUSDC ft = new FeeOnTransferUSDC();
        MissionEscrow e = new MissionEscrow(address(ft), address(reg), arbiter);
        ft.mint(buyer, 1000e6);
        vm.prank(buyer);
        ft.approve(address(e), type(uint256).max);

        IMissionEscrow.MissionParams memory p = _params();
        uint256 total = uint256(PRICE) + FEE;
        vm.prank(buyer);
        vm.expectRevert(
            abi.encodeWithSelector(MissionEscrow.InexactFunding.selector, total, 0, total - total / 100)
        );
        e.createMission(p);
        assertEq(e.missionCount(), 0);
        assertEq(ft.balanceOf(buyer), 1000e6, "revert rolled back the pull");
    }

    function test_FeeOnTransfer_RejectedAtVaultDeposit() public {
        FeeOnTransferUSDC ft = new FeeOnTransferUSDC();
        MissionEscrow e = new MissionEscrow(address(ft), address(reg), arbiter);
        address[] memory t = new address[](1);
        t[0] = address(e);
        AgentBudgetVault v = new AgentBudgetVault(address(ft), t);
        ft.mint(operator, 1000e6);
        vm.startPrank(operator);
        ft.approve(address(v), type(uint256).max);
        vm.expectRevert(abi.encodeWithSelector(SafeERC20.SafeERC20FailedOperation.selector, address(ft)));
        v.deposit(100e6);
        vm.stopPrank();
        assertEq(v.availableOf(operator), 0);
        assertEq(v.totalHeld(), 0);
    }
}

/// @dev Reentrancy attempts using a callback token + attacker contract.
contract FQReentrancyTest is FQBase {
    ReentrantToken internal rt;
    ReentrantAttacker internal att;
    MissionEscrow internal resc;
    AgentBudgetVault internal rvault;
    uint256 internal attPk = 0xD00D;

    function setUp() public override {
        super.setUp();
        rt = new ReentrantToken();
        att = new ReentrantAttacker();
        resc = new MissionEscrow(address(rt), address(reg), arbiter);
        address[] memory t = new address[](1);
        t[0] = address(resc);
        rvault = new AgentBudgetVault(address(rt), t);
        rt.mint(buyer, 1_000_000e6);
        vm.prank(buyer);
        rt.approve(address(resc), type(uint256).max);
        rt.setHook(address(att));
    }

    function _reenter(address target, bytes memory data) internal {
        att.arm(target, data);
    }

    function _assertBlocked() internal view {
        assertTrue(att.fired(), "hook fired");
        assertFalse(att.reentrySucceeded(), "reentry must fail");
        assertEq(bytes4(att.reentryRevertData()), ReentrancyGuard.ReentrancyGuardReentrantCall.selector);
    }

    function _attackerProviderSettled() internal returns (uint256 id) {
        _registerSensor(address(att), attPk);
        IMissionEscrow.MissionParams memory p = _paramsFor(address(att), PRICE, FEE);
        vm.prank(buyer);
        id = resc.createMission(p);
        vm.prank(address(att));
        resc.acceptAssignment(id);
        IEvidenceRegistry.Reading memory r = _reading(id);
        bytes memory sig = _signReading(attPk, r);
        vm.prank(address(att));
        resc.submitEvidence(id, EVID, r, sig);
        _verdictOn(resc, id, 1);
        vm.warp(resc.getMission(id).challengeEndsAt);
        resc.finalize(id);
    }

    function test_Reentrancy_WithdrawCannotDoubleSpend() public {
        _attackerProviderSettled();
        _reenter(address(resc), abi.encodeCall(resc.withdraw, (address(att))));
        vm.prank(address(att));
        resc.withdraw(address(att));
        _assertBlocked();
        assertEq(rt.balanceOf(address(att)), PRICE, "paid exactly once");
        assertEq(resc.credits(address(att)), 0);
        assertEq(rt.balanceOf(address(resc)), FEE);
        assertEq(resc.totalLiabilities(), FEE);
    }

    function test_Reentrancy_ClaimRefundCannotDoubleSpend() public {
        rt.mint(address(att), 1000e6);
        att.exec(address(rt), abi.encodeCall(rt.approve, (address(resc), type(uint256).max)));
        IMissionEscrow.MissionParams memory p = _paramsFor(provider, PRICE, FEE);
        p.refundTo = address(att);
        bytes memory ret = att.exec(address(resc), abi.encodeCall(resc.createMission, (p)));
        uint256 id = abi.decode(ret, (uint256));
        att.exec(address(resc), abi.encodeCall(resc.cancelUnassigned, (id)));

        uint256 before_ = rt.balanceOf(address(att));
        _reenter(address(resc), abi.encodeCall(resc.claimRefund, (id)));
        vm.prank(stranger);
        resc.claimRefund(id);
        _assertBlocked();
        assertEq(rt.balanceOf(address(att)) - before_, uint256(PRICE) + FEE, "refunded exactly once");
        assertEq(rt.balanceOf(address(resc)), 0);
        assertEq(resc.totalLiabilities(), 0);
    }

    function test_Reentrancy_CreateMissionBlockedDuringFunding() public {
        rt.mint(address(att), 1000e6);
        att.exec(address(rt), abi.encodeCall(rt.approve, (address(resc), type(uint256).max)));
        IMissionEscrow.MissionParams memory p = _paramsFor(provider, PRICE, FEE);
        p.refundTo = address(att);
        _reenter(address(resc), abi.encodeCall(resc.createMission, (p)));
        att.exec(address(resc), abi.encodeCall(resc.createMission, (p)));
        _assertBlocked();
        assertEq(resc.missionCount(), 1);
        assertEq(resc.totalLiabilities(), uint256(PRICE) + FEE);
    }

    function test_Reentrancy_VaultDepositBlocked() public {
        rt.mint(address(att), 1000e6);
        att.exec(address(rt), abi.encodeCall(rt.approve, (address(rvault), type(uint256).max)));
        _reenter(address(rvault), abi.encodeCall(rvault.deposit, (100e6)));
        att.exec(address(rvault), abi.encodeCall(rvault.deposit, (100e6)));
        _assertBlocked();
        assertEq(rvault.availableOf(address(att)), 100e6, "credited once");
        assertEq(rvault.totalHeld(), 100e6);
        assertEq(rt.balanceOf(address(rvault)), 100e6);
    }

    function test_Reentrancy_VaultWithdrawAvailableBlocked() public {
        rt.mint(address(att), 1000e6);
        att.exec(address(rt), abi.encodeCall(rt.approve, (address(rvault), type(uint256).max)));
        att.exec(address(rvault), abi.encodeCall(rvault.deposit, (300e6)));
        _reenter(address(rvault), abi.encodeCall(rvault.withdrawAvailable, (100e6, address(att))));
        att.exec(address(rvault), abi.encodeCall(rvault.withdrawAvailable, (100e6, address(att))));
        _assertBlocked();
        assertEq(rvault.availableOf(address(att)), 200e6, "debited once");
        assertEq(rt.balanceOf(address(rvault)), 200e6);
    }
}
