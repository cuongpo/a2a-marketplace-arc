// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Test} from "forge-std/Test.sol";
import {MissionEscrow} from "../MissionEscrow.sol";
import {AgentBudgetVault} from "../AgentBudgetVault.sol";
import {EvidenceRegistry} from "../EvidenceRegistry.sol";
import {Erc8004Adapter} from "../Erc8004Adapter.sol";
import {IMissionEscrow} from "../interfaces/IMissionEscrow.sol";
import {IEvidenceRegistry} from "../interfaces/IEvidenceRegistry.sol";
import {IAgentBudgetVault} from "../interfaces/IAgentBudgetVault.sol";
import {MockUSDC, MockIdentityRegistry, MockReputationRegistry} from "./mocks/Mocks.sol";

/// @dev Shared fixture. No test functions here (every category inherits it).
abstract contract FQBase is Test {
    uint256 internal constant T0 = 1_700_000_000;
    uint128 internal constant PRICE = 100e6;
    uint128 internal constant FEE = 5e6;
    bytes32 internal constant TILE = keccak256("tile-1");
    bytes32 internal constant UNIT = keccak256("mm");
    bytes32 internal constant OBJ = keccak256("objective");
    bytes32 internal constant EVID = keccak256("evidence");
    bytes32 internal constant REASON = keccak256("reason");

    MockUSDC internal usdc;
    EvidenceRegistry internal reg;
    MissionEscrow internal esc;
    AgentBudgetVault internal vault;
    Erc8004Adapter internal adapter;
    MockIdentityRegistry internal ident;
    MockReputationRegistry internal rep;

    address internal buyer = makeAddr("buyer");
    address internal arbiter = makeAddr("arbiter");
    address internal operator = makeAddr("operator");
    address internal executor = makeAddr("executor");
    address internal provider = makeAddr("provider");
    address internal providerWallet = makeAddr("providerWallet");
    address internal stranger = makeAddr("stranger");

    uint256 internal verifierPk = 0xA11CE;
    uint256 internal sensorPk = 0xB0B;
    uint256 internal otherPk = 0xC0FFEE;
    address internal verifier;
    address internal sensor;

    uint256 internal sensorNonce;
    uint256 internal verdictNonce;

    function setUp() public virtual {
        vm.warp(T0);
        verifier = vm.addr(verifierPk);
        sensor = vm.addr(sensorPk);

        usdc = new MockUSDC();
        reg = new EvidenceRegistry();
        esc = new MissionEscrow(address(usdc), address(reg), arbiter);
        address[] memory trusted = new address[](1);
        trusted[0] = address(esc);
        vault = new AgentBudgetVault(address(usdc), trusted);
        ident = new MockIdentityRegistry();
        rep = new MockReputationRegistry();
        adapter = new Erc8004Adapter(address(ident), address(rep), address(esc));

        usdc.mint(buyer, 1_000_000e6);
        vm.prank(buyer);
        usdc.approve(address(esc), type(uint256).max);

        _registerSensor(provider, sensorPk);
    }

    // ---------------------------------------------------------------- signing helpers
    function _sig(uint256 pk, bytes32 digest) internal pure returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, digest);
        return abi.encodePacked(r, s, v);
    }

    function _registerSensor(address prov, uint256 pk) internal {
        address s = vm.addr(pk);
        bytes32 meta = keccak256("meta");
        bytes memory sig = _sig(pk, reg.hashSignerBinding(prov, s, meta));
        vm.prank(prov);
        reg.registerSigner(s, meta, sig);
    }

    function _reading(uint256 id) internal returns (IEvidenceRegistry.Reading memory r) {
        r = IEvidenceRegistry.Reading({
            missionId: id,
            tileId: TILE,
            observedAt: uint64(block.timestamp),
            value: 42,
            unit: UNIT,
            nonce: ++sensorNonce,
            payloadHash: keccak256("payload")
        });
    }

    function _signReading(uint256 pk, IEvidenceRegistry.Reading memory r) internal view returns (bytes memory) {
        return _sig(pk, reg.hashReading(r));
    }

    function _verdict(uint256 id, uint8 decision) internal returns (IMissionEscrow.Verdict memory v) {
        v = IMissionEscrow.Verdict({
            missionId: id,
            evidenceHash: EVID,
            decision: decision,
            reasonHash: REASON,
            expiry: uint64(block.timestamp + 1 days),
            nonce: ++verdictNonce
        });
    }

    function _signVerdictOn(MissionEscrow e, uint256 pk, IMissionEscrow.Verdict memory v)
        internal
        view
        returns (bytes memory)
    {
        return _sig(pk, e.hashVerdict(v));
    }

    // ---------------------------------------------------------------- mission helpers
    function _params() internal view returns (IMissionEscrow.MissionParams memory p) {
        p = _paramsFor(provider, PRICE, FEE);
    }

    function _paramsFor(address prov, uint128 price, uint128 fee)
        internal
        view
        returns (IMissionEscrow.MissionParams memory p)
    {
        p = IMissionEscrow.MissionParams({
            objectiveHash: OBJ,
            tileId: TILE,
            unit: UNIT,
            quoteHash: keccak256("quote"),
            provider: prov,
            verifier: verifier,
            refundTo: buyer,
            providerPrice: price,
            verifierFee: fee,
            deadline: uint64(block.timestamp + 7 days),
            maxReadingAge: 1 hours,
            challengeWindow: 1 days
        });
    }

    function _create() internal returns (uint256 id) {
        IMissionEscrow.MissionParams memory p = _params();
        vm.prank(buyer);
        id = esc.createMission(p);
    }

    function _assign(MissionEscrow e, uint256 id) internal {
        vm.prank(e.getMission(id).provider);
        e.acceptAssignment(id);
    }

    function _submitOn(MissionEscrow e, uint256 id) internal {
        IEvidenceRegistry.Reading memory r = _reading(id);
        bytes memory sig = _signReading(sensorPk, r);
        address prov = e.getMission(id).provider;
        vm.prank(prov);
        e.submitEvidence(id, EVID, r, sig);
    }

    function _toAssigned() internal returns (uint256 id) {
        id = _create();
        _assign(esc, id);
    }

    function _toSubmitted() internal returns (uint256 id) {
        id = _toAssigned();
        _submitOn(esc, id);
    }

    function _verdictOn(MissionEscrow e, uint256 id, uint8 decision) internal {
        IMissionEscrow.Verdict memory v = _verdict(id, decision);
        bytes memory sig = _signVerdictOn(e, verifierPk, v);
        e.submitVerdict(v, sig);
    }

    function _toVerdict(uint8 decision) internal returns (uint256 id) {
        id = _toSubmitted();
        _verdictOn(esc, id, decision);
    }

    function _toAccepted() internal returns (uint256 id) {
        id = _toVerdict(1);
    }

    function _toRejected() internal returns (uint256 id) {
        id = _toVerdict(2);
    }

    function _status(uint256 id) internal view returns (IMissionEscrow.Status) {
        return esc.getMission(id).status;
    }

    function _skipPastWindow(uint256 id) internal {
        vm.warp(esc.getMission(id).challengeEndsAt);
    }

    /// @dev Settle a mission to a Challenged state via buyer challenge on Accept.
    function _toChallengedAccept() internal returns (uint256 id) {
        id = _toAccepted();
        vm.prank(buyer);
        esc.challenge(id);
    }

    // ---------------------------------------------------------------- vault helpers
    function _vaultFund(uint256 amount) internal {
        usdc.mint(operator, amount);
        vm.startPrank(operator);
        usdc.approve(address(vault), amount);
        vault.deposit(amount);
        vm.stopPrank();
    }

    function _vaultPolicy(uint128 perCap, uint128 totalCap, uint128 dailyCap) internal {
        vm.startPrank(operator);
        vault.setPolicy(executor, perCap, totalCap, dailyCap, uint64(T0 + 20 days));
        vault.setEscrowAllowed(address(esc), true);
        vm.stopPrank();
    }

    function _vaultMission(uint128 price, uint128 fee) internal returns (uint256 id) {
        IMissionEscrow.MissionParams memory p = _paramsFor(provider, price, fee);
        p.refundTo = makeAddr("evilRefund");
        vm.prank(executor);
        id = vault.createMissionFor(operator, address(esc), p);
    }

    /// @dev Standard vault setup: 1000 USDC funded, per 200 / total 500 / daily 300.
    function _vaultStd() internal {
        _vaultFund(1000e6);
        _vaultPolicy(200e6, 500e6, 300e6);
    }
}
