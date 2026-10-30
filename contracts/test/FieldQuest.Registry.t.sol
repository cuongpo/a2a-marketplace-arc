// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {FQBase} from "./FieldQuest.Base.t.sol";
import {MissionEscrow} from "../MissionEscrow.sol";
import {IMissionEscrow} from "../interfaces/IMissionEscrow.sol";
import {IEvidenceRegistry} from "../interfaces/IEvidenceRegistry.sol";

/// @dev Sensor-signer registry + reading validation. The test contract is the "consumer" for direct calls.
contract FQRegistryTest is FQBase {
    uint256 internal constant ID = 1;

    function _c() internal view returns (IEvidenceRegistry.Constraints memory) {
        return IEvidenceRegistry.Constraints({missionId: ID, tileId: TILE, unit: UNIT, notBefore: uint64(T0), maxAge: 1 hours});
    }

    function _consume(IEvidenceRegistry.Reading memory r, bytes memory sig) internal returns (bytes32, address) {
        return reg.consumeReading(provider, _c(), r, sig);
    }

    // ------------------------------------------------------------ signer registration
    function test_Registry_RegisterSignerStoresBinding() public {
        uint256 pk = 0x1234;
        bytes32 meta = keccak256("m2");
        bytes memory sig = _sig(pk, reg.hashSignerBinding(stranger, vm.addr(pk), meta));
        vm.expectEmit(true, true, false, true, address(reg));
        emit IEvidenceRegistry.SignerRegistered(stranger, vm.addr(pk), meta);
        vm.prank(stranger);
        reg.registerSigner(vm.addr(pk), meta, sig);
        (address p, bool active, bytes32 m) = reg.signerInfo(vm.addr(pk));
        assertEq(p, stranger);
        assertTrue(active);
        assertEq(m, meta);
    }

    function test_Registry_SignerSigByWrongKeyReverts() public {
        uint256 pk = 0x1234;
        bytes32 meta = keccak256("m2");
        bytes memory sig = _sig(otherPk, reg.hashSignerBinding(stranger, vm.addr(pk), meta));
        vm.prank(stranger);
        vm.expectRevert(IEvidenceRegistry.BadSignerBinding.selector);
        reg.registerSigner(vm.addr(pk), meta, sig);
    }

    function test_Registry_BindingSigIsProviderSpecific() public {
        // sensor signed a binding for `provider`; another account cannot reuse it
        uint256 pk = 0x1234;
        bytes32 meta = keccak256("m2");
        bytes memory sig = _sig(pk, reg.hashSignerBinding(provider, vm.addr(pk), meta));
        vm.prank(stranger);
        vm.expectRevert(IEvidenceRegistry.BadSignerBinding.selector);
        reg.registerSigner(vm.addr(pk), meta, sig);
    }

    function test_Registry_ZeroSignerAndGarbageSigRevert() public {
        vm.prank(stranger);
        vm.expectRevert(IEvidenceRegistry.BadSignerBinding.selector);
        reg.registerSigner(address(0), bytes32(0), new bytes(65));
        vm.prank(stranger);
        vm.expectRevert(IEvidenceRegistry.BadSignerBinding.selector);
        reg.registerSigner(vm.addr(0x1234), bytes32(0), hex"1234");
    }

    function test_Registry_ReRegistrationBlocked() public {
        // already registered by `provider` in setUp; same provider again, and other provider
        bytes32 meta = keccak256("meta");
        bytes memory sigProv = _sig(sensorPk, reg.hashSignerBinding(provider, sensor, meta));
        vm.prank(provider);
        vm.expectRevert(IEvidenceRegistry.SignerAlreadyRegistered.selector);
        reg.registerSigner(sensor, meta, sigProv);

        bytes memory sigOther = _sig(sensorPk, reg.hashSignerBinding(stranger, sensor, meta));
        vm.prank(stranger);
        vm.expectRevert(IEvidenceRegistry.SignerAlreadyRegistered.selector);
        reg.registerSigner(sensor, meta, sigOther);
    }

    function test_Registry_RevokeThenReRegistrationStillBlocked() public {
        vm.expectEmit(true, true, false, false, address(reg));
        emit IEvidenceRegistry.SignerRevoked(provider, sensor);
        vm.prank(provider);
        reg.revokeSigner(sensor);
        (address p, bool active,) = reg.signerInfo(sensor);
        assertEq(p, provider, "binding preserved");
        assertFalse(active);

        bytes32 meta = keccak256("meta");
        bytes memory sig = _sig(sensorPk, reg.hashSignerBinding(stranger, sensor, meta));
        vm.prank(stranger);
        vm.expectRevert(IEvidenceRegistry.SignerAlreadyRegistered.selector);
        reg.registerSigner(sensor, meta, sig);
        bytes memory sig2 = _sig(sensorPk, reg.hashSignerBinding(provider, sensor, meta));
        vm.prank(provider);
        vm.expectRevert(IEvidenceRegistry.SignerAlreadyRegistered.selector);
        reg.registerSigner(sensor, meta, sig2);
    }

    function test_Registry_RevokeOnlyByBoundProvider() public {
        vm.prank(stranger);
        vm.expectRevert(IEvidenceRegistry.NotSignerProvider.selector);
        reg.revokeSigner(sensor);
        vm.prank(provider);
        vm.expectRevert(IEvidenceRegistry.NotSignerProvider.selector);
        reg.revokeSigner(vm.addr(0x999)); // unknown signer: provider == address(0)
    }

    // ------------------------------------------------------------ reading validation
    function test_Registry_ValidReadingConsumedAndDigestReturned() public {
        IEvidenceRegistry.Reading memory r = _reading(ID);
        bytes memory sig = _signReading(sensorPk, r);
        vm.expectEmit(true, true, true, true, address(reg));
        emit IEvidenceRegistry.ReadingConsumed(address(this), sensor, ID, TILE, r.nonce, reg.hashReading(r));
        (bytes32 d, address s) = _consume(r, sig);
        assertEq(d, reg.hashReading(r));
        assertEq(s, sensor);
        assertTrue(reg.nonceUsed(address(this), sensor, r.nonce));
    }

    function test_Registry_PreviewDoesNotConsume() public {
        IEvidenceRegistry.Reading memory r = _reading(ID);
        bytes memory sig = _signReading(sensorPk, r);
        (, address s) = reg.previewReading(address(this), provider, _c(), r, sig);
        assertEq(s, sensor);
        assertFalse(reg.nonceUsed(address(this), sensor, r.nonce));
        _consume(r, sig);
        vm.expectRevert(IEvidenceRegistry.NonceAlreadyUsed.selector);
        reg.previewReading(address(this), provider, _c(), r, sig);
    }

    function test_Registry_UnregisteredSignerReverts() public {
        IEvidenceRegistry.Reading memory r = _reading(ID);
        bytes memory sig = _signReading(otherPk, r);
        vm.expectRevert(IEvidenceRegistry.SignerNotActive.selector);
        _consume(r, sig);
    }

    function test_Registry_RevokedSignerReverts() public {
        vm.prank(provider);
        reg.revokeSigner(sensor);
        IEvidenceRegistry.Reading memory r = _reading(ID);
        bytes memory sig = _signReading(sensorPk, r);
        vm.expectRevert(IEvidenceRegistry.SignerNotActive.selector);
        _consume(r, sig);
    }

    function test_Registry_SignerBoundToOtherProviderReverts() public {
        IEvidenceRegistry.Reading memory r = _reading(ID);
        bytes memory sig = _signReading(sensorPk, r);
        vm.expectRevert(IEvidenceRegistry.SignerBoundToOtherProvider.selector);
        reg.consumeReading(stranger, _c(), r, sig);
    }

    function test_Registry_ReusedNonceReverts() public {
        IEvidenceRegistry.Reading memory r = _reading(ID);
        bytes memory sig = _signReading(sensorPk, r);
        _consume(r, sig);
        vm.expectRevert(IEvidenceRegistry.NonceAlreadyUsed.selector);
        _consume(r, sig);
    }

    function test_Registry_ReusedNonceAcrossMissionsRevertsViaEscrow() public {
        uint256 id1 = _toAssigned();
        uint256 id2 = _toAssigned();
        IEvidenceRegistry.Reading memory r1 = _reading(id1);
        bytes memory sig1 = _signReading(sensorPk, r1);
        vm.prank(provider);
        esc.submitEvidence(id1, EVID, r1, sig1);

        IEvidenceRegistry.Reading memory r2 = _reading(id2);
        r2.nonce = r1.nonce; // same device nonce, different mission
        bytes memory sig2 = _signReading(sensorPk, r2);
        vm.prank(provider);
        vm.expectRevert(IEvidenceRegistry.NonceAlreadyUsed.selector);
        esc.submitEvidence(id2, EVID, r2, sig2);
        assertEq(uint8(_status(id2)), uint8(IMissionEscrow.Status.Assigned));
    }

    function test_Registry_WrongTileReverts() public {
        IEvidenceRegistry.Reading memory r = _reading(ID);
        r.tileId = keccak256("tile-2");
        bytes memory sig = _signReading(sensorPk, r);
        vm.expectRevert(IEvidenceRegistry.WrongTile.selector);
        _consume(r, sig);
    }

    function test_Registry_WrongMissionReverts() public {
        IEvidenceRegistry.Reading memory r = _reading(ID + 1);
        bytes memory sig = _signReading(sensorPk, r);
        vm.expectRevert(IEvidenceRegistry.WrongMission.selector);
        _consume(r, sig);
    }

    function test_Registry_WrongUnitReverts() public {
        IEvidenceRegistry.Reading memory r = _reading(ID);
        r.unit = keccak256("cm");
        bytes memory sig = _signReading(sensorPk, r);
        vm.expectRevert(IEvidenceRegistry.WrongUnit.selector);
        _consume(r, sig);
    }

    function test_Registry_StaleReadingReverts() public {
        IEvidenceRegistry.Reading memory r = _reading(ID);
        r.observedAt = uint64(block.timestamp);
        bytes memory sig = _signReading(sensorPk, r);
        vm.warp(block.timestamp + 1 hours + 1);
        vm.expectRevert(IEvidenceRegistry.ReadingTooOld.selector);
        _consume(r, sig);
    }

    function test_Registry_ReadingAtExactMaxAgeAccepted() public {
        IEvidenceRegistry.Reading memory r = _reading(ID);
        bytes memory sig = _signReading(sensorPk, r);
        vm.warp(block.timestamp + 1 hours);
        _consume(r, sig);
    }

    function test_Registry_ReadingBeforeMissionReverts() public {
        IEvidenceRegistry.Reading memory r = _reading(ID);
        r.observedAt = uint64(T0 - 1);
        bytes memory sig = _signReading(sensorPk, r);
        vm.expectRevert(IEvidenceRegistry.ReadingBeforeMission.selector);
        _consume(r, sig);
    }

    function test_Registry_ReadingBeforeMissionCreationViaEscrow() public {
        uint256 id = _toAssigned();
        vm.warp(block.timestamp + 10 minutes);
        IEvidenceRegistry.Reading memory r = _reading(id);
        r.observedAt = uint64(T0 - 1); // before mission.createdAt, still inside maxAge
        bytes memory sig = _signReading(sensorPk, r);
        vm.prank(provider);
        vm.expectRevert(IEvidenceRegistry.ReadingBeforeMission.selector);
        esc.submitEvidence(id, EVID, r, sig);
    }

    function test_Registry_FutureReadingReverts() public {
        IEvidenceRegistry.Reading memory ok = _reading(ID);
        ok.observedAt = uint64(block.timestamp + 60); // within 60s skew
        _consume(ok, _signReading(sensorPk, ok));

        IEvidenceRegistry.Reading memory r = _reading(ID);
        r.observedAt = uint64(block.timestamp + 61);
        bytes memory sig = _signReading(sensorPk, r);
        vm.expectRevert(IEvidenceRegistry.ReadingFromFuture.selector);
        _consume(r, sig);
    }

    function test_Registry_BadSignatureReverts() public {
        IEvidenceRegistry.Reading memory r = _reading(ID);
        vm.expectRevert(IEvidenceRegistry.BadReadingSignature.selector);
        _consume(r, new bytes(65));
        vm.expectRevert(IEvidenceRegistry.BadReadingSignature.selector);
        _consume(r, hex"deadbeef");
    }

    function test_Registry_TamperedReadingFailsAsUnknownSigner() public {
        IEvidenceRegistry.Reading memory r = _reading(ID);
        bytes memory sig = _signReading(sensorPk, r);
        r.value = 9999; // altered after signing → recovers to a different (unregistered) address
        vm.expectRevert(IEvidenceRegistry.SignerNotActive.selector);
        _consume(r, sig);
    }

    // ------------------------------------------------------------ nonce namespace isolation
    function test_Registry_OtherCallerCannotBurnEscrowNonce() public {
        uint256 id = _toAssigned();
        IEvidenceRegistry.Reading memory r = _reading(id);
        bytes memory sig = _signReading(sensorPk, r);

        // A griefer front-runs by consuming the same reading directly on the registry.
        IEvidenceRegistry.Constraints memory c = IEvidenceRegistry.Constraints({
            missionId: id, tileId: TILE, unit: UNIT, notBefore: uint64(T0), maxAge: 1 hours
        });
        vm.prank(stranger);
        reg.consumeReading(provider, c, r, sig);
        assertTrue(reg.nonceUsed(stranger, sensor, r.nonce));
        assertFalse(reg.nonceUsed(address(esc), sensor, r.nonce), "escrow namespace untouched");

        vm.prank(provider);
        esc.submitEvidence(id, EVID, r, sig); // still succeeds
        assertEq(uint8(_status(id)), uint8(IMissionEscrow.Status.Submitted));
        assertTrue(reg.nonceUsed(address(esc), sensor, r.nonce));
    }

    function test_Registry_RevokedSignerBlocksEscrowSubmission() public {
        uint256 id = _toAssigned();
        vm.prank(provider);
        reg.revokeSigner(sensor);
        IEvidenceRegistry.Reading memory r = _reading(id);
        bytes memory sig = _signReading(sensorPk, r);
        vm.prank(provider);
        vm.expectRevert(IEvidenceRegistry.SignerNotActive.selector);
        esc.submitEvidence(id, EVID, r, sig);
    }
}
