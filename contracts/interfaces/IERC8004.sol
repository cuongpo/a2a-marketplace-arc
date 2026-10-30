// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @dev Minimal ERC-8004 (Draft) registry surfaces used by FieldQuest. Arc registries:
///      Testnet Identity 0x8004A818BFB912233c491871b3d84c89A494BD9e, Reputation 0x8004B663056A597Dffe9eCcC1965A193B7388713.
interface IIdentityRegistry8004 {
    function ownerOf(uint256 agentId) external view returns (address);
    function tokenURI(uint256 agentId) external view returns (string memory);
    function getAgentWallet(uint256 agentId) external view returns (address);
}

interface IReputationRegistry8004 {
    function giveFeedback(
        uint256 agentId,
        int128 value,
        uint8 valueDecimals,
        string calldata tag1,
        string calldata tag2,
        string calldata endpoint,
        string calldata feedbackURI,
        bytes32 feedbackHash
    ) external;
}
