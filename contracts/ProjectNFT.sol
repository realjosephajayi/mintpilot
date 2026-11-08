// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC721} from "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/**
 * DEMO drop contract for exercising the bot end-to-end (scheduled start, price, per-wallet cap).
 * Supports the bot's `mint(uint256)` and `mint(address,uint256)` presets.
 * Not audited — review before any real deployment.
 */
contract ProjectNFT is ERC721, Ownable2Step, ReentrancyGuard {
    uint256 public immutable maxSupply;
    uint256 public immutable mintPrice;
    uint256 public immutable maxPerWallet;
    uint256 public startTime;
    uint256 public totalMinted;
    string private _baseTokenURI;
    mapping(address => uint256) public mintedBy;

    event StartTimeUpdated(uint256 startTime);
    event BaseURIUpdated(string baseURI);

    error NotStarted();
    error SoldOut();
    error IncorrectPayment();
    error WalletLimit();
    error ZeroQuantity();
    error ZeroAddress();
    error WithdrawFailed();

    constructor(
        address initialOwner,
        uint256 supply,
        uint256 priceWei,
        uint256 maxPerWallet_,
        uint256 startTime_,
        string memory baseURI_
    ) ERC721("MintPilot Demo", "MPD") Ownable(initialOwner) {
        require(supply > 0 && maxPerWallet_ > 0, "bad params");
        maxSupply = supply;
        mintPrice = priceWei;
        maxPerWallet = maxPerWallet_;
        startTime = startTime_;
        _baseTokenURI = baseURI_;
    }

    /// Mint `quantity` to the caller.
    function mint(uint256 quantity) external payable {
        _mintMany(msg.sender, quantity);
    }

    /// Mint `quantity` to `to` (still counted against the caller's per-wallet cap).
    function mint(address to, uint256 quantity) external payable {
        if (to == address(0)) revert ZeroAddress();
        _mintMany(to, quantity);
    }

    function _mintMany(address to, uint256 quantity) private nonReentrant {
        if (block.timestamp < startTime) revert NotStarted();
        if (quantity == 0) revert ZeroQuantity();
        if (totalMinted + quantity > maxSupply) revert SoldOut();
        if (mintedBy[msg.sender] + quantity > maxPerWallet) revert WalletLimit();
        if (msg.value != mintPrice * quantity) revert IncorrectPayment();

        mintedBy[msg.sender] += quantity;
        uint256 id = totalMinted;
        totalMinted += quantity;
        for (uint256 i = 0; i < quantity; i++) {
            _safeMint(to, ++id);
        }
    }

    function setStartTime(uint256 t) external onlyOwner { startTime = t; emit StartTimeUpdated(t); }
    function setBaseURI(string calldata uri) external onlyOwner { _baseTokenURI = uri; emit BaseURIUpdated(uri); }

    function withdraw(address payable to) external onlyOwner {
        if (to == address(0)) revert ZeroAddress();
        (bool ok, ) = to.call{value: address(this).balance}("");
        if (!ok) revert WithdrawFailed();
    }

    function _baseURI() internal view override returns (string memory) { return _baseTokenURI; }
}
