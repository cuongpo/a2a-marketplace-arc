// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {FQBase} from "./FieldQuest.Base.t.sol";
import {Erc8004Adapter} from "../Erc8004Adapter.sol";
import {IMissionEscrow} from "../interfaces/IMissionEscrow.sol";
import {RevertingReputationRegistry, MockReputationRegistry} from "./mocks/Mocks.sol";

/// @dev Erc8004Adapter: binding, feedback recording, failure isolation, idempotency.
contract FQAdapterTest is FQBase {
    uint256 internal constant PROV_AGENT = 7;
    uint256 internal constant VER_AGENT = 9;

    function _bindBoth() internal {
        ident.setOwner(PROV_AGENT, provider);
        ident.setOwner(VER_AGENT, verifier);
        vm.prank(provider);
        adapter.bindAgent(PROV_AGENT);
        vm.prank(verifier);
        adapter.bindAgent(VER_AGENT);
    }

    function _paidMission() internal returns (uint256 id) {
        id = _toAccepted();
        _skipPastWindow(id);
        esc.finalize(id);
    }

    function _rejectedMission() internal returns (uint256 id) {
        id = _toRejected();
        _skipPastWindow(id);
        esc.finalize(id);
    }

    // ------------------------------------------------------------ bindAgent
    function test_Adapter_BindAgentByOwnerSucceeds() public {
        ident.setOwner(PROV_AGENT, provider);
        vm.expectEmit(true, true, false, false, address(adapter));
        emit Erc8004Adapter.AgentBound(provider, PROV_AGENT);
        vm.prank(provider);
        adapter.bindAgent(PROV_AGENT);
        (uint256 agentId, bool bound) = adapter.identityOf(provider);
        assertEq(agentId, PROV_AGENT);
        assertTrue(bound);
    }

    function test_Adapter_BindAgentByNonOwnerReverts() public {
        ident.setOwner(PROV_AGENT, provider);
        vm.prank(stranger);
        vm.expectRevert(Erc8004Adapter.BindFailed.selector);
        adapter.bindAgent(PROV_AGENT);
        (, bool bound) = adapter.identityOf(stranger);
        assertFalse(bound);
    }

    function test_Adapter_BindUnknownAgentReverts() public {
        vm.prank(provider);
        vm.expectRevert(Erc8004Adapter.BindFailed.selector);
        adapter.bindAgent(12345); // ownerOf reverts for unminted ids
    }

    function test_Adapter_BindAgentIdZeroAndRebind() public {
        ident.setOwner(0, provider);
        vm.prank(provider);
        adapter.bindAgent(0);
        (uint256 id0, bool bound) = adapter.identityOf(provider);
        assertEq(id0, 0);
        assertTrue(bound, "agent id 0 is distinguishable from unbound");

        ident.setOwner(PROV_AGENT, provider);
        vm.prank(provider);
        adapter.bindAgent(PROV_AGENT);
        (uint256 id1,) = adapter.identityOf(provider);
        assertEq(id1, PROV_AGENT);
    }

    function test_Adapter_ReadIdentityOwnerIsSelfOnly() public {
        vm.expectRevert(Erc8004Adapter.BindFailed.selector);
        adapter.readIdentityOwner(1);
    }

    function test_Adapter_ConstructorRejectsZero() public {
        vm.expectRevert(Erc8004Adapter.ZeroAddress.selector);
        new Erc8004Adapter(address(0), address(rep), address(esc));
        vm.expectRevert(Erc8004Adapter.ZeroAddress.selector);
        new Erc8004Adapter(address(ident), address(0), address(esc));
        vm.expectRevert(Erc8004Adapter.ZeroAddress.selector);
        new Erc8004Adapter(address(ident), address(rep), address(0));
    }

    // ------------------------------------------------------------ recordOutcome (working registry)
    function test_Adapter_RecordOutcomeRevertsBeforeFinalAndWhenNothingBound() public {
        uint256 id = _create();
        _bindBoth();
        vm.expectRevert(Erc8004Adapter.MissionNotFinal.selector);
        adapter.recordOutcome(id);

        // settle it, but with a fresh adapter where nobody is bound
        Erc8004Adapter fresh = new Erc8004Adapter(address(ident), address(rep), address(esc));
        vm.prank(buyer);
        esc.cancelUnassigned(id);
        vm.expectRevert(Erc8004Adapter.NothingToRecord.selector);
        fresh.recordOutcome(id);
    }

    function test_Adapter_RecordOutcomePaidMissionRecordsBothRoles() public {
        _bindBoth();
        uint256 id = _paidMission();
        vm.expectEmit(true, true, true, true, address(adapter));
        emit Erc8004Adapter.FeedbackRecorded(id, PROV_AGENT, Erc8004Adapter.Role.Provider, 100);
        vm.prank(stranger); // permissionless
        adapter.recordOutcome(id);

        assertEq(rep.callCount(), 2);
        MockReputationRegistry.Call memory c0 = rep.callAt(0);
        assertEq(c0.agentId, PROV_AGENT);
        assertEq(c0.value, 100);
        assertEq(c0.tag1, "fieldquest.delivery");
        assertEq(c0.tag2, "paid");
        assertEq(c0.feedbackHash, EVID);
        MockReputationRegistry.Call memory c1 = rep.callAt(1);
        assertEq(c1.agentId, VER_AGENT);
        assertEq(c1.value, 100);
        assertEq(c1.tag1, "fieldquest.verification");
        assertTrue(adapter.providerRecorded(id));
        assertTrue(adapter.verifierRecorded(id));
    }

    function test_Adapter_RejectedMissionGivesProviderZeroScore() public {
        _bindBoth();
        uint256 id = _rejectedMission();
        adapter.recordOutcome(id);
        assertEq(rep.callAt(0).value, 0);
        assertEq(rep.callAt(0).tag2, "refunded");
        assertEq(rep.callAt(1).value, 100, "verifier delivered");
    }

    function test_Adapter_ExpiredMissionSkipsVerifierWithoutVerdict() public {
        _bindBoth();
        uint256 id = _create();
        vm.prank(buyer);
        esc.cancelUnassigned(id);
        adapter.recordOutcome(id);
        assertEq(rep.callCount(), 1, "only provider; verifier has no verdict");
        assertEq(rep.callAt(0).value, 0);
        assertEq(rep.callAt(0).tag2, "expired");
        assertFalse(adapter.verifierRecorded(id));
    }

    function test_Adapter_RecordOutcomeIsIdempotent() public {
        _bindBoth();
        uint256 id = _paidMission();
        adapter.recordOutcome(id);
        adapter.recordOutcome(id);
        adapter.recordOutcome(id);
        assertEq(rep.callCount(), 2, "no duplicate feedback");
    }

    function test_Adapter_OnlyBoundRoleRecorded() public {
        ident.setOwner(PROV_AGENT, provider);
        vm.prank(provider);
        adapter.bindAgent(PROV_AGENT);
        uint256 id = _paidMission();
        adapter.recordOutcome(id);
        assertEq(rep.callCount(), 1);
        assertTrue(adapter.providerRecorded(id));
        assertFalse(adapter.verifierRecorded(id));

        // verifier binds later → can be recorded afterwards, provider not repeated
        ident.setOwner(VER_AGENT, verifier);
        vm.prank(verifier);
        adapter.bindAgent(VER_AGENT);
        adapter.recordOutcome(id);
        assertEq(rep.callCount(), 2);
        assertEq(rep.callAt(1).agentId, VER_AGENT);
    }

    // ------------------------------------------------------------ reverting registry
    function test_Adapter_RevertingRegistryEmitsFeedbackFailedAndEscrowUnaffected() public {
        RevertingReputationRegistry bad = new RevertingReputationRegistry();
        Erc8004Adapter a = new Erc8004Adapter(address(ident), address(bad), address(esc));
        ident.setOwner(PROV_AGENT, provider);
        ident.setOwner(VER_AGENT, verifier);
        vm.prank(provider);
        a.bindAgent(PROV_AGENT);
        vm.prank(verifier);
        a.bindAgent(VER_AGENT);

        uint256 id = _paidMission();
        vm.expectEmit(true, true, true, false, address(a));
        emit Erc8004Adapter.FeedbackFailed(id, PROV_AGENT, Erc8004Adapter.Role.Provider);
        vm.expectEmit(true, true, true, false, address(a));
        emit Erc8004Adapter.FeedbackFailed(id, VER_AGENT, Erc8004Adapter.Role.Verifier);
        a.recordOutcome(id);
        assertFalse(a.providerRecorded(id));
        assertFalse(a.verifierRecorded(id));

        // escrow state and payouts unaffected
        assertEq(uint8(_status(id)), uint8(IMissionEscrow.Status.Settled));
        vm.prank(provider);
        esc.withdraw(provider);
        assertEq(usdc.balanceOf(provider), PRICE);
    }

    function test_Adapter_FailedFeedbackRetryWorksLater() public {
        _bindBoth();
        uint256 id = _paidMission();
        rep.setFailing(true);
        vm.expectEmit(true, true, true, false, address(adapter));
        emit Erc8004Adapter.FeedbackFailed(id, PROV_AGENT, Erc8004Adapter.Role.Provider);
        adapter.recordOutcome(id);
        assertEq(rep.callCount(), 0);
        assertFalse(adapter.providerRecorded(id));

        rep.setFailing(false);
        vm.expectEmit(true, true, true, true, address(adapter));
        emit Erc8004Adapter.FeedbackRecorded(id, PROV_AGENT, Erc8004Adapter.Role.Provider, 100);
        adapter.recordOutcome(id);
        assertEq(rep.callCount(), 2);
        assertTrue(adapter.providerRecorded(id));
        assertTrue(adapter.verifierRecorded(id));
    }

    function test_Adapter_ReputationWithoutCodeEmitsFailedNotRevert() public {
        Erc8004Adapter a = new Erc8004Adapter(address(ident), makeAddr("noCode"), address(esc));
        ident.setOwner(PROV_AGENT, provider);
        vm.prank(provider);
        a.bindAgent(PROV_AGENT);
        uint256 id = _paidMission();
        vm.expectEmit(true, true, true, false, address(a));
        emit Erc8004Adapter.FeedbackFailed(id, PROV_AGENT, Erc8004Adapter.Role.Provider);
        a.recordOutcome(id);
        assertFalse(a.providerRecorded(id));
    }

    function test_Adapter_EscrowSettlementIndependentOfReputationDown() public {
        rep.setFailing(true);
        _bindBoth();
        uint256 id = _paidMission(); // finalize must not touch the adapter
        assertEq(esc.credits(provider), PRICE);
        vm.prank(provider);
        esc.withdraw(provider);
        assertEq(usdc.balanceOf(provider), PRICE);
        adapter.recordOutcome(id); // does not revert, just FeedbackFailed
        assertEq(rep.callCount(), 0);
    }
}
