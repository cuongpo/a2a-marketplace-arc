// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {FQBase} from "./FieldQuest.Base.t.sol";
import {MissionEscrow} from "../MissionEscrow.sol";
import {AgentBudgetVault} from "../AgentBudgetVault.sol";
import {IMissionEscrow} from "../interfaces/IMissionEscrow.sol";
import {IAgentBudgetVault} from "../interfaces/IAgentBudgetVault.sol";

/// @dev AgentBudgetVault: autonomous path, policy limits, executor restrictions, reconciliation.
contract FQVaultTest is FQBase {
    uint256 internal constant TOTAL = uint256(PRICE) + FEE; // 105e6

    function _day() internal view returns (uint256) {
        return block.timestamp / 1 days;
    }

    // ------------------------------------------------------------ autonomous path
    function test_Vault_OperatorDepositCreditsAvailable() public {
        usdc.mint(operator, 500e6);
        vm.startPrank(operator);
        usdc.approve(address(vault), 500e6);
        vm.expectEmit(true, false, false, true, address(vault));
        emit IAgentBudgetVault.Deposited(operator, 500e6);
        vault.deposit(500e6);
        vm.stopPrank();
        assertEq(vault.availableOf(operator), 500e6);
        assertEq(vault.totalHeld(), 500e6);
        assertEq(usdc.balanceOf(address(vault)), 500e6);
        assertEq(usdc.balanceOf(operator), 0);
    }

    function test_Vault_DepositZeroReverts() public {
        vm.prank(operator);
        vm.expectRevert(IAgentBudgetVault.ZeroAmount.selector);
        vault.deposit(0);
    }

    function test_Vault_SetPolicyAndAllowlist() public {
        vm.startPrank(operator);
        vm.expectEmit(true, true, false, true, address(vault));
        emit IAgentBudgetVault.PolicySet(operator, executor, 200e6, 500e6, 300e6, uint64(T0 + 20 days));
        vault.setPolicy(executor, 200e6, 500e6, 300e6, uint64(T0 + 20 days));
        vm.expectEmit(true, true, false, true, address(vault));
        emit IAgentBudgetVault.EscrowAllowed(operator, address(esc), true);
        vault.setEscrowAllowed(address(esc), true);
        vm.stopPrank();
        IAgentBudgetVault.Policy memory p = vault.policyOf(operator);
        assertEq(p.executor, executor);
        assertEq(p.perMissionCap, 200e6);
        assertEq(p.totalCap, 500e6);
        assertEq(p.dailyCap, 300e6);
        assertEq(p.expiry, T0 + 20 days);
        assertFalse(p.paused);
        assertTrue(vault.escrowAllowed(operator, address(esc)));
        assertTrue(vault.isTrustedEscrow(address(esc)));
    }

    function test_Vault_SetPolicyInvalidReverts() public {
        vm.startPrank(operator);
        vm.expectRevert(IAgentBudgetVault.NotOperatorPolicy.selector);
        vault.setPolicy(address(0), 1, 2, 2, uint64(T0 + 1 days));
        vm.expectRevert(IAgentBudgetVault.NotOperatorPolicy.selector);
        vault.setPolicy(executor, 0, 2, 2, uint64(T0 + 1 days));
        vm.expectRevert(IAgentBudgetVault.NotOperatorPolicy.selector);
        vault.setPolicy(executor, 3, 2, 2, uint64(T0 + 1 days));
        vm.expectRevert(IAgentBudgetVault.PolicyExpired.selector);
        vault.setPolicy(executor, 1, 2, 2, uint64(T0));
        vm.stopPrank();
    }

    function test_Vault_ExecutorCreateMissionForFundsEscrowExactly() public {
        _vaultStd();
        uint256 escBefore = usdc.balanceOf(address(esc));
        uint256 vaultBefore = usdc.balanceOf(address(vault));
        address evil = makeAddr("evilRefund");
        IMissionEscrow.MissionParams memory p = _paramsFor(provider, PRICE, FEE);
        p.refundTo = evil;

        vm.expectEmit(true, true, true, true, address(vault));
        emit IAgentBudgetVault.MissionCommitted(operator, address(esc), 1, executor, TOTAL);
        vm.prank(executor);
        uint256 id = vault.createMissionFor(operator, address(esc), p);

        assertEq(id, 1);
        assertEq(usdc.balanceOf(address(esc)) - escBefore, TOTAL, "escrow funded exactly providerPrice+verifierFee");
        assertEq(vaultBefore - usdc.balanceOf(address(vault)), TOTAL);
        assertEq(vault.availableOf(operator), 1000e6 - TOTAL);
        assertEq(vault.committedOf(operator), TOTAL);
        assertEq(vault.netSpentOf(operator), TOTAL);
        assertEq(vault.dailySpentOf(operator, _day()), TOTAL);
        assertEq(vault.totalHeld(), 1000e6, "available -> committed does not change totalHeld");
        assertEq(vault.missionOperator(address(esc), id), operator);
        assertEq(vault.missionCommitted(address(esc), id), TOTAL);
        assertEq(usdc.allowance(address(vault), address(esc)), 0, "no leftover approval");

        IMissionEscrow.Mission memory m = esc.getMission(id);
        assertEq(m.buyer, address(vault));
        assertEq(m.refundTo, address(vault), "refundTo forced to vault");
        assertTrue(m.refundTo != evil);
        assertEq(m.providerPrice, PRICE);
        assertEq(m.verifierFee, FEE);
    }

    // ------------------------------------------------------------ limits
    function test_Vault_PerMissionCapEnforced() public {
        _vaultStd();
        IMissionEscrow.MissionParams memory p = _paramsFor(provider, 200e6, 1);
        vm.prank(executor);
        vm.expectRevert(IAgentBudgetVault.PerMissionCapExceeded.selector);
        vault.createMissionFor(operator, address(esc), p);
        // exactly at the cap is fine
        _vaultMission(200e6 - FEE, FEE);
        assertEq(vault.committedOf(operator), 200e6);
    }

    function test_Vault_TotalCapEnforcedAndNetOfRefunds() public {
        _vaultStd(); // total cap 500, per 200, daily 300
        _vaultMission(150e6, 0);
        // second at day 2 to dodge the daily cap
        vm.warp(block.timestamp + 1 days);
        _vaultMission(150e6, 0);
        vm.warp(block.timestamp + 1 days);
        _vaultMission(150e6, 0); // net 450
        IMissionEscrow.MissionParams memory p = _paramsFor(provider, 100e6, 0);
        vm.prank(executor);
        vm.expectRevert(IAgentBudgetVault.TotalCapExceeded.selector);
        vault.createMissionFor(operator, address(esc), p); // 550 > 500

        // cancel + reconcile the last mission -> net spent falls to 300 -> new 100 fits
        vm.prank(operator);
        vault.cancelUnassignedMission(address(esc), 3);
        vault.reconcile(address(esc), 3);
        assertEq(vault.netSpentOf(operator), 300e6);
        _vaultMission(100e6, 0);
        assertEq(vault.netSpentOf(operator), 400e6);
    }

    function test_Vault_DailyCapEnforcedAndResetsNextDay() public {
        _vaultStd(); // daily cap 300
        uint256 d0 = _day();
        _vaultMission(150e6, 0);
        _vaultMission(150e6, 0);
        IMissionEscrow.MissionParams memory p = _paramsFor(provider, 1, 0);
        vm.prank(executor);
        vm.expectRevert(IAgentBudgetVault.DailyCapExceeded.selector);
        vault.createMissionFor(operator, address(esc), p);
        assertEq(vault.dailySpentOf(operator, d0), 300e6);

        vm.warp((d0 + 1) * 1 days); // next UTC day
        _vaultMission(150e6, 0);
        assertEq(vault.dailySpentOf(operator, d0 + 1), 150e6);
        assertEq(vault.dailySpentOf(operator, d0), 300e6);
    }

    function test_Vault_ExpiredPolicyReverts() public {
        _vaultStd(); // expiry T0 + 20 days
        vm.warp(T0 + 20 days); // == expiry still valid
        _vaultMission(100e6, 0);
        vm.warp(T0 + 20 days + 1);
        IMissionEscrow.MissionParams memory p = _paramsFor(provider, 100e6, 0);
        vm.prank(executor);
        vm.expectRevert(IAgentBudgetVault.PolicyExpired.selector);
        vault.createMissionFor(operator, address(esc), p);
    }

    function test_Vault_PausedVaultRevertsAndUnpauseRestores() public {
        _vaultStd();
        vm.prank(operator);
        vault.setPaused(true);
        assertTrue(vault.policyOf(operator).paused);
        IMissionEscrow.MissionParams memory p = _paramsFor(provider, 100e6, 0);
        vm.prank(executor);
        vm.expectRevert(IAgentBudgetVault.PolicyPaused.selector);
        vault.createMissionFor(operator, address(esc), p);

        vm.prank(operator);
        vault.setPaused(false);
        _vaultMission(100e6, 0);
    }

    function test_Vault_NonExecutorCallerReverts() public {
        _vaultStd();
        IMissionEscrow.MissionParams memory p = _paramsFor(provider, 100e6, 0);
        address[3] memory callers = [stranger, operator, buyer];
        for (uint256 i = 0; i < callers.length; i++) {
            vm.prank(callers[i]);
            vm.expectRevert(IAgentBudgetVault.NotExecutor.selector);
            vault.createMissionFor(operator, address(esc), p);
        }
        // the executor of operator A cannot spend operator B's budget
        vm.prank(executor);
        vm.expectRevert(IAgentBudgetVault.NotExecutor.selector);
        vault.createMissionFor(stranger, address(esc), p);
    }

    function test_Vault_RevokedExecutorReverts() public {
        _vaultStd();
        vm.expectEmit(true, true, false, false, address(vault));
        emit IAgentBudgetVault.ExecutorRevoked(operator, executor);
        vm.prank(operator);
        vault.revokeExecutor();
        IMissionEscrow.MissionParams memory p = _paramsFor(provider, 100e6, 0);
        vm.prank(executor);
        vm.expectRevert(IAgentBudgetVault.NotExecutor.selector);
        vault.createMissionFor(operator, address(esc), p);
    }

    function test_Vault_NonAllowlistedEscrowReverts() public {
        _vaultFund(1000e6);
        vm.prank(operator);
        vault.setPolicy(executor, 200e6, 500e6, 300e6, uint64(T0 + 20 days));
        IMissionEscrow.MissionParams memory p = _paramsFor(provider, 100e6, 0);
        vm.prank(executor);
        vm.expectRevert(IAgentBudgetVault.EscrowNotAllowed.selector);
        vault.createMissionFor(operator, address(esc), p);
    }

    function test_Vault_UntrustedEscrowCannotBeAllowlisted() public {
        MissionEscrow rogue = new MissionEscrow(address(usdc), address(reg), arbiter);
        assertFalse(vault.isTrustedEscrow(address(rogue)));
        vm.prank(operator);
        vm.expectRevert(IAgentBudgetVault.EscrowNotTrusted.selector);
        vault.setEscrowAllowed(address(rogue), true);

        _vaultStd();
        IMissionEscrow.MissionParams memory p = _paramsFor(provider, 100e6, 0);
        vm.prank(executor);
        vm.expectRevert(IAgentBudgetVault.EscrowNotAllowed.selector);
        vault.createMissionFor(operator, address(rogue), p);
    }

    function test_Vault_ConstructorRejectsBadTrustedSets() public {
        address[] memory empty = new address[](0);
        vm.expectRevert(IAgentBudgetVault.EscrowNotTrusted.selector);
        new AgentBudgetVault(address(usdc), empty);

        address[] memory eoa = new address[](1);
        eoa[0] = stranger;
        vm.expectRevert(IAgentBudgetVault.EscrowNotTrusted.selector);
        new AgentBudgetVault(address(usdc), eoa);

        MissionEscrow wrongToken = new MissionEscrow(address(0xBEEF), address(reg), arbiter);
        address[] memory wt = new address[](1);
        wt[0] = address(wrongToken);
        vm.expectRevert(IAgentBudgetVault.EscrowNotTrusted.selector);
        new AgentBudgetVault(address(usdc), wt);
    }

    function test_Vault_InsufficientAvailableReverts() public {
        _vaultFund(50e6);
        _vaultPolicy(200e6, 500e6, 300e6);
        IMissionEscrow.MissionParams memory p = _paramsFor(provider, 100e6, 0);
        vm.prank(executor);
        vm.expectRevert(IAgentBudgetVault.InsufficientAvailable.selector);
        vault.createMissionFor(operator, address(esc), p);
    }

    // ------------------------------------------------------------ withdrawals
    function test_Vault_ExecutorCannotWithdraw() public {
        _vaultStd();
        vm.prank(executor);
        vm.expectRevert(IAgentBudgetVault.InsufficientAvailable.selector);
        vault.withdrawAvailable(1, executor);
        assertEq(vault.availableOf(operator), 1000e6);
        assertEq(usdc.balanceOf(executor), 0);
    }

    function test_Vault_OperatorReclaimsUncommittedOnly() public {
        _vaultStd();
        _vaultMission(PRICE, FEE); // 105 committed, 895 available
        address to = makeAddr("opWallet");
        vm.startPrank(operator);
        vm.expectRevert(IAgentBudgetVault.InsufficientAvailable.selector);
        vault.withdrawAvailable(895e6 + 1, to);
        vm.expectRevert(IAgentBudgetVault.ZeroAmount.selector);
        vault.withdrawAvailable(0, to);
        vm.expectRevert(IAgentBudgetVault.NotOperatorPolicy.selector);
        vault.withdrawAvailable(1, address(0));

        vm.expectEmit(true, true, false, true, address(vault));
        emit IAgentBudgetVault.WithdrawnByOperator(operator, to, 895e6);
        vault.withdrawAvailable(895e6, to);
        vm.stopPrank();
        assertEq(usdc.balanceOf(to), 895e6);
        assertEq(vault.availableOf(operator), 0);
        assertEq(vault.committedOf(operator), TOTAL, "committed funds untouched");
        assertEq(vault.totalHeld(), TOTAL);
    }

    function test_Vault_OperatorReclaimWorksWhilePausedExpiredAndRevoked() public {
        _vaultStd();
        _vaultMission(PRICE, FEE);
        vm.startPrank(operator);
        vault.setPaused(true);
        vault.revokeExecutor();
        vm.stopPrank();
        vm.warp(T0 + 40 days);
        vm.prank(operator);
        vault.withdrawAvailable(500e6, operator);
        assertEq(usdc.balanceOf(operator), 500e6);
        assertEq(vault.availableOf(operator), 395e6);
        assertEq(vault.committedOf(operator), TOTAL);
    }

    // ------------------------------------------------------------ rejected refund -> reconcile
    function _vaultRejectedSettled() internal returns (uint256 id) {
        _vaultStd();
        id = _vaultMission(PRICE, FEE);
        _assign(esc, id);
        _submitOn(esc, id);
        _verdictOn(esc, id, 2);
        _skipPastWindow(id);
        esc.finalize(id);
    }

    function test_Vault_RejectedRefund_ClaimThenReconcileRestoresAvailable() public {
        uint256 id = _vaultRejectedSettled();
        IMissionEscrow.Mission memory m = esc.getMission(id);
        assertEq(uint8(m.outcome), uint8(IMissionEscrow.Outcome.BuyerRefunded));
        assertEq(esc.credits(verifier), FEE, "verifier still paid");
        assertEq(vault.availableOf(operator), 1000e6 - TOTAL);

        vm.prank(stranger);
        esc.claimRefund(id); // refund lands in the vault (refundTo)
        assertEq(usdc.balanceOf(address(vault)), 1000e6 - TOTAL + PRICE);
        assertEq(vault.availableOf(operator), 1000e6 - TOTAL, "not credited until reconcile");

        vm.expectEmit(true, true, true, true, address(vault));
        emit IAgentBudgetVault.MissionReconciled(operator, address(esc), id, TOTAL, PRICE);
        vault.reconcile(address(esc), id);

        assertEq(vault.availableOf(operator), 1000e6 - TOTAL + PRICE);
        assertEq(vault.committedOf(operator), 0);
        assertEq(vault.missionCommitted(address(esc), id), 0);
        assertEq(vault.netSpentOf(operator), FEE, "only the verifier fee remains net spent");
        assertEq(vault.totalHeld(), 1000e6 - FEE);
        assertEq(usdc.balanceOf(address(vault)), vault.totalHeld() - 0);
    }

    function test_Vault_ReconcileClaimsRefundItselfWhenUnclaimed() public {
        uint256 id = _vaultRejectedSettled();
        vault.reconcile(address(esc), id);
        assertTrue(esc.refundClaimed(id));
        assertEq(vault.availableOf(operator), 1000e6 - FEE);
        assertEq(usdc.balanceOf(address(vault)), 1000e6 - FEE);
    }

    function test_Vault_ReconcileRevertsBeforeTerminalAndForUnknown() public {
        _vaultStd();
        uint256 id = _vaultMission(PRICE, FEE);
        vm.expectRevert(IAgentBudgetVault.MissionNotTerminal.selector);
        vault.reconcile(address(esc), id);
        vm.expectRevert(IAgentBudgetVault.UnknownMission.selector);
        vault.reconcile(address(esc), 999);
    }

    function test_Vault_AcceptedMissionReconcilesWithNoRefund() public {
        _vaultStd();
        uint256 id = _vaultMission(PRICE, FEE);
        _assign(esc, id);
        _submitOn(esc, id);
        _verdictOn(esc, id, 1);
        _skipPastWindow(id);
        esc.finalize(id);
        vault.reconcile(address(esc), id);
        assertEq(vault.availableOf(operator), 1000e6 - TOTAL);
        assertEq(vault.committedOf(operator), 0);
        assertEq(vault.totalHeld(), 1000e6 - TOTAL, "paid-out amount leaves the vault books");
        assertEq(vault.netSpentOf(operator), TOTAL);
    }

    function test_Vault_ReconcileAfterExternalClaimCreditsWithoutSecondTransfer() public {
        _vaultStd();
        uint256 id = _vaultMission(PRICE, FEE);
        vm.warp(esc.getMission(id).deadline + 1);
        esc.expire(id);
        esc.claimRefund(id); // third party triggers claim into vault
        uint256 bal = usdc.balanceOf(address(vault));
        vault.reconcile(address(esc), id);
        assertEq(usdc.balanceOf(address(vault)), bal, "no extra transfer");
        assertEq(vault.availableOf(operator), 1000e6);
    }

    function test_Vault_OperatorProxiesChallengeAndCancelOnlyForOwnMissions() public {
        _vaultStd();
        uint256 id = _vaultMission(PRICE, FEE);
        vm.prank(stranger);
        vm.expectRevert(IAgentBudgetVault.NotMissionOperator.selector);
        vault.cancelUnassignedMission(address(esc), id);
        vm.prank(executor);
        vm.expectRevert(IAgentBudgetVault.NotMissionOperator.selector);
        vault.cancelUnassignedMission(address(esc), id);

        _assign(esc, id);
        _submitOn(esc, id);
        _verdictOn(esc, id, 1);
        vm.prank(stranger);
        vm.expectRevert(IAgentBudgetVault.NotMissionOperator.selector);
        vault.challengeMission(address(esc), id);
        vm.prank(operator);
        vault.challengeMission(address(esc), id);
        assertEq(uint8(_status(id)), uint8(IMissionEscrow.Status.Challenged));
    }
}
