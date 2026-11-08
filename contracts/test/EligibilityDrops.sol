// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

contract MerkleDrop {
    bytes32 public immutable root;
    uint256 public immutable price;
    mapping(address => uint256) public minted;

    constructor(bytes32 root_, uint256 price_) { root = root_; price = price_; }

    function mint(uint256 quantity, bytes32[] calldata proof) external payable {
        require(quantity > 0 && msg.value == price * quantity, "payment");
        bytes32 node = keccak256(abi.encodePacked(msg.sender));
        for (uint256 i = 0; i < proof.length; i++) {
            node = node < proof[i] ? keccak256(abi.encodePacked(node, proof[i])) : keccak256(abi.encodePacked(proof[i], node));
        }
        require(node == root, "proof");
        minted[msg.sender] += quantity;
    }
}

contract SignatureDrop {
    bytes32 private constant TYPEHASH = keccak256("Mint(address to,uint256 quantity,uint256 maxQuantity,uint256 nonce,uint256 deadline)");
    bytes32 private immutable DOMAIN_SEPARATOR;
    address public immutable signer;
    uint256 public immutable price;
    mapping(uint256 => bool) public usedNonce;
    mapping(address => uint256) public minted;

    constructor(address signer_, uint256 price_) {
        signer = signer_;
        price = price_;
        DOMAIN_SEPARATOR = keccak256(abi.encode(
            keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
            keccak256(bytes("MintPilot Test Drop")), keccak256(bytes("1")), block.chainid, address(this)
        ));
    }

    function mint(address to, uint256 quantity, uint256 maxQuantity, uint256 nonce, uint256 deadline, bytes calldata signature) external payable {
        require(to != address(0) && quantity > 0 && quantity <= maxQuantity && msg.value == price * quantity, "params");
        require(block.timestamp <= deadline && !usedNonce[nonce], "expired-or-used");
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", DOMAIN_SEPARATOR, keccak256(abi.encode(TYPEHASH, to, quantity, maxQuantity, nonce, deadline))));
        require(_recover(digest, signature) == signer, "signature");
        usedNonce[nonce] = true;
        minted[to] += quantity;
    }

    function _recover(bytes32 digest, bytes calldata sig) private pure returns (address) {
        require(sig.length == 65, "signature-length");
        bytes32 r; bytes32 s; uint8 v;
        assembly { r := calldataload(sig.offset) s := calldataload(add(sig.offset, 32)) v := byte(0, calldataload(add(sig.offset, 64))) }
        if (v < 27) v += 27;
        return ecrecover(digest, v, r, s);
    }
}
