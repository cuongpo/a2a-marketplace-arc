// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @title IEvidenceRegistry
/// @notice Sensor-signer registry plus EIP-712 reading validation for FieldQuest.
/// @dev Trust limit: a valid signature proves that the holder of a registered device key signed
///      a reading. It does NOT prove the physical world matched the reading (a compromised or
///      spoofed sensor still signs). See docs/THREAT_MODEL.md.
interface IEvidenceRegistry {
    /// @dev EIP-712 type string:
    ///      Reading(uint256 missionId,bytes32 tileId,uint64 observedAt,int256 value,bytes32 unit,uint256 nonce,bytes32 payloadHash)
    struct Reading {
        uint256 missionId;
        bytes32 tileId;
        uint64 observedAt; // unix seconds, device clock
        int256 value; // fixed point; scale is part of the mission objective (documented off-chain)
        bytes32 unit; // keccak256 of the unit label, e.g. keccak256("mm")
        uint256 nonce; // device-scoped, unique per (consumer, signer)
        bytes32 payloadHash; // hash of the raw device payload kept off-chain
    }

    /// @dev What the consumer (escrow) requires of a reading.
    struct Constraints {
        uint256 missionId;
        bytes32 tileId;
        bytes32 unit;
        uint64 notBefore; // reading must be observed at or after this time
        uint32 maxAge; // seconds; block.timestamp - observedAt must be <= maxAge
    }

    event SignerRegistered(address indexed provider, address indexed signer, bytes32 metadataHash);
    event SignerRevoked(address indexed provider, address indexed signer);
    event ReadingConsumed(
        address indexed consumer,
        address indexed signer,
        uint256 indexed missionId,
        bytes32 tileId,
        uint256 nonce,
        bytes32 digest
    );

    error SignerAlreadyRegistered();
    error NotSignerProvider();
    error BadSignerBinding();
    error SignerNotActive();
    error SignerBoundToOtherProvider();
    error WrongMission();
    error WrongTile();
    error WrongUnit();
    error ReadingTooOld();
    error ReadingBeforeMission();
    error ReadingFromFuture();
    error NonceAlreadyUsed();
    error BadReadingSignature();

    /// @notice Bind a device key to msg.sender (the provider). `signerSig` is the device's EIP-712
    ///         signature over SignerBinding(address provider,address signer,bytes32 metadataHash),
    ///         proving the device key holder consented. Reverts if the signer was ever registered.
    function registerSigner(address signer, bytes32 metadataHash, bytes calldata signerSig) external;

    /// @notice Revoke a signer. Only the provider the signer is bound to.
    function revokeSigner(address signer) external;

    function signerInfo(address signer) external view returns (address provider, bool active, bytes32 metadataHash);

    function hashReading(Reading calldata r) external view returns (bytes32 digest);

    function hashSignerBinding(address provider, address signer, bytes32 metadataHash)
        external
        view
        returns (bytes32 digest);

    /// @notice Validate a signed reading and consume its nonce in the namespace of msg.sender.
    ///         Anyone may call it, but the nonce namespace is msg.sender, so nobody can burn the
    ///         nonces another consumer (e.g. the escrow) relies on.
    /// @return digest EIP-712 digest of the reading (used as the on-chain reading commitment)
    /// @return signer recovered device key
    function consumeReading(address provider, Constraints calldata c, Reading calldata r, bytes calldata sig)
        external
        returns (bytes32 digest, address signer);

    /// @notice Same checks as consumeReading but does not consume the nonce.
    function previewReading(address consumer, address provider, Constraints calldata c, Reading calldata r, bytes calldata sig)
        external
        view
        returns (bytes32 digest, address signer);

    function nonceUsed(address consumer, address signer, uint256 nonce) external view returns (bool);

    function DOMAIN_SEPARATOR() external view returns (bytes32);
}
