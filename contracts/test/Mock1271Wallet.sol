// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";

/// TEST ONLY: minimal ERC-1271 smart wallet used to test signature verification of contract wallets.
contract Mock1271Wallet {
    address public immutable signer;
    constructor(address signer_) { signer = signer_; }

    function isValidSignature(bytes32 hash, bytes calldata signature) external view returns (bytes4) {
        (address rec, , ) = ECDSA.tryRecover(hash, signature);
        return rec == signer ? bytes4(0x1626ba7e) : bytes4(0xffffffff);
    }
}
