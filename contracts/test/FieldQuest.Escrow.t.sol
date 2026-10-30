// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {FQBase} from "./FieldQuest.Base.t.sol";
import {MissionEscrow} from "../MissionEscrow.sol";
import {IMissionEscrow} from "../interfaces/IMissionEscrow.sol";
import {IEvidenceRegistry} from "../interfaces/IEvidenceRegistry.sol";

/// @dev Mission creation, funding, payout, refund and expiry flows.
contract FQEscrowTest is FQBase {
    // ------------------------------------------------------------ creation / funding
    function test_CreateMission_PullsExactUsdc() public {
        uint256 b0 = usdc.balanceOf(buyer);
        IMissionEscrow.MissionParams memory p = _params();

        vm.expectEmit(true, true, true, true, address(esc));
        emit IMissionEscrow.MissionCreated(
            1, buyer, provider, verifier, buyer, TILE, OBJ, p.quoteHash, PRICE, FEE, p.deadline
        );
        vm.prank(buyer);
        uint256 id = esc.createMission(p);

        assertEq(id, 1);
        assertEq(b0 - usdc.balanceOf(buyer), uint256(PRICE) + FEE, "buyer paid exactly price+fee");
        assertEq(usdc.balanceOf(address(esc)), uint256(PRICE) + FEE);
        assertEq(esc.totalLiabilities(), uint256(PRICE) + FEE);
        IMissionEscrow.Mission memory m = esc.getMission(id);
        assertEq(uint8(m.status), uint8(IMissionEscrow.Status.Funded));
        assertEq(m.buyer, buyer);
        assertEq(m.refundTo, buyer);
        assertEq(m.createdAt, T0);
        assertEq(esc.missionCount(), 1);
    }

    function test_CreateMission_RevertsWithoutAllowance() public {
        vm.prank(buyer);
        usdc.approve(address(esc), 0);
        IMissionEscrow.MissionParams memory p = _params();
        vm.prank(buyer);
        vm.expectRevert();
        esc.createMission(p);
    }

    function test_CreateMission_RevertsZeroAddresses() public {
        IMissionEscrow.MissionParams memory p = _params();
        p.provider = address(0);
        vm.prank(buyer);
        vm.expectRevert(MissionEscrow.ZeroAddress.selector);
        esc.createMission(p);

        p = _params();
        p.verifier = address(0);
        vm.prank(buyer);
        vm.expectRevert(MissionEscrow.ZeroAddress.selector);
        esc.createMission(p);

        p = _params();
        p.refundTo = address(0);
        vm.prank(buyer);
        vm.expectRevert(MissionEscrow.ZeroAddress.selector);
        esc.createMission(p);
    }

    function test_CreateMission_RevertsInvalidParticipants() public {
        IMissionEscrow.MissionParams memory p = _params();
        p.verifier = provider;
        vm.prank(buyer);
        vm.expectRevert(MissionEscrow.InvalidParticipants.selector);
        esc.createMission(p);

        p = _params();
        vm.prank(provider);
        vm.expectRevert(MissionEscrow.InvalidParticipants.selector);
        esc.createMission(p);

        p = _params();
        vm.prank(verifier);
        vm.expectRevert(MissionEscrow.InvalidParticipants.selector);
        esc.createMission(p);
    }

    function test_CreateMission_RevertsInvalidParameters() public {
        IMissionEscrow.MissionParams memory p = _params();
        p.providerPrice = 0;
        vm.prank(buyer);
        vm.expectRevert(MissionEscrow.InvalidMissionParameters.selector);
        esc.createMission(p);

        p = _params();
        p.tileId = bytes32(0);
        vm.prank(buyer);
        vm.expectRevert(MissionEscrow.InvalidMissionParameters.selector);
        esc.createMission(p);

        p = _params();
        p.objectiveHash = bytes32(0);
        vm.prank(buyer);
        vm.expectRevert(MissionEscrow.InvalidMissionParameters.selector);
        esc.createMission(p);

        p = _params();
        p.maxReadingAge = 0;
        vm.prank(buyer);
        vm.expectRevert(MissionEscrow.InvalidMissionParameters.selector);
        esc.createMission(p);

        p = _params();
        p.challengeWindow = esc.MAX_CHALLENGE_WINDOW() + 1;
        vm.prank(buyer);
        vm.expectRevert(MissionEscrow.InvalidMissionParameters.selector);
        esc.createMission(p);
    }

    function test_CreateMission_DeadlineBounds() public {
        IMissionEscrow.MissionParams memory p = _params();
        p.deadline = uint64(block.timestamp + 60); // must be strictly more than 60s
        vm.prank(buyer);
        vm.expectRevert(MissionEscrow.InvalidDeadline.selector);
        esc.createMission(p);

        p.deadline = uint64(block.timestamp + 61);
        vm.prank(buyer);
        esc.createMission(p);

        p.deadline = uint64(block.timestamp + 30 days + 1);
        vm.prank(buyer);
        vm.expectRevert(MissionEscrow.InvalidDeadline.selector);
        esc.createMission(p);

        p.deadline = uint64(block.timestamp + 30 days);
        vm.prank(buyer);
        esc.createMission(p);
    }

    function test_CreateMission_ZeroFeeAllowed() public {
        IMissionEscrow.MissionParams memory p = _paramsFor(provider, PRICE, 0);
        vm.prank(buyer);
        uint256 id = esc.createMission(p);
        assertEq(esc.totalLiabilities(), PRICE);
        assertEq(uint8(_status(id)), uint8(IMissionEscrow.Status.Funded));
    }

    function test_UnknownMissionReverts() public {
        vm.expectRevert(abi.encodeWithSelector(MissionEscrow.UnknownMission.selector, 99));
        esc.getMission(99);
        vm.prank(provider);
        vm.expectRevert(abi.encodeWithSelector(MissionEscrow.UnknownMission.selector, 99));
        esc.acceptAssignment(99);
    }

    // ------------------------------------------------------------ assignment / evidence
    function test_AcceptAssignment_OnlyProviderBeforeDeadline() public {
        uint256 id = _create();
        vm.prank(stranger);
        vm.expectRevert(MissionEscrow.Unauthorized.selector);
        esc.acceptAssignment(id);

        vm.expectEmit(true, true, false, false, address(esc));
        emit IMissionEscrow.MissionAssigned(id, provider);
        vm.prank(provider);
        esc.acceptAssignment(id);
        assertEq(uint8(_status(id)), uint8(IMissionEscrow.Status.Assigned));
        assertEq(esc.getMission(id).assignedAt, T0);
    }

    function test_AcceptAssignment_RevertsAtDeadline() public {
        uint256 id = _create();
        vm.warp(esc.getMission(id).deadline);
        vm.prank(provider);
        vm.expectRevert(MissionEscrow.DeadlineReached.selector);
        esc.acceptAssignment(id);
    }

    function test_SubmitEvidence_HappyPathEmitsAndStores() public {
        uint256 id = _toAssigned();
        IEvidenceRegistry.Reading memory r = _reading(id);
        bytes memory sig = _signReading(sensorPk, r);
        bytes32 digest = reg.hashReading(r);

        vm.expectEmit(true, true, false, true, address(esc));
        emit IMissionEscrow.EvidenceSubmitted(id, provider, EVID, digest, sensor, r.observedAt, r.value, UNIT, r.nonce, r.payloadHash);
        vm.prank(provider);
        esc.submitEvidence(id, EVID, r, sig);

        IMissionEscrow.Mission memory m = esc.getMission(id);
        assertEq(uint8(m.status), uint8(IMissionEscrow.Status.Submitted));
        assertEq(m.evidenceHash, EVID);
        assertEq(m.readingCommitment, digest);
        assertTrue(reg.nonceUsed(address(esc), sensor, r.nonce), "registry consumed the sensor nonce");
    }

    function test_SubmitEvidence_Reverts() public {
        uint256 id = _create();
        IEvidenceRegistry.Reading memory r = _reading(id);
        bytes memory sig = _signReading(sensorPk, r);
        // wrong status (Funded)
        vm.prank(provider);
        vm.expectRevert(abi.encodeWithSelector(MissionEscrow.InvalidStatus.selector, id, IMissionEscrow.Status.Funded));
        esc.submitEvidence(id, EVID, r, sig);

        _assign(esc, id);
        vm.prank(stranger);
        vm.expectRevert(MissionEscrow.Unauthorized.selector);
        esc.submitEvidence(id, EVID, r, sig);

        vm.prank(provider);
        vm.expectRevert(MissionEscrow.EmptyEvidence.selector);
        esc.submitEvidence(id, bytes32(0), r, sig);

        vm.warp(esc.getMission(id).deadline + 1);
        vm.prank(provider);
        vm.expectRevert(MissionEscrow.DeadlineReached.selector);
        esc.submitEvidence(id, EVID, r, sig);
    }

    // ------------------------------------------------------------ accepted payout end to end
    function test_AcceptedPayout_EndToEnd() public {
        uint256 buyerBefore = usdc.balanceOf(buyer);
        uint256 id = _toAccepted();
        assertEq(uint8(_status(id)), uint8(IMissionEscrow.Status.Accepted));
        assertEq(esc.getMission(id).challengeEndsAt, T0 + 1 days);

        // Cannot finalize while the challenge window is open.
        vm.expectRevert(MissionEscrow.ChallengeWindowOpen.selector);
        esc.finalize(id);

        vm.warp(T0 + 1 days);
        vm.expectEmit(true, false, false, true, address(esc));
        emit IMissionEscrow.MissionSettled(id, IMissionEscrow.Outcome.ProviderPaid, PRICE, FEE, 0);
        esc.finalize(id);

        assertEq(uint8(_status(id)), uint8(IMissionEscrow.Status.Settled));
        assertEq(uint8(esc.getMission(id).outcome), uint8(IMissionEscrow.Outcome.ProviderPaid));
        assertEq(esc.credits(provider), PRICE);
        assertEq(esc.credits(verifier), FEE);
        assertEq(esc.refundAmount(id), 0);
        // Settlement only reclassifies: no USDC has moved yet.
        assertEq(usdc.balanceOf(address(esc)), uint256(PRICE) + FEE);
        assertEq(esc.totalLiabilities(), uint256(PRICE) + FEE);

        // Provider withdraws to a different wallet: ACTUAL USDC moves.
        vm.expectEmit(true, true, false, true, address(esc));
        emit IMissionEscrow.Withdrawn(provider, providerWallet, PRICE);
        vm.prank(provider);
        assertEq(esc.withdraw(providerWallet), PRICE);
        assertEq(usdc.balanceOf(providerWallet), PRICE);
        assertEq(usdc.balanceOf(provider), 0);
        assertEq(esc.credits(provider), 0);
        assertEq(usdc.balanceOf(address(esc)), FEE);
        assertEq(esc.totalLiabilities(), FEE);

        vm.prank(verifier);
        esc.withdraw(verifier);
        assertEq(usdc.balanceOf(verifier), FEE);
        assertEq(usdc.balanceOf(address(esc)), 0);
        assertEq(esc.totalLiabilities(), 0);
        assertEq(buyerBefore - usdc.balanceOf(buyer), uint256(PRICE) + FEE, "buyer net cost = price + fee");
    }

    function test_Withdraw_RevertsZeroToAndNothing() public {
        vm.prank(provider);
        vm.expectRevert(MissionEscrow.NothingToWithdraw.selector);
        esc.withdraw(provider);
        vm.prank(provider);
        vm.expectRevert(MissionEscrow.ZeroAddress.selector);
        esc.withdraw(address(0));
    }

    // ------------------------------------------------------------ rejected refund
    function test_RejectedRefund_BuyerRefundedVerifierPaid() public {
        uint256 buyerBefore = usdc.balanceOf(buyer);
        uint256 id = _toRejected();
        assertEq(uint8(_status(id)), uint8(IMissionEscrow.Status.Rejected));
        _skipPastWindow(id);

        vm.expectEmit(true, false, false, true, address(esc));
        emit IMissionEscrow.MissionSettled(id, IMissionEscrow.Outcome.BuyerRefunded, 0, FEE, PRICE);
        esc.finalize(id);

        assertEq(uint8(esc.getMission(id).outcome), uint8(IMissionEscrow.Outcome.BuyerRefunded));
        assertEq(esc.credits(provider), 0);
        assertEq(esc.credits(verifier), FEE, "verifier still paid on reject");
        assertEq(esc.refundAmount(id), PRICE);

        // anyone may relay the claim; money only goes to refundTo (buyer)
        vm.expectEmit(true, true, false, true, address(esc));
        emit IMissionEscrow.RefundClaimed(id, buyer, PRICE);
        vm.prank(stranger);
        assertEq(esc.claimRefund(id), PRICE);
        assertEq(usdc.balanceOf(stranger), 0);
        assertEq(buyerBefore - usdc.balanceOf(buyer), FEE);
        assertTrue(esc.refundClaimed(id));

        vm.prank(verifier);
        esc.withdraw(verifier);
        assertEq(usdc.balanceOf(address(esc)), 0);
        assertEq(esc.totalLiabilities(), 0);
    }

    function test_ClaimRefund_Reverts() public {
        uint256 id = _toAccepted();
        vm.expectRevert(MissionEscrow.MissionNotTerminal.selector);
        esc.claimRefund(id);
        _skipPastWindow(id);
        esc.finalize(id);
        vm.expectRevert(MissionEscrow.NothingToRefund.selector);
        esc.claimRefund(id); // provider paid in full, no refund
    }

    function test_RedirectRefund_BuyerOnlyBeforeClaim() public {
        uint256 id = _toRejected();
        _skipPastWindow(id);
        esc.finalize(id);
        address newTo = makeAddr("newRefundTo");

        vm.prank(stranger);
        vm.expectRevert(MissionEscrow.Unauthorized.selector);
        esc.redirectRefund(id, newTo);
        vm.prank(arbiter);
        vm.expectRevert(MissionEscrow.Unauthorized.selector);
        esc.redirectRefund(id, newTo);
        vm.prank(buyer);
        vm.expectRevert(MissionEscrow.ZeroAddress.selector);
        esc.redirectRefund(id, address(0));

        vm.expectEmit(true, true, false, false, address(esc));
        emit IMissionEscrow.RefundRedirected(id, newTo);
        vm.prank(buyer);
        esc.redirectRefund(id, newTo);

        esc.claimRefund(id);
        assertEq(usdc.balanceOf(newTo), PRICE);

        vm.prank(buyer);
        vm.expectRevert(MissionEscrow.RefundAlreadyClaimed.selector);
        esc.redirectRefund(id, buyer);
    }

    // ------------------------------------------------------------ expiry / cancel
    function test_Expire_FundedAfterDeadlineRefundsAll() public {
        uint256 id = _create();
        uint64 dl = esc.getMission(id).deadline;
        vm.warp(dl); // exactly at deadline is NOT expired
        vm.expectRevert(MissionEscrow.DeadlineNotPassed.selector);
        esc.expire(id);

        vm.warp(dl + 1);
        vm.expectEmit(true, false, false, true, address(esc));
        emit IMissionEscrow.MissionExpired(id, uint256(PRICE) + FEE);
        esc.expire(id);
        assertEq(uint8(_status(id)), uint8(IMissionEscrow.Status.Expired));
        assertEq(uint8(esc.getMission(id).outcome), uint8(IMissionEscrow.Outcome.Expired));
        assertEq(esc.refundAmount(id), uint256(PRICE) + FEE);

        uint256 b0 = usdc.balanceOf(buyer);
        esc.claimRefund(id);
        assertEq(usdc.balanceOf(buyer) - b0, uint256(PRICE) + FEE);
        assertEq(esc.totalLiabilities(), 0);
    }

    function test_Expire_AssignedAfterDeadline() public {
        uint256 id = _toAssigned();
        vm.warp(esc.getMission(id).deadline + 1);
        esc.expire(id);
        assertEq(uint8(_status(id)), uint8(IMissionEscrow.Status.Expired));
        assertEq(esc.refundAmount(id), uint256(PRICE) + FEE);
    }

    function test_Expire_RevertsForSubmitted() public {
        uint256 id = _toSubmitted();
        vm.warp(esc.getMission(id).deadline + 1);
        vm.expectRevert(abi.encodeWithSelector(MissionEscrow.InvalidStatus.selector, id, IMissionEscrow.Status.Submitted));
        esc.expire(id);
    }

    function test_CancelUnassigned_BuyerOnlyFullRefund() public {
        uint256 id = _create();
        vm.prank(stranger);
        vm.expectRevert(MissionEscrow.Unauthorized.selector);
        esc.cancelUnassigned(id);

        vm.prank(buyer);
        esc.cancelUnassigned(id);
        assertEq(uint8(_status(id)), uint8(IMissionEscrow.Status.Expired));
        uint256 b0 = usdc.balanceOf(buyer);
        esc.claimRefund(id);
        assertEq(usdc.balanceOf(buyer) - b0, uint256(PRICE) + FEE);
    }

    function test_CancelUnassigned_RevertsOnceAssigned() public {
        uint256 id = _toAssigned();
        vm.prank(buyer);
        vm.expectRevert(abi.encodeWithSelector(MissionEscrow.InvalidStatus.selector, id, IMissionEscrow.Status.Assigned));
        esc.cancelUnassigned(id);
    }
}
