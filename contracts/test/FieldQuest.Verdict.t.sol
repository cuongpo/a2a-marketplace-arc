// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {FQBase} from "./FieldQuest.Base.t.sol";
import {MissionEscrow} from "../MissionEscrow.sol";
import {IMissionEscrow} from "../interfaces/IMissionEscrow.sol";
import {IEvidenceRegistry} from "../interfaces/IEvidenceRegistry.sol";

/// @dev EIP-712 verdict validation: bad signer, replay (nonce / mission / chain / escrow), expiry, evidence.
contract FQVerdictTest is FQBase {
    function _submitOnlyOn(MissionEscrow e) internal returns (uint256 id) {
        vm.prank(buyer);
        usdc.approve(address(e), type(uint256).max);
        IMissionEscrow.MissionParams memory p = _params();
        vm.prank(buyer);
        id = e.createMission(p);
        _assign(e, id);
        _submitOn(e, id);
    }

    function test_Verdict_HappyPathEmitsAndStores() public {
        uint256 id = _toSubmitted();
        IMissionEscrow.Verdict memory v = _verdict(id, 1);
        bytes memory sig = _signVerdictOn(esc, verifierPk, v);

        vm.expectEmit(true, true, false, true, address(esc));
        emit IMissionEscrow.VerdictRecorded(id, verifier, 1, EVID, REASON, v.nonce, uint64(block.timestamp + 1 days));
        vm.prank(stranger); // anyone relays
        esc.submitVerdict(v, sig);

        IMissionEscrow.Mission memory m = esc.getMission(id);
        assertEq(uint8(m.status), uint8(IMissionEscrow.Status.Accepted));
        assertEq(uint8(m.decision), uint8(IMissionEscrow.Decision.Accept));
        assertEq(m.verdictReasonHash, REASON);
        assertTrue(esc.verdictNonceUsed(verifier, v.nonce));
    }

    function test_Verdict_RejectDecisionSetsRejected() public {
        uint256 id = _toRejected();
        assertEq(uint8(esc.getMission(id).decision), uint8(IMissionEscrow.Decision.Reject));
    }

    // ------------------------------------------------------------ bad signer
    function test_Verdict_BadSignerReverts() public {
        uint256 id = _toSubmitted();
        IMissionEscrow.Verdict memory v = _verdict(id, 1);
        bytes memory sig = _signVerdictOn(esc, otherPk, v);
        vm.expectRevert(MissionEscrow.InvalidVerdictSignature.selector);
        esc.submitVerdict(v, sig);
        assertFalse(esc.verdictNonceUsed(verifier, v.nonce), "failed verdict must not burn nonce");
        assertEq(uint8(_status(id)), uint8(IMissionEscrow.Status.Submitted));
    }

    function test_Verdict_GarbageSignatureCannotBurnNonce() public {
        uint256 id = _toSubmitted();
        IMissionEscrow.Verdict memory v = _verdict(id, 1);
        vm.prank(stranger);
        vm.expectRevert(MissionEscrow.InvalidVerdictSignature.selector);
        esc.submitVerdict(v, new bytes(65));
        assertFalse(esc.verdictNonceUsed(verifier, v.nonce));
        // the real verifier can still use that nonce
        esc.submitVerdict(v, _signVerdictOn(esc, verifierPk, v));
    }

    function test_Verdict_TamperedFieldsInvalidateSignature() public {
        uint256 id = _toSubmitted();
        IMissionEscrow.Verdict memory v = _verdict(id, 2);
        bytes memory sig = _signVerdictOn(esc, verifierPk, v);
        v.decision = 1; // flip reject -> accept after signing
        vm.expectRevert(MissionEscrow.InvalidVerdictSignature.selector);
        esc.submitVerdict(v, sig);
    }

    // ------------------------------------------------------------ replay
    function test_Verdict_SameSignatureTwiceReverts() public {
        uint256 id = _toSubmitted();
        IMissionEscrow.Verdict memory v = _verdict(id, 1);
        bytes memory sig = _signVerdictOn(esc, verifierPk, v);
        esc.submitVerdict(v, sig);
        vm.expectRevert(
            abi.encodeWithSelector(MissionEscrow.InvalidStatus.selector, id, IMissionEscrow.Status.Accepted)
        );
        esc.submitVerdict(v, sig);
        assertTrue(esc.verdictNonceUsed(verifier, v.nonce));
    }

    function test_Verdict_NonceReuseAcrossMissionsReverts() public {
        uint256 id1 = _toSubmitted();
        uint256 id2 = _toSubmitted();
        IMissionEscrow.Verdict memory v1 = _verdict(id1, 1);
        esc.submitVerdict(v1, _signVerdictOn(esc, verifierPk, v1));

        // Fresh, validly signed verdict for mission 2 but with the same (verifier, nonce).
        IMissionEscrow.Verdict memory v2 = _verdict(id2, 1);
        v2.nonce = v1.nonce;
        bytes memory sig2 = _signVerdictOn(esc, verifierPk, v2);
        vm.expectRevert(MissionEscrow.VerdictNonceAlreadyUsed.selector);
        esc.submitVerdict(v2, sig2);
        assertEq(uint8(_status(id2)), uint8(IMissionEscrow.Status.Submitted));
    }

    function test_Verdict_SignatureForOtherMissionDoesNotTransfer() public {
        uint256 id1 = _toSubmitted();
        uint256 id2 = _toSubmitted();
        IMissionEscrow.Verdict memory v1 = _verdict(id1, 1);
        bytes memory sig1 = _signVerdictOn(esc, verifierPk, v1);
        // Re-aim mission 1's signature at mission 2 with a fresh nonce.
        IMissionEscrow.Verdict memory v2 = v1;
        v2.missionId = id2;
        v2.nonce = ++verdictNonce;
        vm.expectRevert(MissionEscrow.InvalidVerdictSignature.selector);
        esc.submitVerdict(v2, sig1);
    }

    function test_Verdict_ReplayAcrossChainsReverts() public {
        uint256 id = _toSubmitted();
        IMissionEscrow.Verdict memory v = _verdict(id, 1);
        bytes32 digestHere = esc.hashVerdict(v);
        bytes memory sigHere = _sig(verifierPk, digestHere);

        vm.chainId(999);
        assertNotEq(esc.hashVerdict(v), digestHere, "domain separator depends on chainid");
        vm.expectRevert(MissionEscrow.InvalidVerdictSignature.selector);
        esc.submitVerdict(v, sigHere);

        // Positive control: a signature made for chain 999 works there.
        esc.submitVerdict(v, _sig(verifierPk, esc.hashVerdict(v)));
        assertEq(uint8(_status(id)), uint8(IMissionEscrow.Status.Accepted));
    }

    function test_Verdict_ReplayAcrossEscrowContractsReverts() public {
        MissionEscrow esc2 = new MissionEscrow(address(usdc), address(reg), arbiter);
        uint256 id1 = _toSubmitted();
        uint256 id2 = _submitOnlyOn(esc2);
        assertEq(id1, id2, "same mission id on both escrows");

        IMissionEscrow.Verdict memory v = _verdict(id1, 1);
        bytes memory sigForEsc1 = _signVerdictOn(esc, verifierPk, v);
        assertNotEq(esc.hashVerdict(v), esc2.hashVerdict(v));
        vm.expectRevert(MissionEscrow.InvalidVerdictSignature.selector);
        esc2.submitVerdict(v, sigForEsc1);

        esc.submitVerdict(v, sigForEsc1); // still valid on the intended escrow
        esc2.submitVerdict(v, _signVerdictOn(esc2, verifierPk, v)); // and on esc2 with its own signature
        assertEq(uint8(esc2.getMission(id2).status), uint8(IMissionEscrow.Status.Accepted));
    }

    // ------------------------------------------------------------ expiry, evidence, decision, status
    function test_Verdict_ExpiredReverts() public {
        uint256 id = _toSubmitted();
        IMissionEscrow.Verdict memory v = _verdict(id, 1);
        v.expiry = uint64(block.timestamp - 1);
        bytes memory sig = _signVerdictOn(esc, verifierPk, v);
        vm.expectRevert(MissionEscrow.VerdictExpired.selector);
        esc.submitVerdict(v, sig);
    }

    function test_Verdict_ExpiryEqualToNowIsValid() public {
        uint256 id = _toSubmitted();
        IMissionEscrow.Verdict memory v = _verdict(id, 1);
        v.expiry = uint64(block.timestamp);
        esc.submitVerdict(v, _signVerdictOn(esc, verifierPk, v));
        assertEq(uint8(_status(id)), uint8(IMissionEscrow.Status.Accepted));
    }

    function test_Verdict_WrongEvidenceHashReverts() public {
        uint256 id = _toSubmitted();
        IMissionEscrow.Verdict memory v = _verdict(id, 1);
        v.evidenceHash = keccak256("other evidence");
        bytes memory sig = _signVerdictOn(esc, verifierPk, v);
        vm.expectRevert(MissionEscrow.EvidenceMismatch.selector);
        esc.submitVerdict(v, sig);
    }

    function test_Verdict_InvalidDecisionReverts() public {
        uint256 id = _toSubmitted();
        IMissionEscrow.Verdict memory v0 = _verdict(id, 0);
        bytes memory s0 = _signVerdictOn(esc, verifierPk, v0);
        vm.expectRevert(MissionEscrow.InvalidDecision.selector);
        esc.submitVerdict(v0, s0);

        IMissionEscrow.Verdict memory v4 = _verdict(id, 4);
        bytes memory s4 = _signVerdictOn(esc, verifierPk, v4);
        vm.expectRevert(MissionEscrow.InvalidDecision.selector);
        esc.submitVerdict(v4, s4);
    }

    function test_Verdict_RequiresSubmittedStatus() public {
        uint256 id = _toAssigned();
        IMissionEscrow.Verdict memory v = _verdict(id, 1);
        bytes memory sig = _signVerdictOn(esc, verifierPk, v);
        vm.expectRevert(
            abi.encodeWithSelector(MissionEscrow.InvalidStatus.selector, id, IMissionEscrow.Status.Assigned)
        );
        esc.submitVerdict(v, sig);
    }

    function test_Verdict_UnknownMissionReverts() public {
        IMissionEscrow.Verdict memory v = _verdict(77, 1);
        bytes memory sig = _signVerdictOn(esc, verifierPk, v);
        vm.expectRevert(abi.encodeWithSelector(MissionEscrow.UnknownMission.selector, 77));
        esc.submitVerdict(v, sig);
    }
}
