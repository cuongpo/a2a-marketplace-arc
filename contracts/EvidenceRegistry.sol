// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {IEvidenceRegistry} from "./interfaces/IEvidenceRegistry.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";

/// @title EvidenceRegistry
/// @notice Non-upgradeable registry of provider-bound device keys and signed readings.
/// @dev A signature proves key possession and consent, not physical truth. Compromised or
///      spoofed sensors can sign false readings. Consumers supply and must trust their own
///      constraints and provider selection. No owner, administrator, or ERC-1271 validation exists.
contract EvidenceRegistry is IEvidenceRegistry, EIP712 {
    bytes32 public constant READING_TYPEHASH = keccak256(
        "Reading(uint256 missionId,bytes32 tileId,uint64 observedAt,int256 value,bytes32 unit,uint256 nonce,bytes32 payloadHash)"
    );
    bytes32 public constant SIGNER_BINDING_TYPEHASH =
        keccak256("SignerBinding(address provider,address signer,bytes32 metadataHash)");
    uint256 public constant FUTURE_SKEW = 60;

    struct SignerRecord {
        address provider;
        bool active;
        bytes32 metadataHash;
    }

    mapping(address signer => SignerRecord) private _signers;
    mapping(address consumer => mapping(address signer => mapping(uint256 nonce => bool))) private _used;

    constructor() EIP712("FieldQuest EvidenceRegistry", "1") {}

    /// @inheritdoc IEvidenceRegistry
    function registerSigner(address signer, bytes32 metadataHash, bytes calldata signerSig) external override {
        if (signer == address(0)) revert BadSignerBinding();
        if (_signers[signer].provider != address(0)) revert SignerAlreadyRegistered();

        bytes32 digest = hashSignerBinding(msg.sender, signer, metadataHash);
        (address recovered, ECDSA.RecoverError err,) = ECDSA.tryRecover(digest, signerSig);
        if (err != ECDSA.RecoverError.NoError || recovered != signer) revert BadSignerBinding();

        _signers[signer] = SignerRecord({provider: msg.sender, active: true, metadataHash: metadataHash});
        emit SignerRegistered(msg.sender, signer, metadataHash);
    }

    /// @inheritdoc IEvidenceRegistry
    function revokeSigner(address signer) external override {
        SignerRecord storage info = _signers[signer];
        if (info.provider != msg.sender) revert NotSignerProvider();
        // Preserve the binding permanently: revocation must never permit key rebinding.
        info.active = false;
        emit SignerRevoked(msg.sender, signer);
    }

    /// @inheritdoc IEvidenceRegistry
    function signerInfo(address signer)
        external
        view
        override
        returns (address provider, bool active, bytes32 metadataHash)
    {
        SignerRecord storage info = _signers[signer];
        return (info.provider, info.active, info.metadataHash);
    }

    /// @inheritdoc IEvidenceRegistry
    function hashReading(Reading calldata r) public view override returns (bytes32 digest) {
        return _hashTypedDataV4(
            keccak256(
                abi.encode(
                    READING_TYPEHASH,
                    r.missionId,
                    r.tileId,
                    r.observedAt,
                    r.value,
                    r.unit,
                    r.nonce,
                    r.payloadHash
                )
            )
        );
    }

    /// @inheritdoc IEvidenceRegistry
    function hashSignerBinding(address provider, address signer, bytes32 metadataHash)
        public
        view
        override
        returns (bytes32 digest)
    {
        return _hashTypedDataV4(keccak256(abi.encode(SIGNER_BINDING_TYPEHASH, provider, signer, metadataHash)));
    }

    /// @inheritdoc IEvidenceRegistry
    function consumeReading(address provider, Constraints calldata c, Reading calldata r, bytes calldata sig)
        external
        override
        returns (bytes32 digest, address signer)
    {
        (digest, signer) = _checkReading(msg.sender, provider, c, r, sig);
        _used[msg.sender][signer][r.nonce] = true;
        emit ReadingConsumed(msg.sender, signer, r.missionId, r.tileId, r.nonce, digest);
    }

    /// @inheritdoc IEvidenceRegistry
    function previewReading(
        address consumer,
        address provider,
        Constraints calldata c,
        Reading calldata r,
        bytes calldata sig
    ) external view override returns (bytes32 digest, address signer) {
        return _checkReading(consumer, provider, c, r, sig);
    }

    /// @inheritdoc IEvidenceRegistry
    function nonceUsed(address consumer, address signer, uint256 nonce) external view override returns (bool) {
        return _used[consumer][signer][nonce];
    }

    /// @inheritdoc IEvidenceRegistry
    function DOMAIN_SEPARATOR() external view override returns (bytes32) {
        return _domainSeparatorV4();
    }

    /// @dev Preview and consumption share all checks; timestamps need not increase between readings.
    function _checkReading(
        address consumer,
        address provider,
        Constraints calldata c,
        Reading calldata r,
        bytes calldata sig
    ) internal view returns (bytes32 digest, address signer) {
        digest = hashReading(r);
        ECDSA.RecoverError err;
        (signer, err,) = ECDSA.tryRecover(digest, sig);
        if (err != ECDSA.RecoverError.NoError) revert BadReadingSignature();

        SignerRecord storage info = _signers[signer];
        if (!info.active) revert SignerNotActive();
        if (info.provider != provider) revert SignerBoundToOtherProvider();
        if (r.missionId != c.missionId) revert WrongMission();
        if (r.tileId != c.tileId) revert WrongTile();
        if (r.unit != c.unit) revert WrongUnit();
        if (r.observedAt < c.notBefore) revert ReadingBeforeMission();

        uint256 observedAt = uint256(r.observedAt);
        // Equivalent to observedAt > block.timestamp + FUTURE_SKEW without addition overflow.
        if (observedAt > block.timestamp && observedAt - block.timestamp > FUTURE_SKEW) {
            revert ReadingFromFuture();
        }
        // Widen before adding: uint64 + uint32 always fits uint256, including boundary inputs.
        if (block.timestamp > observedAt + uint256(c.maxAge)) revert ReadingTooOld();
        if (_used[consumer][signer][r.nonce]) revert NonceAlreadyUsed();
    }
}
