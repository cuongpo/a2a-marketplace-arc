// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {FQBase} from "./FieldQuest.Base.t.sol";
import {MissionEscrow} from "../MissionEscrow.sol";
import {IMissionEscrow} from "../interfaces/IMissionEscrow.sol";

/// @dev Challenges, arbiter resolution, stale escalation and the resolveByTimeout table.
contract FQDisputeTest is FQBase {
    IMissionEscrow.Status internal constant CHALLENGED = IMissionEscrow.Status.Challenged;

    function _assertConserved(uint256 id) internal view {
        assertEq(
            esc.credits(provider) + esc.credits(verifier) + esc.refundAmount(id),
            uint256(PRICE) + FEE,
            "price+fee conserved"
        );
    }

    // ------------------------------------------------------------ buyer challenges accept
    function test_Dispute_BuyerChallengesAccept() public {
        uint256 id = _toAccepted();
        vm.expectEmit(true, true, false, false, address(esc));
        emit IMissionEscrow.MissionChallenged(id, buyer);
        vm.prank(buyer);
        esc.challenge(id);
        assertEq(uint8(_status(id)), uint8(CHALLENGED));
        assertEq(esc.getMission(id).challengedAt, block.timestamp);
        // finalize no longer possible
        vm.warp(T0 + 5 days);
        vm.expectRevert(abi.encodeWithSelector(MissionEscrow.InvalidStatus.selector, id, CHALLENGED));
        esc.finalize(id);
    }

    function test_Dispute_ArbiterResolvesProviderWins() public {
        uint256 id = _toChallengedAccept();
        vm.expectEmit(true, true, false, true, address(esc));
        emit IMissionEscrow.ArbiterResolved(id, arbiter, true);
        vm.prank(arbiter);
        esc.resolve(id, true);
        assertEq(uint8(esc.getMission(id).outcome), uint8(IMissionEscrow.Outcome.ProviderPaid));
        assertEq(esc.credits(provider), PRICE);
        assertEq(esc.credits(verifier), FEE);
        assertEq(esc.refundAmount(id), 0);
        _assertConserved(id);
    }

    function test_Dispute_ArbiterResolvesBuyerWins() public {
        uint256 id = _toChallengedAccept();
        vm.prank(arbiter);
        esc.resolve(id, false);
        assertEq(uint8(esc.getMission(id).outcome), uint8(IMissionEscrow.Outcome.BuyerRefunded));
        assertEq(esc.credits(provider), 0);
        assertEq(esc.credits(verifier), FEE, "verifier delivered a signed verdict");
        assertEq(esc.refundAmount(id), PRICE);
        _assertConserved(id);
        uint256 b0 = usdc.balanceOf(buyer);
        esc.claimRefund(id);
        assertEq(usdc.balanceOf(buyer) - b0, PRICE);
    }

    function test_Dispute_OnlyArbiterCanResolve() public {
        uint256 id = _toChallengedAccept();
        address[4] memory callers = [buyer, provider, verifier, stranger];
        for (uint256 i = 0; i < callers.length; i++) {
            vm.prank(callers[i]);
            vm.expectRevert(MissionEscrow.Unauthorized.selector);
            esc.resolve(id, true);
        }
        assertEq(uint8(_status(id)), uint8(CHALLENGED));
    }

    function test_Dispute_ResolveRevertsIfNotChallenged() public {
        uint256 id = _toAccepted();
        vm.prank(arbiter);
        vm.expectRevert(
            abi.encodeWithSelector(MissionEscrow.InvalidStatus.selector, id, IMissionEscrow.Status.Accepted)
        );
        esc.resolve(id, true);
    }

    function test_Dispute_ResolveTwiceReverts() public {
        uint256 id = _toChallengedAccept();
        vm.startPrank(arbiter);
        esc.resolve(id, true);
        vm.expectRevert(
            abi.encodeWithSelector(MissionEscrow.InvalidStatus.selector, id, IMissionEscrow.Status.Settled)
        );
        esc.resolve(id, false);
        vm.stopPrank();
        assertEq(esc.credits(provider), PRICE);
    }

    // ------------------------------------------------------------ challenge window / who may challenge
    function test_Dispute_ChallengeAllowedOneSecondBeforeWindowEnd() public {
        uint256 id = _toAccepted();
        vm.warp(esc.getMission(id).challengeEndsAt - 1);
        vm.prank(buyer);
        esc.challenge(id);
        assertEq(uint8(_status(id)), uint8(CHALLENGED));
    }

    function test_Dispute_ChallengeRevertsAtWindowEnd() public {
        uint256 id = _toAccepted();
        vm.warp(esc.getMission(id).challengeEndsAt);
        vm.prank(buyer);
        vm.expectRevert(MissionEscrow.ChallengeWindowClosed.selector);
        esc.challenge(id);
        // and finalize is allowed exactly at the end
        esc.finalize(id);
    }

    function test_Dispute_FinalizeRevertsOneSecondBeforeWindowEnd() public {
        uint256 id = _toRejected();
        vm.warp(esc.getMission(id).challengeEndsAt - 1);
        vm.expectRevert(MissionEscrow.ChallengeWindowOpen.selector);
        esc.finalize(id);
    }

    function test_Dispute_WhoMayChallengeAccepted_OnlyBuyer() public {
        uint256 id = _toAccepted();
        address[4] memory no = [provider, verifier, arbiter, stranger];
        for (uint256 i = 0; i < no.length; i++) {
            vm.prank(no[i]);
            vm.expectRevert(MissionEscrow.Unauthorized.selector);
            esc.challenge(id);
        }
        vm.prank(buyer);
        esc.challenge(id);
    }

    function test_Dispute_WhoMayChallengeRejected_OnlyProvider() public {
        uint256 id = _toRejected();
        address[4] memory no = [buyer, verifier, arbiter, stranger];
        for (uint256 i = 0; i < no.length; i++) {
            vm.prank(no[i]);
            vm.expectRevert(MissionEscrow.Unauthorized.selector);
            esc.challenge(id);
        }
        vm.expectEmit(true, true, false, false, address(esc));
        emit IMissionEscrow.MissionChallenged(id, provider);
        vm.prank(provider);
        esc.challenge(id);
    }

    function test_Dispute_ChallengeRevertsInWrongStatus() public {
        uint256 id = _toSubmitted();
        vm.prank(buyer);
        vm.expectRevert(
            abi.encodeWithSelector(MissionEscrow.InvalidStatus.selector, id, IMissionEscrow.Status.Submitted)
        );
        esc.challenge(id);
    }

    function test_Dispute_ProviderChallengesRejectAndWins() public {
        uint256 id = _toRejected();
        vm.prank(provider);
        esc.challenge(id);
        vm.prank(arbiter);
        esc.resolve(id, true);
        assertEq(esc.credits(provider), PRICE);
        assertEq(esc.credits(verifier), FEE);
        assertEq(esc.refundAmount(id), 0);
        _assertConserved(id);
    }

    function test_Dispute_ProviderChallengesRejectAndLoses() public {
        uint256 id = _toRejected();
        vm.prank(provider);
        esc.challenge(id);
        vm.prank(arbiter);
        esc.resolve(id, false);
        assertEq(esc.credits(provider), 0);
        assertEq(esc.credits(verifier), FEE);
        assertEq(esc.refundAmount(id), PRICE);
        _assertConserved(id);
    }

    // ------------------------------------------------------------ escalation
    function test_Dispute_EscalateVerdictGoesToChallenged() public {
        uint256 id = _toSubmitted();
        vm.expectEmit(true, false, false, true, address(esc));
        emit IMissionEscrow.MissionEscalated(id, 1);
        _verdictOn(esc, id, 3);
        IMissionEscrow.Mission memory m = esc.getMission(id);
        assertEq(uint8(m.status), uint8(CHALLENGED));
        assertEq(uint8(m.decision), uint8(IMissionEscrow.Decision.Escalate));
        assertEq(m.challengedAt, block.timestamp);
        vm.prank(arbiter);
        esc.resolve(id, true);
        assertEq(esc.credits(verifier), FEE, "escalation is a delivered verdict");
        assertEq(esc.credits(provider), PRICE);
    }

    function test_Dispute_EscalateStale_RespectsVerifierTimeout() public {
        uint256 id = _toSubmitted();
        uint256 t = esc.getMission(id).submittedAt;
        vm.warp(t + esc.VERIFIER_TIMEOUT() - 1);
        vm.expectRevert(MissionEscrow.TimeoutNotReached.selector);
        esc.escalateStale(id);

        vm.warp(t + esc.VERIFIER_TIMEOUT());
        vm.expectEmit(true, false, false, true, address(esc));
        emit IMissionEscrow.MissionEscalated(id, 2);
        vm.prank(stranger);
        esc.escalateStale(id);
        assertEq(uint8(_status(id)), uint8(CHALLENGED));
        assertEq(uint8(esc.getMission(id).decision), uint8(IMissionEscrow.Decision.None));
    }

    function test_Dispute_EscalateStale_RevertsWhenNotSubmitted() public {
        uint256 id = _toAssigned();
        vm.warp(block.timestamp + 10 days);
        vm.expectRevert(
            abi.encodeWithSelector(MissionEscrow.InvalidStatus.selector, id, IMissionEscrow.Status.Assigned)
        );
        esc.escalateStale(id);
    }

    // ------------------------------------------------------------ resolveByTimeout table
    function test_Timeout_Accept_ProviderPaid() public {
        uint256 id = _toChallengedAccept();
        uint256 t = esc.getMission(id).challengedAt;
        vm.warp(t + esc.ARBITER_TIMEOUT() - 1);
        vm.expectRevert(MissionEscrow.TimeoutNotReached.selector);
        esc.resolveByTimeout(id);

        vm.warp(t + esc.ARBITER_TIMEOUT());
        vm.prank(stranger);
        esc.resolveByTimeout(id);
        assertEq(uint8(esc.getMission(id).outcome), uint8(IMissionEscrow.Outcome.ProviderPaid));
        assertEq(esc.credits(provider), PRICE);
        assertEq(esc.credits(verifier), FEE);
        assertEq(esc.refundAmount(id), 0);
        _assertConserved(id);
    }

    function test_Timeout_Reject_BuyerRefundedVerifierPaid() public {
        uint256 id = _toRejected();
        vm.prank(provider);
        esc.challenge(id);
        vm.warp(block.timestamp + esc.ARBITER_TIMEOUT());
        esc.resolveByTimeout(id);
        assertEq(uint8(esc.getMission(id).outcome), uint8(IMissionEscrow.Outcome.BuyerRefunded));
        assertEq(esc.credits(provider), 0);
        assertEq(esc.credits(verifier), FEE);
        assertEq(esc.refundAmount(id), PRICE);
        _assertConserved(id);
    }

    function test_Timeout_Escalate_BuyerRefundedVerifierPaid() public {
        uint256 id = _toVerdict(3);
        vm.warp(block.timestamp + esc.ARBITER_TIMEOUT());
        esc.resolveByTimeout(id);
        assertEq(uint8(esc.getMission(id).outcome), uint8(IMissionEscrow.Outcome.BuyerRefunded));
        assertEq(esc.credits(provider), 0);
        assertEq(esc.credits(verifier), FEE);
        assertEq(esc.refundAmount(id), PRICE);
        _assertConserved(id);
    }

    function test_Timeout_NoVerdict_BuyerRefundedPricePlusFeeVerifierUnpaid() public {
        uint256 id = _toSubmitted();
        vm.warp(esc.getMission(id).submittedAt + esc.VERIFIER_TIMEOUT());
        esc.escalateStale(id);
        vm.warp(block.timestamp + esc.ARBITER_TIMEOUT());
        esc.resolveByTimeout(id);
        assertEq(uint8(esc.getMission(id).outcome), uint8(IMissionEscrow.Outcome.BuyerRefunded));
        assertEq(esc.credits(provider), 0);
        assertEq(esc.credits(verifier), 0, "no verdict, no fee");
        assertEq(esc.refundAmount(id), uint256(PRICE) + FEE);
        _assertConserved(id);

        uint256 b0 = usdc.balanceOf(buyer);
        esc.claimRefund(id);
        assertEq(usdc.balanceOf(buyer) - b0, uint256(PRICE) + FEE);
        assertEq(usdc.balanceOf(address(esc)), 0);
    }

    function test_Timeout_RevertsWhenNotChallenged() public {
        uint256 id = _toAccepted();
        vm.warp(block.timestamp + 30 days);
        vm.expectRevert(
            abi.encodeWithSelector(MissionEscrow.InvalidStatus.selector, id, IMissionEscrow.Status.Accepted)
        );
        esc.resolveByTimeout(id);
    }

    function test_Dispute_ArbiterAwardsProviderWithoutVerdict_FeeRefundedToBuyer() public {
        uint256 id = _toSubmitted();
        vm.warp(esc.getMission(id).submittedAt + esc.VERIFIER_TIMEOUT());
        esc.escalateStale(id);
        vm.prank(arbiter);
        esc.resolve(id, true);
        assertEq(esc.credits(provider), PRICE);
        assertEq(esc.credits(verifier), 0);
        assertEq(esc.refundAmount(id), FEE);
        _assertConserved(id);
    }

    function test_Timeout_ResolveByTimeoutTwiceReverts() public {
        uint256 id = _toChallengedAccept();
        vm.warp(block.timestamp + esc.ARBITER_TIMEOUT());
        esc.resolveByTimeout(id);
        vm.expectRevert(
            abi.encodeWithSelector(MissionEscrow.InvalidStatus.selector, id, IMissionEscrow.Status.Settled)
        );
        esc.resolveByTimeout(id);
        assertEq(esc.credits(provider), PRICE);
    }
}
