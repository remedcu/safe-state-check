// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity ^0.8.19;

// Called by `setup` through its `to` and `data` (a delegatecall), so it writes the Safe's storage without the events
// the Safe itself would emit.
contract ShadowWriter {
    function writeOwner(address x) external {
        write(keccak256(abi.encode(x, uint256(2))), 1);
    }

    function writeModule(address x) external {
        write(keccak256(abi.encode(x, uint256(1))), 1);
    }

    function writeGuard(address guard) external {
        write(keccak256("guard_manager.guard.address"), uint256(uint160(guard)));
    }

    function write(bytes32 slot, uint256 value) private {
        assembly {
            sstore(slot, value)
        }
    }
}

// A fallback handler no registry knows: it calls every signature valid (EIP-1271).
contract AnyHandler {
    function isValidSignature(bytes32, bytes calldata) external pure returns (bytes4) {
        return 0x1626ba7e;
    }
}

// Code an owner EOA delegates to with EIP-7702.
contract Delegate {
    function ping() external pure returns (bool) {
        return true;
    }
}
