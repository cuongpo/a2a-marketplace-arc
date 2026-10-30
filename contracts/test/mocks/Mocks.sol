// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @dev 6-decimals USDC mock with a toggleable blocklist (revert on transfer to/from blocked).
contract MockUSDC is ERC20 {
    error Blocked(address account);

    mapping(address => bool) public blocked;

    constructor() ERC20("Mock USDC", "mUSDC") {}

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function setBlocked(address account, bool b) external {
        blocked[account] = b;
    }

    function _update(address from, address to, uint256 value) internal virtual override {
        if (blocked[from]) revert Blocked(from);
        if (blocked[to]) revert Blocked(to);
        super._update(from, to, value);
    }
}

/// @dev Fee-on-transfer variant: burns 1% of every transfer (recipient receives 99%).
contract FeeOnTransferUSDC is ERC20 {
    constructor() ERC20("Fee USDC", "fUSDC") {}

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function _update(address from, address to, uint256 value) internal override {
        if (from != address(0) && to != address(0)) {
            uint256 fee = value / 100;
            super._update(from, address(0), fee);
            value -= fee;
        }
        super._update(from, to, value);
    }
}

interface ITransferHook {
    function onTransfer(address from, address to, uint256 value) external;
}

/// @dev Token that calls a hook (ERC777-style) on every transfer while armed. The hook target is the attacker.
contract ReentrantToken is ERC20 {
    address public hook;

    constructor() ERC20("Reentrant USDC", "rUSDC") {}

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function setHook(address h) external {
        hook = h;
    }

    function _update(address from, address to, uint256 value) internal override {
        super._update(from, to, value);
        if (hook != address(0) && from != address(0)) {
            ITransferHook(hook).onTransfer(from, to, value);
        }
    }
}

/// @dev Attacker: acts as a normal account via exec(); when armed, its hook re-enters `target` with `data` once.
contract ReentrantAttacker is ITransferHook {
    address public target;
    bytes public data;
    bool public armed;
    bool public fired;
    bool public reentrySucceeded;
    bytes public reentryRevertData;

    function exec(address t, bytes calldata d) external returns (bytes memory ret) {
        bool ok;
        (ok, ret) = t.call(d);
        if (!ok) {
            assembly {
                revert(add(ret, 32), mload(ret))
            }
        }
    }

    function arm(address t, bytes calldata d) external {
        target = t;
        data = d;
        armed = true;
        fired = false;
        reentrySucceeded = false;
    }

    function onTransfer(address, address, uint256) external override {
        if (!armed) return;
        armed = false;
        fired = true;
        (bool ok, bytes memory ret) = target.call(data);
        reentrySucceeded = ok;
        reentryRevertData = ret;
    }
}

/// @dev ERC-8004 identity registry mock. ownerOf reverts for unminted ids (like ERC-721).
contract MockIdentityRegistry {
    mapping(uint256 => address) public owners;
    mapping(uint256 => bool) public minted;

    function setOwner(uint256 agentId, address o) external {
        owners[agentId] = o;
        minted[agentId] = true;
    }

    function ownerOf(uint256 agentId) external view returns (address) {
        require(minted[agentId], "ERC721: invalid token ID");
        return owners[agentId];
    }

    function tokenURI(uint256) external pure returns (string memory) {
        return "";
    }

    function getAgentWallet(uint256 agentId) external view returns (address) {
        return owners[agentId];
    }
}

/// @dev ERC-8004 reputation registry mock, recording calls; failing toggle makes giveFeedback revert.
contract MockReputationRegistry {
    struct Call {
        uint256 agentId;
        int128 value;
        string tag1;
        string tag2;
        bytes32 feedbackHash;
    }

    bool public failing;
    Call[] internal _calls;

    function setFailing(bool f) external {
        failing = f;
    }

    function callCount() external view returns (uint256) {
        return _calls.length;
    }

    function callAt(uint256 i) external view returns (Call memory) {
        return _calls[i];
    }

    function giveFeedback(
        uint256 agentId,
        int128 value,
        uint8,
        string calldata tag1,
        string calldata tag2,
        string calldata,
        string calldata,
        bytes32 feedbackHash
    ) external {
        require(!failing, "reputation down");
        _calls.push(Call(agentId, value, tag1, tag2, feedbackHash));
    }
}

/// @dev Always-reverting reputation registry.
contract RevertingReputationRegistry {
    function giveFeedback(uint256, int128, uint8, string calldata, string calldata, string calldata, string calldata, bytes32)
        external
        pure
    {
        revert("always down");
    }
}
