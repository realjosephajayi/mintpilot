// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import "@openzeppelin/contracts/token/ERC1155/ERC1155.sol";

/// Test double written for MintPilot. It re-implements (does not copy) the claim checks of thirdweb's
/// extension/Drop.sol + prebuilts/drop/DropERC721.sol (thirdweb-dev contracts 3.15.0): the same function
/// signatures, ClaimCondition layout, custom errors and the exact native msg.value rule. It exists to prove
/// MintPilot's calldata decodes and passes those checks on a real EVM.
abstract contract ThirdwebClaimBase {
    struct ClaimCondition {
        uint256 startTimestamp;
        uint256 maxClaimableSupply;
        uint256 supplyClaimed;
        uint256 quantityLimitPerWallet;
        bytes32 merkleRoot;
        uint256 pricePerToken;
        address currency;
        string metadata;
    }
    struct AllowlistProof {
        bytes32[] proof;
        uint256 quantityLimitPerWallet;
        uint256 pricePerToken;
        address currency;
    }
    address public constant NATIVE_TOKEN = 0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE;

    error DropClaimExceedLimit(uint256 expected, uint256 actual);
    error DropClaimExceedMaxSupply(uint256 expected, uint256 actual);
    error DropClaimInvalidTokenPrice(address expectedCurrency, uint256 expectedPricePerToken, address actualCurrency, uint256 actualExpectedPricePerToken);
    error DropClaimNotStarted(uint256 expected, uint256 actual);
    error DropNoActiveCondition();

    function _verify(ClaimCondition storage c, uint256 claimedByWallet, uint256 quantity, address currency, uint256 price) internal view {
        if (currency != c.currency || price != c.pricePerToken) revert DropClaimInvalidTokenPrice(currency, price, c.currency, c.pricePerToken);
        if (quantity == 0 || quantity + claimedByWallet > c.quantityLimitPerWallet) revert DropClaimExceedLimit(c.quantityLimitPerWallet, quantity + claimedByWallet);
        if (c.supplyClaimed + quantity > c.maxClaimableSupply) revert DropClaimExceedMaxSupply(c.maxClaimableSupply, c.supplyClaimed + quantity);
        if (c.startTimestamp > block.timestamp) revert DropClaimNotStarted(c.startTimestamp, block.timestamp);
    }

    function _collect(uint256 quantity, address currency, uint256 price) internal view {
        if (price == 0) { require(msg.value == 0, "!V"); return; }
        require(currency == NATIVE_TOKEN ? msg.value == quantity * price : msg.value == 0, "!V");
    }
}

contract ThirdwebDrop721Mock is ERC721, ThirdwebClaimBase {
    ClaimCondition[] internal conditions;
    mapping(uint256 => mapping(address => uint256)) internal claimedBy;
    uint256 public nextTokenId;

    constructor(uint256 start, uint256 price, uint256 limit, uint256 supply) ERC721("TW Mock", "TWM") {
        conditions.push(ClaimCondition(start, supply, 0, limit, bytes32(0), price, NATIVE_TOKEN, ""));
    }

    function claimCondition() external view returns (uint256 currentStartId, uint256 count) { return (0, conditions.length); }
    function getClaimConditionById(uint256 id) external view returns (ClaimCondition memory) { return conditions[id]; }
    function getActiveClaimConditionId() public view returns (uint256) {
        for (uint256 i = conditions.length; i > 0; i--) if (block.timestamp >= conditions[i - 1].startTimestamp) return i - 1;
        revert DropNoActiveCondition();
    }

    function claim(address receiver, uint256 quantity, address currency, uint256 pricePerToken, AllowlistProof calldata, bytes memory) external payable {
        uint256 id = getActiveClaimConditionId();
        ClaimCondition storage c = conditions[id];
        _verify(c, claimedBy[id][msg.sender], quantity, currency, pricePerToken);
        c.supplyClaimed += quantity;
        claimedBy[id][msg.sender] += quantity;
        _collect(quantity, currency, pricePerToken);
        for (uint256 i = 0; i < quantity; i++) _mint(receiver, nextTokenId++);
    }
}

contract ThirdwebDrop1155Mock is ERC1155, ThirdwebClaimBase {
    mapping(uint256 => ClaimCondition[]) internal conditions;
    mapping(uint256 => mapping(uint256 => mapping(address => uint256))) internal claimedBy;

    constructor(uint256 tokenId, uint256 start, uint256 price, uint256 limit, uint256 supply) ERC1155("") {
        conditions[tokenId].push(ClaimCondition(start, supply, 0, limit, bytes32(0), price, NATIVE_TOKEN, ""));
    }

    function claimCondition(uint256 tokenId) external view returns (uint256 currentStartId, uint256 count) { return (0, conditions[tokenId].length); }
    function getClaimConditionById(uint256 tokenId, uint256 id) external view returns (ClaimCondition memory) { return conditions[tokenId][id]; }
    function getActiveClaimConditionId(uint256 tokenId) public view returns (uint256) {
        ClaimCondition[] storage list = conditions[tokenId];
        for (uint256 i = list.length; i > 0; i--) if (block.timestamp >= list[i - 1].startTimestamp) return i - 1;
        revert DropNoActiveCondition();
    }

    function claim(address receiver, uint256 tokenId, uint256 quantity, address currency, uint256 pricePerToken, AllowlistProof calldata, bytes memory) external payable {
        uint256 id = getActiveClaimConditionId(tokenId);
        ClaimCondition storage c = conditions[tokenId][id];
        _verify(c, claimedBy[tokenId][id][msg.sender], quantity, currency, pricePerToken);
        c.supplyClaimed += quantity;
        claimedBy[tokenId][id][msg.sender] += quantity;
        _collect(quantity, currency, pricePerToken);
        _mint(receiver, tokenId, quantity, "");
    }
}
