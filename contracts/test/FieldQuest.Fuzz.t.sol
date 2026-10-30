// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {FQBase} from "./FieldQuest.Base.t.sol";
import {MissionEscrow} from "../MissionEscrow.sol";
import {IMissionEscrow} from "../interfaces/IMissionEscrow.sol";
import {IAgentBudgetVault} from "../interfaces/IAgentBudgetVault.sol";

/// @dev Fuzzed amounts, caps and windows.
contract FQFuzzTest is FQBase {
    function _createWith(uint128 price, uint128 fee, uint32 window) internal returns (uint256 id) {
        IMissionEscrow.MissionParams memory p = _paramsFor(provider, price, fee);
        p.challengeWindow = window;
        vm.prank(buyer);
        id = esc.createMission(p);
    }

    function testFuzz_CreateMission_PullsExactPriceAndFee(uint128 price, uint128 fee) public {
        price = uint128(bound(price, 1, 1e11));
        fee = uint128(bound(fee, 0, 1e11));
        uint256 b0 = usdc.balanceOf(buyer);
        _createWith(price, fee, 1 days);
        assertEq(b0 - usdc.balanceOf(buyer), uint256(price) + fee);
        assertEq(usdc.balanceOf(address(esc)), uint256(price) + fee);
        assertEq(esc.totalLiabilities(), uint256(price) + fee);
    }

    /// @dev Whatever the amounts / verdict, every base unit is paid out exactly once and the escrow drains to zero.
    function testFuzz_SettlementConservesFunds(uint128 price, uint128 fee, bool accept) public {
        price = uint128(bound(price, 1, 1e11));
        fee = uint128(bound(fee, 0, 1e11));
        uint256 buyerBefore = usdc.balanceOf(buyer);
        uint256 id = _createWith(price, fee, 1 days);
        _assign(esc, id);
        _submitOn(esc, id);
        _verdictOn(esc, id, accept ? 1 : 2);
        _skipPastWindow(id);
        esc.finalize(id);

        assertEq(esc.credits(provider) + esc.credits(verifier) + esc.refundAmount(id), uint256(price) + fee);
        assertEq(esc.credits(provider), accept ? price : 0);
        assertEq(esc.credits(verifier), fee);
        assertEq(esc.refundAmount(id), accept ? 0 : price);

        if (accept) {
            vm.prank(provider);
            esc.withdraw(providerWallet);
        }
        if (fee > 0) {
            vm.prank(verifier);
            esc.withdraw(verifier);
        }
        if (!accept) esc.claimRefund(id);

        assertEq(usdc.balanceOf(address(esc)), 0, "escrow fully drained");
        assertEq(esc.totalLiabilities(), 0);
        assertEq(usdc.balanceOf(providerWallet), accept ? price : 0);
        assertEq(usdc.balanceOf(verifier), fee);
        assertEq(buyerBefore - usdc.balanceOf(buyer), (accept ? uint256(price) : 0) + fee);
    }

    function testFuzz_ChallengeWindowBoundary(uint32 window, uint32 delta) public {
        window = uint32(bound(window, 0, 3 days));
        delta = uint32(bound(delta, 0, 4 days));
        uint256 id = _createWith(PRICE, FEE, window);
        _assign(esc, id);
        _submitOn(esc, id);
        _verdictOn(esc, id, 1);
        vm.warp(block.timestamp + delta);
        vm.prank(buyer);
        if (delta < window) {
            esc.challenge(id);
            assertEq(uint8(_status(id)), uint8(IMissionEscrow.Status.Challenged));
        } else {
            vm.expectRevert(MissionEscrow.ChallengeWindowClosed.selector);
            esc.challenge(id);
            esc.finalize(id);
            assertEq(esc.credits(provider), PRICE);
        }
    }

    function testFuzz_VaultCaps(uint128 perCap, uint128 totalCap, uint128 dailyCap, uint128 price, uint128 fee) public {
        perCap = uint128(bound(perCap, 1, 1e9));
        totalCap = uint128(bound(totalCap, perCap, 2e9));
        dailyCap = uint128(bound(dailyCap, 0, 2e9));
        price = uint128(bound(price, 1, 1e9));
        fee = uint128(bound(fee, 0, 1e9));
        uint256 total = uint256(price) + fee;
        _vaultFund(3e9);
        _vaultPolicy(perCap, totalCap, dailyCap);

        IMissionEscrow.MissionParams memory p = _paramsFor(provider, price, fee);
        vm.prank(executor);
        if (total > perCap) {
            vm.expectRevert(IAgentBudgetVault.PerMissionCapExceeded.selector);
        } else if (total > totalCap) {
            vm.expectRevert(IAgentBudgetVault.TotalCapExceeded.selector);
        } else if (total > dailyCap) {
            vm.expectRevert(IAgentBudgetVault.DailyCapExceeded.selector);
        }
        uint256 id = vault.createMissionFor(operator, address(esc), p);

        if (total <= perCap && total <= dailyCap) {
            assertEq(id, 1);
            assertEq(usdc.balanceOf(address(esc)), total, "escrow funded with exactly price+fee");
            assertEq(vault.availableOf(operator), 3e9 - total);
            assertEq(esc.getMission(id).refundTo, address(vault));
        } else {
            assertEq(esc.missionCount(), 0);
            assertEq(vault.availableOf(operator), 3e9);
        }
    }

    function testFuzz_VaultDepositWithdrawRoundTrip(uint128 amount, uint128 part) public {
        amount = uint128(bound(amount, 1, 1e12));
        part = uint128(bound(part, 1, amount));
        _vaultFund(amount);
        assertEq(vault.availableOf(operator), amount);
        vm.prank(operator);
        vault.withdrawAvailable(part, operator);
        assertEq(usdc.balanceOf(operator), part);
        assertEq(vault.availableOf(operator), amount - part);
        assertEq(vault.totalHeld(), amount - part);
        assertEq(usdc.balanceOf(address(vault)), amount - part);
    }

    function testFuzz_VaultDailyCapResetsAtUtcDayBoundary(uint32 offset) public {
        offset = uint32(bound(offset, 0, 5 days));
        _vaultFund(1000e6);
        _vaultPolicy(200e6, 1000e6, 200e6);
        _vaultMission(200e6, 0);
        // inside the same UTC day the cap blocks; on a later day it resets
        uint256 t = block.timestamp + offset;
        bool sameDay = t / 1 days == block.timestamp / 1 days;
        vm.warp(t);
        IMissionEscrow.MissionParams memory p = _paramsFor(provider, 1, 0);
        vm.prank(executor);
        if (sameDay) vm.expectRevert(IAgentBudgetVault.DailyCapExceeded.selector);
        vault.createMissionFor(operator, address(esc), p);
    }
}
